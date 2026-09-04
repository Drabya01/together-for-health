// ============================================================================
//  Together For Health — Firestore sync layer
// ============================================================================
//  Replaces the GitHub-Gist sync that came before it. That design required a
//  GitHub write token in the browser, which meant:
//    · only the owner's device could publish, so approvals sat unpublished
//    · the whole club database was readable by anyone, unauthenticated
//    · every device that wrote held a credential able to delete everything
//    · "approved" was a flag in a blob the client owned, so it was advisory
//
//  Here the trust boundary is on the server. The config below is PUBLIC by
//  design — a Firebase apiKey identifies the project, it does not authorise
//  anything. Access is decided by firestore.rules, which the client cannot
//  edit. Nobody ever pastes a token again.
//
//  Data layout
//    users/{uid}   one document per person. A signed-in user may read and
//                  update ONLY their own, and may never change their own
//                  status/tier/role — so self-approval is impossible.
//                  Officers and admins may list and update all of them.
//    club/state    the shared club document. Readable and writable only by
//                  approved members.
//
//  This file deliberately overrides the old gist functions rather than
//  deleting their call sites: saveState(), syncFromGist(), pushToGist() and
//  friends keep their names and contracts, so the ~40 places that call them
//  are untouched. Loaded last, after index.html's inline script.
// ============================================================================

(function () {
  'use strict';

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyCLs9myBem9HNdtIrIkOUzcwTaom5tTYss",
    authDomain: "together-for-health-4bc07.firebaseapp.com",
    projectId: "together-for-health-4bc07",
    storageBucket: "together-for-health-4bc07.firebasestorage.app",
    messagingSenderId: "552108386821",
    appId: "1:552108386821:web:2d058bb5fb79a581a6ca6c"
  };

  // Bootstrap owner. Mirrors the check in firestore.rules; unlike the old
  // client-side wildcard this one is ALSO enforced server-side, so editing it
  // here grants nothing on its own.
  var OWNER_EMAILS = ['golussaud@gmail.com'];

  if (typeof firebase === 'undefined' || !firebase.initializeApp) {
    console.error('[tfh] Firebase SDK missing — sync disabled.');
    return;
  }

  firebase.initializeApp(FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // Real offline support: reads and writes queue on disk and replay on
  // reconnect. The old service worker faked this by caching API responses,
  // which silently served a stale roster.
  db.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
    console.warn('[tfh] offline persistence unavailable:', e && e.code);
  });

  var USERS = 'users';
  var CLUB_DOC = db.collection('club').doc('state');

  var _userUnsub = null, _clubUnsub = null, _rosterUnsub = null;
  var _writeTimer = null, _pendingWrite = false, _applyingRemote = false;

  window.TFH_FIREBASE = true;

  // ── helpers ───────────────────────────────────────────────────────────────

  function _isOwnerEmail(e) {
    return OWNER_EMAILS.indexOf(String(e || '').toLowerCase()) !== -1;
  }

  // A persistent, readable banner on the sign-in screen. Without this, a setup step that
  // has not been done yet (rules not published, provider not enabled) surfaces only as a
  // toast that fades, leaving a blank screen and no idea what to fix.
  function _fatal(msg) {
    var host = document.getElementById('auth-overlay');
    if (!host || host.style.display === 'none') return;
    var el = document.getElementById('tfh-fb-fatal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tfh-fb-fatal';
      el.style.cssText = 'max-width:420px;margin:16px auto 0;padding:12px 14px;border-radius:10px;' +
        'background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;font-size:13px;line-height:1.6;text-align:left;';
      host.appendChild(el);
    }
    el.textContent = msg;
  }

  function _hasStaffTier(u) {
    return !!u && (u.permissionTier === 'admin' || u.permissionTier === 'officer');
  }

  function _normalizeState() {
    ['events', 'plans', 'ideas', 'presentations', 'meetings', 'members', 'feedback', 'posts',
     'announcements', 'goals', 'contacts', 'resources', 'transactions', 'activities',
     'emailTemplates', 'teachers', 'consents', 'partnerships', 'fundraisers', 'grants',
     'eventBudgets'].forEach(function (k) { if (!Array.isArray(state[k])) state[k] = []; });
    if (!state.checks || typeof state.checks !== 'object') state.checks = {};
    if (!Array.isArray(state.users)) state.users = [];
    state.meetings.forEach(function (m) {
      if (!m.attendance) m.attendance = {};
      if (!m.actionItems) m.actionItems = [];
    });
  }

  function _rerenderActiveTab() {
    try {
      var btn = document.querySelector('.nav-item--active');
      var tab = btn && btn.dataset ? btn.dataset.tab : 'dashboard';
      if (typeof switchTab === 'function' && window.currentUser) switchTab(tab || 'dashboard');
    } catch (e) {}
  }

  // The club document, minus anything that lives elsewhere or is gist-era cruft.
  function _clubPayload() {
    var out = {};
    Object.keys(state).forEach(function (k) {
      if (k === 'users' || k === '_syncTs' || k === '_syncVersion' || k === '_sitePin') return;
      out[k] = state[k];
    });
    return out;
  }

  // ── writing ───────────────────────────────────────────────────────────────

  function _flushClubWrite() {
    if (!auth.currentUser) { _pendingWrite = false; return Promise.resolve(false); }
    _pendingWrite = false;
    return CLUB_DOC.set({
      data: _clubPayload(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: auth.currentUser.email || auth.currentUser.uid
    }, { merge: false }).then(function () {
      _syncDot('synced');
      return true;
    }).catch(function (err) {
      console.warn('[tfh] club write failed:', err && err.code);
      _syncDot('error');
      if (err && err.code === 'permission-denied' && typeof showToast === 'function') {
        showToast('You do not have permission to change club data.', 'error');
      }
      return false;
    });
  }

  function _syncDot(status) {
    if (typeof updateSyncIndicator === 'function') updateSyncIndicator(status);
  }

  // ── overrides: the old gist API, reimplemented on Firestore ───────────────

  // Existing code gates several read/write paths on "is a token present".
  // With Firestore, being signed in IS the credential.
  window.getSyncToken = function () { return auth.currentUser ? 'firebase' : ''; };
  window.getSyncGistId = function () { return FIREBASE_CONFIG.projectId; };

  window.pushToGist = function () {
    if (_applyingRemote) return Promise.resolve(true);
    _syncDot('syncing');
    return _flushClubWrite();
  };

  // Firestore pushes changes to us over a live listener, so an explicit pull is
  // only ever a formality. Kept so existing callers still resolve sensibly.
  window.syncFromGist = function () {
    if (!auth.currentUser) { _syncDot('offline'); return Promise.resolve(false); }
    _syncDot('syncing');
    return CLUB_DOC.get().then(function (snap) {
      if (snap.exists) _applyClubSnapshot(snap, true);
      _syncDot('synced');
      return 'current';
    }).catch(function () { _syncDot('error'); return false; });
  };

  window.saveState = function () {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    if (_applyingRemote) return;            // don't echo a remote change back
    _pendingWrite = true;
    _syncDot('syncing');
    clearTimeout(_writeTimer);
    _writeTimer = setTimeout(_flushClubWrite, 700);
  };

  // Nothing to connect and nothing to publish any more.
  window.publishThisDevice = function () {
    if (typeof showToast === 'function') showToast('Everything saves automatically now.', 'info');
  };
  window.forceSyncNow = function () {
    window.syncFromGist().then(function () {
      if (typeof showToast === 'function') showToast('Up to date.', 'success');
    });
  };
  window.generateSyncSetupUrl = function () {
    if (typeof showToast === 'function') showToast('No setup link needed — members just sign in with Google.', 'info');
  };
  window.clearSyncToken = function () { window.signOut(); };

  window.checkApprovalStatus = function () {
    if (typeof showToast === 'function') showToast('Checking…', 'info');
    _refreshOwnUserDoc();
  };

  // ── applying remote data ──────────────────────────────────────────────────

  function _applyClubSnapshot(snap, force) {
    if (!snap.exists) return;
    // Skip our own un-acknowledged writes; otherwise every local edit would
    // bounce back through here and re-render mid-typing.
    if (!force && snap.metadata && snap.metadata.hasPendingWrites) return;
    var d = (snap.data() || {}).data || {};
    _applyingRemote = true;
    try {
      var users = state.users;
      Object.keys(d).forEach(function (k) { state[k] = d[k]; });
      state.users = users;
      _normalizeState();
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
      if (typeof initRoles === 'function') initRoles();
    } finally {
      _applyingRemote = false;
    }
  }

  function _applyRoster(docs) {
    _applyingRemote = true;
    try {
      state.users = docs;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    } finally { _applyingRemote = false; }
  }

  // ── sign-in ───────────────────────────────────────────────────────────────

  window.initGoogleAuth = function () {
    var btn = document.getElementById('google-signin-btn');
    if (btn && !btn.dataset.fbBound) {
      btn.dataset.fbBound = '1';
      btn.innerHTML = '';
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Sign in with Google');
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;width:280px;' +
        'min-height:44px;padding:11px 16px;border:1px solid var(--border-strong,#8f8d88);border-radius:8px;' +
        'background:var(--surface,#fff);color:var(--text,#1a1a1a);font-size:15px;font-weight:500;' +
        'font-family:inherit;cursor:pointer;';
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">' +
        '<path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"/>' +
        '<path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.2-3.8H.8v2.3A9 9 0 0 0 9 18z"/>' +
        '<path fill="#FBBC05" d="M3.8 10.7a5.4 5.4 0 0 1 0-3.4V5H.8a9 9 0 0 0 0 8l3-2.3z"/>' +
        '<path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .8 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/></svg>' +
        '<span>Sign in with Google</span>';
      b.onclick = function () { _startGoogleSignIn(b); };
      btn.appendChild(b);
    }
    _syncDot(auth.currentUser ? 'synced' : 'offline');
  };

  function _startGoogleSignIn(btnEl) {
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    if (btnEl) { btnEl.disabled = true; btnEl.style.opacity = '0.6'; }
    var reset = function () { if (btnEl) { btnEl.disabled = false; btnEl.style.opacity = '1'; } };
    auth.signInWithPopup(provider).then(reset).catch(function (err) {
      reset();
      var code = err && err.code ? err.code : '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      // Name the specific misconfiguration rather than a generic failure — these are the
      // three that lock the owner out of their own app during first-time setup.
      var msg = {
        'auth/unauthorized-domain': 'This domain is not authorised yet. In Firebase: Authentication → Settings → Authorized domains → add "' + location.hostname + '".',
        'auth/operation-not-allowed': 'Google sign-in is not switched on yet. In Firebase: Authentication → Sign-in method → Google → Enable.',
        'auth/popup-blocked': 'Your browser blocked the sign-in popup — allow popups for this site and try again.',
        'auth/network-request-failed': 'No connection to Firebase — check your internet and try again.'
      }[code];
      if (typeof showToast === 'function') showToast(msg || ('Sign-in failed: ' + (code || 'unknown error')), 'error');
      _fatal(msg || ('Sign-in failed: ' + code));
      console.error('[tfh] sign-in error', err);
    });
  }

  window.signOut = function () {
    if (_userUnsub) { _userUnsub(); _userUnsub = null; }
    if (_clubUnsub) { _clubUnsub(); _clubUnsub = null; }
    if (_rosterUnsub) { _rosterUnsub(); _rosterUnsub = null; }
    auth.signOut().catch(function () {}).then(function () {
      try {
        localStorage.removeItem('tfh_google_session');
        sessionStorage.removeItem('tfh_pin_access');
      } catch (e) {}
      var done = function () { location.reload(); };
      if (window.caches && caches.keys) {
        caches.keys().then(function (ks) {
          return Promise.all(ks.map(function (k) { return caches.delete(k); }));
        }).then(done, done);
      } else done();
    });
  };

  // ── the approval flow ─────────────────────────────────────────────────────
  //
  //  A pending member holds a live listener on their OWN user document. The
  //  moment an admin flips status to 'approved', this fires and the app opens.
  //  No polling, no "Check again", no tokens, and nothing for the member to do.

  function _watchOwnUser(uid, fbUser) {
    if (_userUnsub) _userUnsub();
    _userUnsub = db.collection(USERS).doc(uid).onSnapshot(function (snap) {
      if (!snap.exists) { _createOwnUserDoc(uid, fbUser); return; }
      var u = snap.data() || {};
      u.id = uid; u.uid = uid;
      if (!u.googleId) u.googleId = uid;

      // keep state.users coherent for members (who can only see themselves)
      if (!_hasStaffTier(u)) _applyRoster([u]);

      window.currentUser = u;
      if (u.status === 'approved') {
        _onApproved(u);
      } else if (u.status === 'rejected' || u.status === 'pending') {
        if (typeof showPendingScreen === 'function') showPendingScreen();
      }
    }, function (err) {
      console.warn('[tfh] user listener error:', err && err.code);
      // permission-denied here almost always means firestore.rules has not been published
      // yet, so the default production ruleset is denying everything. Say so plainly instead
      // of leaving the owner on a blank sign-in screen.
      if (err && err.code === 'permission-denied') {
        var m = 'The database is refusing reads. Publish the security rules: Firebase console → Firestore Database → Rules → paste firestore.rules → Publish.';
        _fatal(m);
        if (typeof showToast === 'function') showToast(m, 'error');
      }
    });
  }

  function _createOwnUserDoc(uid, fbUser) {
    var email = (fbUser.email || '').toLowerCase();
    var owner = _isOwnerEmail(email);
    // A brand-new person goes through onboarding to collect grade/role/bio.
    // The owner is bootstrapped straight to president.
    if (!owner) {
      if (typeof showMemberOnboard === 'function') {
        showMemberOnboard(uid, fbUser.email || '', fbUser.displayName || fbUser.email || '', fbUser.photoURL || '');
      }
      return;
    }
    db.collection(USERS).doc(uid).set({
      email: fbUser.email || '', name: fbUser.displayName || 'Owner', photo: fbUser.photoURL || '',
      grade: '', roleInterest: '', bio: '',
      role: 'President', permissionTier: 'admin', roleId: 'role_president',
      status: 'approved', joinedAt: Date.now()
    }).catch(function (e) { console.error('[tfh] owner bootstrap failed', e); });
  }

  // Members submitting their profile — writes their own pending document.
  // Rules forbid setting status to anything but 'pending' here.
  window.submitMemberOnboard = function () {
    var overlay = document.getElementById('member-onboard-overlay');
    var fbUser = auth.currentUser;
    if (!fbUser) { if (typeof showToast === 'function') showToast('Please sign in again.', 'error'); return; }
    var name = (document.getElementById('mob-name').value || '').trim();
    if (!name) { if (typeof showToast === 'function') showToast('Please enter your name.', 'error'); return; }
    var grade = (document.getElementById('mob-grade') || {}).value || '';
    var roleInterest = (document.getElementById('mob-role') || {}).value || '';
    var bio = ((document.getElementById('mob-bio') || {}).value || '').trim();
    var btn = overlay ? overlay.querySelector('button[onclick*="submitMemberOnboard"]') : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
    db.collection(USERS).doc(fbUser.uid).set({
      email: fbUser.email || '', name: name, photo: fbUser.photoURL || '',
      grade: grade, roleInterest: roleInterest, bio: bio,
      role: '', permissionTier: 'member', roleId: 'role_member',
      status: 'pending', joinedAt: Date.now()
    }).then(function () {
      if (overlay) overlay.style.display = 'none';
      if (typeof showPendingScreen === 'function') showPendingScreen();
      if (typeof sendApprovalEmail === 'function') {
        try { sendApprovalEmail({ id: fbUser.uid, name: name, email: fbUser.email, grade: grade, roleInterest: roleInterest, bio: bio }); } catch (e) {}
      }
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit request'; }
      if (typeof showToast === 'function') showToast('Could not submit: ' + (err.code || 'error'), 'error');
    });
  };

  function _refreshOwnUserDoc() {
    var u = auth.currentUser;
    if (!u) return;
    db.collection(USERS).doc(u.uid).get({ source: 'server' }).then(function (snap) {
      if (snap.exists && (snap.data() || {}).status === 'approved') {
        var d = snap.data(); d.id = u.uid; d.uid = u.uid; d.googleId = d.googleId || u.uid;
        window.currentUser = d;
        _onApproved(d);
      } else if (typeof showToast === 'function') {
        showToast('Not approved yet — an admin still needs to review your request.', 'info');
      }
    }).catch(function () {
      if (typeof showToast === 'function') showToast('Could not reach the club database.', 'error');
    });
  }

  var _appShown = false;
  function _onApproved(u) {
    // Approved members read the club document; officers/admins also get the
    // full roster so the Members tab and approvals panel work.
    if (!_clubUnsub) {
      _clubUnsub = CLUB_DOC.onSnapshot(function (snap) {
        var first = !_appShown;
        _applyClubSnapshot(snap);
        if (first) { _showAppOnce(); }
        else if (!snap.metadata.hasPendingWrites) { _rerenderActiveTab(); }
      }, function (err) {
        console.warn('[tfh] club listener error:', err && err.code);
        _showAppOnce();
      });
    }
    if (_hasStaffTier(u) && !_rosterUnsub) {
      _rosterUnsub = db.collection(USERS).onSnapshot(function (qs) {
        var docs = [];
        qs.forEach(function (d) {
          var v = d.data() || {}; v.id = d.id; v.uid = d.id;
          if (!v.googleId) v.googleId = d.id;
          docs.push(v);
        });
        _applyRoster(docs);
        var btn = document.querySelector('.nav-item--active');
        var tab = btn && btn.dataset ? btn.dataset.tab : '';
        if (tab === 'members' && typeof renderMembers === 'function') renderMembers();
        if (typeof updateTabBadges === 'function') { try { updateTabBadges(); } catch (e) {} }
      }, function (err) { console.warn('[tfh] roster listener error:', err && err.code); });
    }
    _showAppOnce();
  }

  function _showAppOnce() {
    if (_appShown) return;
    _appShown = true;
    _normalizeState();
    if (typeof initRoles === 'function') initRoles();
    if (typeof showApp === 'function') showApp();
    _syncDot('synced');
  }

  // ── admin actions write straight to Firestore ─────────────────────────────

  window.approveUser = function (userId, tier, roleName) {
    var patch = {
      status: 'approved',
      permissionTier: tier || 'member',
      roleId: tier === 'admin' ? 'role_president' : 'role_member'
    };
    var existing = (state.users || []).find(function (u) { return u.id === userId; });
    if (existing && existing.roleId) patch.roleId = existing.roleId;
    if (roleName) patch.role = roleName;
    var who = existing ? (existing.name || existing.email) : 'Member';
    if (typeof showToast === 'function') showToast('Approving ' + who + '…', 'info');
    return db.collection(USERS).doc(userId).update(patch).then(function () {
      if (typeof showToast === 'function') showToast(who + ' is in — their app will open on its own.', 'success');
      // Mirror onto the club roster so the Members tab shows them.
      if (existing) {
        if (!Array.isArray(state.members)) state.members = [];
        var lc = (existing.email || '').toLowerCase();
        var already = state.members.find(function (m) {
          return (m.email || '').toLowerCase() === lc || (m.googleId && m.googleId === userId);
        });
        if (!already && existing.name) {
          state.members.push({
            id: (typeof uid === 'function' ? uid() : 'm' + Date.now()),
            name: existing.name, role: roleName || existing.roleInterest || 'Member',
            email: existing.email, grade: existing.grade || '', active: true,
            googleId: userId, photo: existing.photo || ''
          });
          window.saveState();
        }
      }
      if (typeof sendApprovedEmail === 'function' && existing) { try { sendApprovedEmail(existing); } catch (e) {} }
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') {
        showToast(err.code === 'permission-denied'
          ? 'You do not have permission to approve members.'
          : 'Approval failed: ' + (err.code || 'error'), 'error');
      }
    });
  };

  window.rejectUser = function (userId) {
    var existing = (state.users || []).find(function (u) { return u.id === userId; });
    var who = existing ? (existing.name || existing.email) : 'this person';
    if (!confirm('Reject ' + who + "'s access request?")) return;
    return db.collection(USERS).doc(userId).update({ status: 'rejected' }).then(function () {
      if (typeof showToast === 'function') showToast(who + "'s request was rejected.", 'info');
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') showToast('Could not reject: ' + (err.code || 'error'), 'error');
    });
  };

  window.setUserTier = function (userId, tier) {
    return db.collection(USERS).doc(userId).update({
      permissionTier: tier,
      roleId: tier === 'admin' ? 'role_president' : 'role_member'
    }).then(function () {
      if (typeof showToast === 'function') showToast('Permissions updated.', 'success');
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') showToast('Could not update: ' + (err.code || 'error'), 'error');
    });
  };

  window.setUserRole = function (userId, roleId, roleName) {
    var patch = { roleId: roleId };
    if (roleName) patch.role = roleName;
    return db.collection(USERS).doc(userId).update(patch).then(function () {
      if (typeof showToast === 'function') showToast('Role updated.', 'success');
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') showToast('Could not update role: ' + (err.code || 'error'), 'error');
    });
  };

  // ── sync panel ────────────────────────────────────────────────────────────

  window.openSyncModal = function () {
    var body = document.getElementById('sync-modal-body');
    if (!body) return;
    var u = auth.currentUser;
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--accent-light);border-radius:10px;margin-bottom:16px;">' +
      '<span style="width:10px;height:10px;border-radius:50%;background:' + (u ? '#10b981' : '#ef4444') + ';flex-shrink:0;"></span>' +
      '<span style="font-size:14px;font-weight:600;color:var(--text);">' + (u ? 'Signed in and syncing' : 'Not signed in') + '</span></div>' +
      '<p style="font-size:13px;color:var(--text-muted);line-height:1.65;margin:0 0 14px;">' +
      'Everything saves to the club database automatically, on every device, the moment you change it. ' +
      'There is no token to paste and no setup link to share — members just sign in with Google and you approve them.</p>' +
      (u ? '<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 16px;">Signed in as <strong>' +
            escHtml(u.email || '') + '</strong></p>' : '') +
      '<button onclick="signOut()" style="width:100%;min-height:44px;padding:10px;background:none;color:#ef4444;border:1px solid #fca5a5;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;">Sign out</button>';
    if (typeof openModal === 'function') openModal('modal-sync');
  };

  // ── boot ──────────────────────────────────────────────────────────────────

  auth.onAuthStateChanged(function (fbUser) {
    if (!fbUser) {
      _appShown = false;
      var ov = document.getElementById('auth-overlay');
      if (ov) ov.style.display = 'flex';
      var shell = document.getElementById('app-shell');
      if (shell) shell.style.visibility = 'hidden';
      window.currentUser = null;
      window.initGoogleAuth();
      _syncDot('offline');
      return;
    }
    _syncDot('syncing');
    _watchOwnUser(fbUser.uid, fbUser);
  });

  // The old code kicked the whole auth flow off from the Google script's
  // onload, so an offline start left the app on a dead sign-in screen forever.
  // onAuthStateChanged above restores a cached session with no network.
  window.startCloudSync = function () {};

  console.log('[tfh] Firestore sync active — project', FIREBASE_CONFIG.projectId);
})();
