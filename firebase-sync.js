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

  // EMERGENCY BOOTSTRAP ONLY. These addresses can mint the first admin when the users
  // collection is empty, because otherwise nobody could ever approve the first person and
  // the club would be locked out of its own app.
  //
  // This is NOT how succession works. Once anyone is an admin, the next president is made
  // one by approving them with permissionTier 'admin' in the Members tab — no code change
  // and no redeploy. Add the club-owned account here (and drop the personal one) so the
  // app outlives whoever set it up: a personal address alone means the club loses recovery
  // access the moment that student graduates.
  //
  // Must match the list in firestore.rules. The rules copy is the one actually enforced —
  // editing this file alone grants nothing.
  // Emergency bootstrap and recovery ONLY — not how succession works, and not how anyone
  // normally gets admin. Once anyone is an admin, the next president is made one by
  // approving them with permissionTier 'admin': no code edit, no console, no credentials.
  //
  // Deliberately the club-owned account and nothing else. Individual students' addresses do
  // not belong here — recovery access has to outlive whoever happens to be president, which
  // is the whole reason the club account exists. Verified working before the founding
  // president's personal address was removed.
  //
  // Must stay identical to isOwner() in firestore.rules. The rules copy is what enforces;
  // this copy only decides who gets bootstrapped as President on a first sign-in.
  var OWNER_EMAILS = ['togetherforhealthmdhs@gmail.com'];

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
  var OPEN_DOC = db.collection('club').doc('open');

  // The club document is split in two so the security rules can tell the difference
  // between "data the exec team owns" and "things a member does themselves".
  //
  //   club/state  staff write, approved read  - events, meetings, budget, roster, resources
  //   club/open   approved write              - these four keys only
  //
  // Before the split, one document meant any approved member could technically rewrite the
  // budget, the roster or the whole calendar, because the app's 30-permission system is UI
  // gating and the rules cannot see it. Now an ordinary member's write reaches nothing else.
  //
  // Why these four: ideas and feedback are member submissions by design; hours are the
  // member's own declaration; claims are their own sign-ups. Shift claims live here rather
  // than inside the event object precisely so events can stay staff-only.
  //
  // Honest limitation: club/open is still ONE document, so a member can technically edit
  // another member's hours entry or delete someone's idea. Fixing that needs per-record
  // documents (hours/{uid}). This is a large improvement over "any member can wipe the
  // budget", and the remaining exposure is small, visible and inside the club.
  var OPEN_KEYS = ['ideas', 'feedback', 'hours', 'claims'];

  var _userUnsub = null, _clubUnsub = null, _rosterUnsub = null, _openUnsub = null;
  var _writeTimer = null, _pendingWrite = false, _applyingRemote = false, _suppressWrite = false;

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
     'eventBudgets', 'hours'].forEach(function (k) { if (!Array.isArray(state[k])) state[k] = []; });
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

  // The staff-owned document: everything except the member-writable keys, the users
  // collection (which has its own collection) and gist-era cruft.
  function _clubPayload() {
    var out = {};
    Object.keys(state).forEach(function (k) {
      if (k === 'users' || k === '_syncTs' || k === '_syncVersion' || k === '_sitePin') return;
      if (OPEN_KEYS.indexOf(k) !== -1) return;
      out[k] = state[k];
    });
    return out;
  }

  // The member-writable document: only the four open keys.
  function _openPayload() {
    var out = {};
    OPEN_KEYS.forEach(function (k) { out[k] = Array.isArray(state[k]) ? state[k] : []; });
    return out;
  }

  // ── writing ───────────────────────────────────────────────────────────────

  // Circuit breaker. The Spark plan has a daily write quota, and a feedback loop between
  // a snapshot and a save can spend it in seconds. If writes ever spike far above what
  // human editing could produce, stop and say so rather than silently burning the quota.
  var _writeTimes = [];
  function _writeStormDetected() {
    var now = Date.now();
    _writeTimes.push(now);
    _writeTimes = _writeTimes.filter(function (t) { return now - t < 10000; });
    if (_writeTimes.length > 25) {
      console.error('[tfh] write loop detected — pausing writes. ' + _writeTimes.length + ' in 10s.');
      if (typeof showToast === 'function') {
        showToast('Sync paused: the app was saving in a loop. Please reload — and tell Claude this happened.', 'error');
      }
      return true;
    }
    return false;
  }

  function _flushClubWrite() {
    if (!auth.currentUser) { _pendingWrite = false; return Promise.resolve(false); }
    if (_writeStormDetected()) { _pendingWrite = false; return Promise.resolve(false); }
    _pendingWrite = false;
    var payload = _clubPayload();
    // Remember what we sent, so the server's acknowledgement of this very write is
    // recognised as "no change" and does not trigger a redraw. Without this, every save
    // bounced back as a snapshot, redrew the page, and renderDash()'s seen-marking saved
    // again — a write loop that both flickered the UI and burned Firestore quota.
    _lastClubJson = JSON.stringify(payload);
    var openPayload = _openPayload();
    _lastOpenJson = JSON.stringify(openPayload);
    var meta = function () {
      return { updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
               updatedBy: auth.currentUser.email || auth.currentUser.uid };
    };

    // Every approved member may write club/open. Only staff may write club/state, so do
    // not even attempt it otherwise: a guaranteed permission-denied on every save would
    // spam the console and the error toast for ordinary members.
    var writes = [OPEN_DOC.set(Object.assign({ data: openPayload }, meta()), { merge: false })];
    if (_hasStaffTier(window.currentUser)) {
      writes.push(CLUB_DOC.set(Object.assign({ data: payload }, meta()), { merge: false }));
    }

    return Promise.all(writes).then(function () {
      _syncDot('synced');
      return true;
    }).catch(function (err) {
      console.warn('[tfh] club write failed:', err && err.code);
      _syncDot('error');
      if (err && err.code === 'permission-denied' && typeof showToast === 'function') {
        showToast('You do not have permission to change that.', 'error');
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
    return Promise.all([CLUB_DOC.get(), OPEN_DOC.get()]).then(function (snaps) {
      if (snaps[0].exists) _applyClubSnapshot(snaps[0], true);
      if (snaps[1].exists) _applyOpenSnapshot(snaps[1], true);
      _syncDot('synced');
      return 'current';
    }).catch(function () { _syncDot('error'); return false; });
  };

  window.saveState = function () {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    if (_applyingRemote || _suppressWrite) return;   // don't echo a remote change back
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

  // JSON of the club payload as we last saw or wrote it. Used to recognise a snapshot
  // that carries no actual change — which includes the server's acknowledgement of our
  // OWN write, since every write updates `updatedAt` and so produces a fresh snapshot.
  var _lastClubJson = null;
  var _lastOpenJson = null;
  var _lastRosterJson = null;

  // Returns true only when the club data genuinely changed and the UI should redraw.
  function _applyClubSnapshot(snap, force) {
    if (!snap.exists) return false;
    // Skip our own un-acknowledged writes; otherwise every local edit would
    // bounce back through here and re-render mid-typing.
    if (!force && snap.metadata && snap.metadata.hasPendingWrites) return false;
    var d = (snap.data() || {}).data || {};
    var incoming = JSON.stringify(d);
    if (incoming === _lastClubJson) return false;   // nothing new — do not redraw
    _lastClubJson = incoming;
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
    return true;
  }

  // Same dedupe and echo-suppression contract as _applyClubSnapshot, for the open document.
  function _applyOpenSnapshot(snap, force) {
    if (!snap.exists) return false;
    if (!force && snap.metadata && snap.metadata.hasPendingWrites) return false;
    var d = (snap.data() || {}).data || {};
    var incoming = JSON.stringify(d);
    if (incoming === _lastOpenJson) return false;
    _lastOpenJson = incoming;
    _applyingRemote = true;
    try {
      OPEN_KEYS.forEach(function (k) { state[k] = Array.isArray(d[k]) ? d[k] : []; });
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    } finally { _applyingRemote = false; }
    return true;
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
    if (_openUnsub) { _openUnsub(); _openUnsub = null; }
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
      } else {
        // They are pending or rejected. If the app was already open, they have just been
        // removed while using it — tear down the live club and roster listeners so they
        // stop receiving club data, and reset _appShown so a later re-approval opens the
        // app again cleanly. (The rules would refuse them anyway, but leaving the listeners
        // attached means an errored subscription and stale data on screen.)
        if (_appShown) {
          if (_clubUnsub) { _clubUnsub(); _clubUnsub = null; }
          if (_rosterUnsub) { _rosterUnsub(); _rosterUnsub = null; }
          _appShown = false;
          _lastClubJson = null;
          _lastRosterJson = null;
          var shell = document.getElementById('app-shell');
          if (shell) shell.style.visibility = 'hidden';
          if (typeof showToast === 'function') {
            showToast('Your access to the club app was removed by an admin.', 'info');
          }
        }
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

  // Run the bootstrap at most once per session. The user-document listener fires again on
  // every failed attempt (the document still does not exist), so without this guard a
  // rejected write becomes an unbounded retry loop — observed at ~600 failures and ~140
  // re-renders in six seconds, which is what the "flickering" actually was.
  var _bootstrapTried = false;

  function _createOwnUserDoc(uid, fbUser) {
    var email = (fbUser.email || '').toLowerCase();
    var owner = _isOwnerEmail(email);
    // A brand-new person goes through onboarding to collect grade/role/bio.
    // The owner is bootstrapped straight to president.
    if (!owner) {
      // Guard this too: the listener re-fires while the document is still absent, and
      // re-running showMemberOnboard would reset the form under the member as they type.
      var ov = document.getElementById('member-onboard-overlay');
      if (ov && ov.style.display === 'flex') return;
      if (typeof showMemberOnboard === 'function') {
        showMemberOnboard(uid, fbUser.email || '', fbUser.displayName || fbUser.email || '', fbUser.photoURL || '');
      }
      return;
    }
    if (_bootstrapTried) return;
    _bootstrapTried = true;

    // Two steps on purpose. firestore.rules only permits a person to CREATE their own
    // record as status:'pending' / permissionTier:'member' — that restriction is what makes
    // self-approval impossible, and it applies to the owner's own first write too. So
    // create the record within those limits, then elevate it with an UPDATE, which the
    // rules do allow for the owner. Doing it in one privileged create would have required
    // an owner exemption in the create rule, i.e. a weaker rule for a once-ever operation.
    var ref = db.collection(USERS).doc(uid);
    ref.set({
      email: fbUser.email || '', name: fbUser.displayName || 'Owner', photo: fbUser.photoURL || '',
      grade: '', roleInterest: '', bio: '',
      role: '', permissionTier: 'member', roleId: 'role_member',
      status: 'pending', joinedAt: Date.now()
    }).then(function () {
      return ref.update({
        role: 'President', permissionTier: 'admin', roleId: 'role_president', status: 'approved'
      });
    }).then(function () {
      console.log('[tfh] owner bootstrapped as President');
    }).catch(function (e) {
      console.error('[tfh] owner bootstrap failed', e);
      var m = 'Could not create your account record: ' + (e && e.code ? e.code : 'error') +
              '. If this says permission-denied, the security rules may not be published.';
      if (typeof showToast === 'function') showToast(m, 'error');
      _fatal(m);
    });
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
        if (!snap.exists) {
          // First run on a fresh database. Everything the club already has lives in this
          // device's localStorage (it was never publishable without a GitHub token), so
          // seed the shared document from it. Staff only — a member must never author the
          // club document from their own partial copy.
          if (_hasStaffTier(u) && !snap.metadata.hasPendingWrites) {
            _flushClubWrite().then(function (ok) {
              if (ok && typeof showToast === 'function') {
                showToast('Club data moved to the new database.', 'success');
              }
            });
          }
          _showAppOnce();
          return;
        }
        var changed = _applyClubSnapshot(snap);
        if (first) { _showAppOnce(); }
        else if (changed) { _rerenderActiveTab(); }   // only redraw on a real change
      }, function (err) {
        console.warn('[tfh] club listener error:', err && err.code);
        _showAppOnce();
      });
    }
    if (!_openUnsub) {
      _openUnsub = OPEN_DOC.onSnapshot(function (snap) {
        if (!snap.exists) {
          // Migration off the single combined document. The four open keys are still inside
          // club/state from before the split; one staff write lifts them into club/open and
          // drops them from club/state in the same pass. Staff-only, because a member must
          // not author the initial split from their own partial copy.
          if (_hasStaffTier(u) && !snap.metadata.hasPendingWrites) {
            _flushClubWrite().then(function (ok) {
              if (ok) console.log('[tfh] split club/open out of club/state');
            });
          }
          return;
        }
        if (_applyOpenSnapshot(snap)) _rerenderActiveTab();
      }, function (err) { console.warn('[tfh] open listener error:', err && err.code); });
    }
    if (_hasStaffTier(u) && !_rosterUnsub) {
      _rosterUnsub = db.collection(USERS).onSnapshot(function (qs) {
        var docs = [];
        qs.forEach(function (d) {
          var v = d.data() || {}; v.id = d.id; v.uid = d.id;
          if (!v.googleId) v.googleId = d.id;
          docs.push(v);
        });
        // Dedupe like the club listener. Firestore also delivers metadata-only snapshots
        // (cache-to-server transitions, cross-tab echoes); re-rendering the Members page on
        // each of those rebuilt its role <select>s repeatedly and read as flickering.
        var json = JSON.stringify(docs);
        if (json === _lastRosterJson) return;
        _lastRosterJson = json;
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
    // The Members UI calls this as setUserRole(id, select.value) with no name, so derive the
    // display name from the roles list — otherwise user.role kept the previous role's label.
    if (!roleName) {
      var r = (state.roles || []).find(function (x) { return x.id === roleId; });
      if (r) roleName = r.name;
    }
    var patch = { roleId: roleId };
    if (roleName) patch.role = roleName;
    // An admin role must carry the admin tier, or the person gets the title without the
    // access (and vice versa) — the two fields were previously set independently.
    if (roleId === 'role_president') patch.permissionTier = 'admin';
    return db.collection(USERS).doc(userId).update(patch).then(function () {
      if (typeof showToast === 'function') showToast('Role updated.', 'success');
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') showToast('Could not update role: ' + (err.code || 'error'), 'error');
    });
  };

  // ── removing people ───────────────────────────────────────────────────────
  //
  //  Two distinct actions, because they are not the same thing:
  //
  //    revokeUser()          a KICK. Access ends immediately, their profile is kept, and
  //                          they reappear in the pending list so they can be let back in
  //                          with one click. Not a ban — nothing stops them returning.
  //    removeUserCompletely() erases the account record entirely. They would sign in as a
  //                          brand-new applicant and refill the form.
  //
  //  The old revokeUser() mutated state.users and called saveState(), which writes
  //  club/state — and club/state deliberately excludes the users collection. So revoking
  //  someone did nothing at all: the button appeared to work and the person kept access.

  window.revokeUser = function (userId) {
    var u = (state.users || []).find(function (x) { return x.id === userId; });
    var who = u ? (u.name || u.email || 'This member') : 'This member';
    if (!confirm('Remove ' + who + ' from the club?\n\n' +
                 'They lose access straight away, but this is not a ban — they stay in your list ' +
                 'as "pending", so you can let them back in with one click whenever you want.')) return;
    return db.collection(USERS).doc(userId).update({ status: 'pending' }).then(function () {
      if (typeof showToast === 'function') {
        showToast(who + ' has been removed. They are in your pending list if you want them back.', 'success');
      }
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') {
        showToast(err.code === 'permission-denied'
          ? 'You do not have permission to remove members.'
          : 'Could not remove: ' + (err.code || 'error'), 'error');
      }
    });
  };

  window.removeUserCompletely = function (userId) {
    var u = (state.users || []).find(function (x) { return x.id === userId; });
    var who = u ? (u.name || u.email || 'this member') : 'this member';
    if (!confirm('Permanently delete ' + who + "'s account record?\n\n" +
                 'Their name, grade and profile are erased. If they ever want back in they would ' +
                 'sign in and fill the join form again from scratch.\n\n' +
                 'To simply remove their access, use Remove instead — it keeps their profile.')) return;
    return db.collection(USERS).doc(userId).delete().then(function () {
      // Also drop the matching roster card, which lives in the club document.
      if (u && Array.isArray(state.members)) {
        var lc = (u.email || '').toLowerCase();
        var before = state.members.length;
        state.members = state.members.filter(function (m) {
          return (m.email || '').toLowerCase() !== lc && m.googleId !== userId;
        });
        if (state.members.length !== before) window.saveState();
      }
      if (typeof showToast === 'function') showToast(who + "'s account was deleted.", 'success');
      if (typeof renderMembers === 'function') renderMembers();
    }).catch(function (err) {
      if (typeof showToast === 'function') showToast('Could not delete: ' + (err.code || 'error'), 'error');
    });
  };

  // Deleting a roster card used to leave the person's ACCESS untouched, so someone removed
  // from the Members list could still sign in and use the app. Offer to do both.
  var _origDeleteMember = window.deleteMember;
  window.deleteMember = function (id) {
    var m = (state.members || []).find(function (x) { return x.id === id; });
    if (!m) { if (typeof _origDeleteMember === 'function') return _origDeleteMember.apply(this, arguments); }
    var lc = (m.email || '').toLowerCase();
    var acct = (state.users || []).find(function (u) {
      return (u.email || '').toLowerCase() === lc || (m.googleId && u.id === m.googleId);
    });
    var name = m.name || m.email || 'this member';
    if (!confirm('Remove ' + name + ' from the roster?')) return;
    state.members = (state.members || []).filter(function (x) { return x.id !== id; });
    window.saveState();
    if (typeof renderMembers === 'function') renderMembers();
    if (acct && acct.status === 'approved') {
      if (confirm(name + ' still has an account that can sign in.\n\nRemove their access too?')) {
        return db.collection(USERS).doc(acct.id).update({ status: 'pending' }).then(function () {
          if (typeof showToast === 'function') showToast(name + ' removed from the roster and signed out of the app.', 'success');
          if (typeof renderMembers === 'function') renderMembers();
        }).catch(function () {});
      }
      if (typeof showToast === 'function') showToast('Removed from the roster. ' + name + ' can still sign in.', 'info');
    }
  };

  // Deleting a role reassigned affected users via state.users + saveState(), which went
  // nowhere. Reassign them in Firestore instead, then let the original clean up the role.
  var _origDeleteRole = window.deleteRole;
  window.deleteRole = function (roleId) {
    var affected = (state.users || []).filter(function (u) { return u.roleId === roleId; });
    var out = (typeof _origDeleteRole === 'function') ? _origDeleteRole.apply(this, arguments) : undefined;
    affected.forEach(function (u) {
      db.collection(USERS).doc(u.id).update({ roleId: 'role_member', role: 'Member' }).catch(function () {});
    });
    if (affected.length && typeof showToast === 'function') {
      showToast(affected.length + ' member' + (affected.length === 1 ? '' : 's') + ' moved to the Member role.', 'info');
    }
    return out;
  };

  // The tour's "don't show me again" flag lives on the person, not on the club, so
  // saveState() (which writes club/state and deliberately excludes the users collection)
  // could never persist it — the tour replayed on every single refresh. Persist it to the
  // user's own document instead. Wrapped rather than replaced so the visual teardown in
  // index.html's finishTour() still runs.
  // renderDash() stamps the viewer's own id into announcement.seenBy and calls saveState().
  // That is per-person read state, not club data, but it lived in the shared document — so
  // every viewer rewrote the club doc just by looking at the dashboard. With two tabs signed
  // in as different people (an admin tab and a member tab, exactly how this gets tested) each
  // write looked like a real change to the other, which re-rendered, which stamped ITS id,
  // which wrote again: a cross-tab ping-pong that never settles and shows up as flickering.
  //
  // Suppress the Firestore write for the duration of a render. seenBy still persists to
  // localStorage immediately and rides along with the next genuine save, so nothing is lost.
  ['renderDash', 'renderMembers', 'renderParticipation'].forEach(function (fn) {
    var orig = window[fn];
    if (typeof orig !== 'function') return;
    window[fn] = function () {
      var prev = _suppressWrite;
      _suppressWrite = true;
      try { return orig.apply(this, arguments); }
      finally { _suppressWrite = prev; }
    };
  });

  function _tourKey(uid) { return 'tfh_onboarded_' + uid; }

  var _origFinishTour = window.finishTour;
  window.finishTour = function () {
    var u = auth.currentUser;
    if (u) {
      if (window.currentUser) window.currentUser.onboarded = true;
      // Local flag first: it is synchronous, survives a slow or failed network write, and
      // is what actually guarantees the tour does not reappear on the very next refresh.
      try { localStorage.setItem(_tourKey(u.uid), '1'); } catch (e) {}
      // Then the durable copy, so the tour stays dismissed on this person's other devices.
      db.collection(USERS).doc(u.uid).update({ onboarded: true }).catch(function (e) {
        console.warn('[tfh] could not persist onboarded flag:', e && e.code);
      });
    }
    if (typeof _origFinishTour === 'function') return _origFinishTour.apply(this, arguments);
  };

  // _shouldTour() in index.html only consults currentUser.onboarded, which is populated
  // from the Firestore document and so is empty until that document round-trips. Gate the
  // tour on the local flag as well, so a refresh never replays a tour already dismissed.
  var _origMaybeStartTour = window.maybeStartTour;
  window.maybeStartTour = function () {
    var u = auth.currentUser;
    if (u) {
      var seen = false;
      try { seen = localStorage.getItem(_tourKey(u.uid)) === '1'; } catch (e) {}
      if (seen || (window.currentUser && window.currentUser.onboarded)) return;
    }
    if (typeof _origMaybeStartTour === 'function') return _origMaybeStartTour.apply(this, arguments);
  };

  // The email approve/reject links were built for the Gist era, where a member's signup
  // never reached the admin's device and the link had to carry their details so the record
  // could be created locally. With Firestore the applicant registers themselves and shows
  // up in the live roster, so that materialisation path is not just unnecessary — it writes
  // to state.users and would be silently discarded. Send the admin to the Members tab,
  // where approving is one click on live data.
  window.processPendingAction = function () {
    var raw;
    try { raw = sessionStorage.getItem('tfh_pending_action'); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem('tfh_pending_action'); } catch (e) {}
    var action;
    try { action = JSON.parse(raw); } catch (e) { return; }
    if (!window.currentUser || !_hasStaffTier(window.currentUser)) {
      if (typeof showToast === 'function') showToast('Admin access is required to review requests.', 'error');
      return;
    }
    if (typeof switchTab === 'function') switchTab('members');
    var name = action.name || action.email || 'the applicant';
    if (typeof showToast === 'function') {
      showToast(action.type === 'approve'
        ? 'Approve ' + name + ' below — their request is in the list.'
        : 'Review ' + name + "'s request below.", 'info');
    }
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
