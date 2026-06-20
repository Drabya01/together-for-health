/* ═══════════════════════════════════════════════════════════════
   Together For Health — In-Place Content Editor  v2

   ─ A pencil icon appears at the right end of the nav bar.
   ─ Clicking it asks for a PIN. Enter the correct PIN to enter
     Editor Mode — every piece of visible text gets a dashed
     border and becomes click-to-edit.
   ─ Works across ALL tabs — switching tabs re-applies editable
     treatment to newly visible elements automatically.
   ─ A floating toolbar lets you save or discard all changes.
   ─ Saved edits persist in localStorage (tfh_overrides_v1) and
     are re-applied on every page load automatically.

   ▼ Change EDITOR_PIN below to whatever you want.
═══════════════════════════════════════════════════════════════ */

'use strict';

var EDITOR_PIN    = 'tfh2026';   // ← change this to your preferred PIN
var OVERRIDES_KEY = 'tfh_overrides_v1';

var _editorActive   = false;
var _pendingChanges = {};
var _savedOverrides = {};

/* Text-bearing tags we allow editing — NOTE: no BUTTON (breaks click events) */
var EDITABLE_TAGS = [
  'H1','H2','H3','H4','H5','H6',
  'P','SPAN','LI','LABEL',
  'A','TD','TH','SMALL','STRONG','EM','B','I','DIV'
];

/* Class substrings that mean "skip this element and all its descendants" */
var SKIP_CLASSES = [
  'admin-editor-',  // our own UI
  'nav-',           // nav bar
  'modal-',         // modals
  'cal-nav',        // calendar prev/next buttons
  'cal-day-num',    // calendar day numbers
  'stat-num',       // live stat counters
  'form-',          // form labels/inputs area
];

/* ─────────────────────────────────────────────────────────────
   KEY GENERATION — stable string ID per DOM node
───────────────────────────────────────────────────────────── */
function _edKey(el) {
  if (el.id) return 'id:' + el.id;
  var path = [];
  var node = el;
  while (node && node !== document.body) {
    var tag = node.tagName.toLowerCase();
    var idx = Array.prototype.indexOf.call(
      node.parentElement ? node.parentElement.children : [], node
    );
    path.unshift(tag + '[' + idx + ']');
    node = node.parentElement;
    if (node && node.id) { path.unshift('#' + node.id); break; }
  }
  return 'path:' + path.join('>');
}

/* ─────────────────────────────────────────────────────────────
   SHOULD THIS ELEMENT BE EDITABLE?
───────────────────────────────────────────────────────────── */
function _shouldEdit(el) {
  if (!el || !el.tagName) return false;
  if (EDITABLE_TAGS.indexOf(el.tagName) === -1) return false;

  // Must have own direct text (not just child elements)
  var direct = '';
  el.childNodes.forEach(function(n) {
    if (n.nodeType === 3) direct += n.textContent;
  });
  if (!direct.trim()) return false;

  // Walk up: skip if any ancestor matches a skip class
  var ancestor = el;
  while (ancestor && ancestor !== document.body) {
    var cls = typeof ancestor.className === 'string' ? ancestor.className : '';
    for (var i = 0; i < SKIP_CLASSES.length; i++) {
      if (cls.indexOf(SKIP_CLASSES[i]) !== -1) return false;
    }
    ancestor = ancestor.parentElement;
  }

  return true;
}

/* ─────────────────────────────────────────────────────────────
   MARK ONE ELEMENT AS EDITABLE  (called on enter + tab switch)
───────────────────────────────────────────────────────────── */
function _markEditable(el) {
  if (el.dataset.edKey) return;           // already marked
  if (!_shouldEdit(el)) return;
  var key = _edKey(el);
  el.dataset.edKey      = key;
  el.dataset.edOriginal = el.textContent;
  el.contentEditable    = 'true';
  el.spellcheck         = true;
  el.classList.add('admin-editor-cell');
  el.title = 'Click to edit · Esc to finish';
  el.addEventListener('focus',   _cellFocus,   true);
  el.addEventListener('blur',    _cellBlur,    true);
  el.addEventListener('input',   _cellInput,   true);
  el.addEventListener('keydown', _cellKeydown, true);
}

/* ─────────────────────────────────────────────────────────────
   APPLY / LOAD OVERRIDES  (all visitors see saved edits)
───────────────────────────────────────────────────────────── */
function _loadOverrides() {
  try {
    var raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return;
    _savedOverrides = JSON.parse(raw);
    Object.keys(_savedOverrides).forEach(function(key) {
      var el = _findByKey(key);
      if (el) el.textContent = _savedOverrides[key];
    });
  } catch(e) {}
}

function _saveOverrides(changes) {
  Object.keys(changes).forEach(function(key) {
    _savedOverrides[key] = changes[key].current;
  });
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(_savedOverrides));
}

function _deleteOverride(key) {
  delete _savedOverrides[key];
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(_savedOverrides));
}

function _findByKey(key) {
  if (key.startsWith('id:')) return document.getElementById(key.slice(3));
  if (key.startsWith('path:')) {
    try {
      var sel = key.slice(5)
        .replace(/#([^>]+)>?/g, '#$1 ')
        .replace(/\[(\d+)\]/g, function(_, n) {
          return ':nth-child(' + (parseInt(n) + 1) + ')';
        })
        .trim();
      return document.querySelector(sel);
    } catch(e) { return null; }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
   EDITOR MODE ON / OFF
───────────────────────────────────────────────────────────── */
window.adminEditorToggle  = function() { _editorActive ? _editorOff(false) : _askPin(); };
window.adminEditorIsActive = function() { return _editorActive; };

function _askPin() {
  var entered = prompt('Enter editor PIN:');
  if (entered === null) return;
  if (String(entered).trim() !== String(EDITOR_PIN)) {
    alert('Incorrect PIN.');
    return;
  }
  _editorOn();
}

function _editorOn() {
  _editorActive   = true;
  _pendingChanges = {};
  document.body.classList.add('admin-editor-mode');

  // Mark ALL matching elements (including in hidden tabs)
  document.querySelectorAll(EDITABLE_TAGS.join(',')).forEach(_markEditable);

  _buildToolbar();
  _updateBtn(true);
}

function _editorOff(save) {
  _editorActive = false;
  document.body.classList.remove('admin-editor-mode');

  document.querySelectorAll('.admin-editor-cell').forEach(function(el) {
    el.contentEditable = 'false';
    el.removeAttribute('title');
    el.classList.remove('admin-editor-cell','admin-editor-cell--active','admin-editor-cell--changed');
    el.removeEventListener('focus',   _cellFocus,   true);
    el.removeEventListener('blur',    _cellBlur,    true);
    el.removeEventListener('input',   _cellInput,   true);
    el.removeEventListener('keydown', _cellKeydown, true);
    if (!save && el.dataset.edOriginal !== undefined) {
      el.textContent = el.dataset.edOriginal;
    }
    delete el.dataset.edKey;
    delete el.dataset.edOriginal;
  });

  var tb = document.getElementById('adminEditorToolbar');
  if (tb) {
    tb.classList.add('aet--hide');
    setTimeout(function() { if (tb) tb.remove(); }, 300);
  }

  _pendingChanges = {};
  _updateBtn(false);
}

/* ─────────────────────────────────────────────────────────────
   CELL EVENTS
───────────────────────────────────────────────────────────── */
function _cellFocus()  { this.classList.add('admin-editor-cell--active'); }
function _cellBlur()   { this.classList.remove('admin-editor-cell--active'); }

function _cellInput() {
  var el       = this;
  var key      = el.dataset.edKey;
  if (!key) return;
  var current  = el.textContent;
  var original = el.dataset.edOriginal || '';
  if (current !== original) {
    _pendingChanges[key] = { el: el, original: original, current: current };
    el.classList.add('admin-editor-cell--changed');
  } else {
    delete _pendingChanges[key];
    el.classList.remove('admin-editor-cell--changed');
  }
  _updateToolbarCount();
}

function _cellKeydown(e) {
  if (e.key === 'Escape') { e.target.blur(); e.stopPropagation(); }
  var multiLine = ['DIV','P','LI'].indexOf(e.target.tagName) !== -1;
  if (e.key === 'Enter' && !multiLine && !e.shiftKey) {
    e.preventDefault();
    e.target.blur();
  }
}

/* ─────────────────────────────────────────────────────────────
   FLOATING TOOLBAR
───────────────────────────────────────────────────────────── */
function _buildToolbar() {
  var old = document.getElementById('adminEditorToolbar');
  if (old) old.remove();

  var tb = document.createElement('div');
  tb.id = 'adminEditorToolbar';
  tb.className = 'admin-editor-toolbar';
  tb.innerHTML =
    '<span class="aet-icon">✏️</span>'
    + '<span class="aet-label">Editor</span>'
    + '<span class="aet-tip">Click any text to edit it</span>'
    + '<span class="aet-count" id="aetCount">0 changes</span>'
    + '<button class="aet-btn aet-btn--revert" onclick="adminEditorRevertAll()">Revert all</button>'
    + '<button class="aet-btn aet-btn--saved"  onclick="adminEditorShowSaved()">Saved (0)</button>'
    + '<button class="aet-btn aet-btn--save"   onclick="adminEditorSave()">Save changes</button>'
    + '<button class="aet-btn aet-btn--exit"   onclick="adminEditorExit()">✕ Exit</button>';

  document.body.appendChild(tb);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() { tb.classList.add('aet--visible'); });
  });
  _updateToolbarCount();
}

function _updateToolbarCount() {
  var countEl  = document.getElementById('aetCount');
  var savedBtn = document.querySelector('.aet-btn--saved');
  var n = Object.keys(_pendingChanges).length;
  var s = Object.keys(_savedOverrides).length;
  if (countEl)  countEl.textContent = n + (n === 1 ? ' change' : ' changes');
  if (savedBtn) savedBtn.textContent = 'Saved (' + s + ')';
}

/* ─────────────────────────────────────────────────────────────
   TOOLBAR ACTIONS
───────────────────────────────────────────────────────────── */
window.adminEditorSave = function() {
  var n = Object.keys(_pendingChanges).length;
  if (!n) { _toast('Nothing to save.'); return; }
  _saveOverrides(_pendingChanges);
  _pendingChanges = {};
  document.querySelectorAll('.admin-editor-cell--changed').forEach(function(el) {
    el.classList.remove('admin-editor-cell--changed');
    el.dataset.edOriginal = el.textContent;
  });
  _updateToolbarCount();
  _toast('✅ Saved! ' + n + ' change' + (n !== 1 ? 's' : '') + ' stored.');
};

window.adminEditorRevertAll = function() {
  var n = Object.keys(_pendingChanges).length;
  if (!n) { _toast('No unsaved changes.'); return; }
  Object.keys(_pendingChanges).forEach(function(key) {
    var ch = _pendingChanges[key];
    ch.el.textContent = ch.original;
    ch.el.classList.remove('admin-editor-cell--changed');
  });
  _pendingChanges = {};
  _updateToolbarCount();
  _toast('Reverted ' + n + ' unsaved change' + (n !== 1 ? 's' : '') + '.');
};

window.adminEditorExit = function() {
  var n = Object.keys(_pendingChanges).length;
  if (n > 0 && !confirm('You have ' + n + ' unsaved change' + (n!==1?'s':'') + '. Exit without saving?')) return;
  _editorOff(false);
};

window.adminEditorShowSaved = function() {
  var keys = Object.keys(_savedOverrides);
  if (!keys.length) { _toast('No saved overrides yet.'); return; }

  var existing = document.getElementById('adminEditorSavedPanel');
  if (existing) { existing.remove(); return; }

  var panel = document.createElement('div');
  panel.id = 'adminEditorSavedPanel';
  panel.className = 'admin-editor-saved-panel';
  panel.innerHTML =
    '<div class="aesp-header">'
    + '<span class="aesp-title">Saved overrides (' + keys.length + ')</span>'
    + '<button class="aesp-close" onclick="document.getElementById(\'adminEditorSavedPanel\').remove()">✕</button>'
    + '</div>'
    + '<div class="aesp-list">'
    + keys.map(function(key) {
        var shortKey = key.length > 44 ? key.slice(0, 42) + '…' : key;
        return '<div class="aesp-row">'
          + '<div class="aesp-key" title="' + _esc(key) + '">' + _esc(shortKey) + '</div>'
          + '<div class="aesp-val">' + _esc(_savedOverrides[key]) + '</div>'
          + '<button class="aesp-revert-btn" onclick="adminEditorRevertSaved(\'' + _esc(key) + '\')">Revert</button>'
          + '</div>';
      }).join('')
    + '</div>';

  document.body.appendChild(panel);
};

window.adminEditorRevertSaved = function(key) {
  if (!confirm('Remove this saved override? The original text will come back.')) return;
  _deleteOverride(key);
  _toast('Override removed — reload to see the original text.');
  var p = document.getElementById('adminEditorSavedPanel');
  if (p) p.remove();
  _updateToolbarCount();
};

/* ─────────────────────────────────────────────────────────────
   NAV BUTTON
───────────────────────────────────────────────────────────── */
function _injectEditorBtn() {
  if (document.getElementById('adminEditorNavBtn')) return;
  var container = document.getElementById('top-header-actions');
  if (!container) return;

  var btn = document.createElement('button');
  btn.id        = 'adminEditorNavBtn';
  btn.className = 'admin-editor-nav-btn header-action-btn';
  btn.title     = 'Editor mode — enter PIN to edit text';
  btn.setAttribute('aria-label', 'Toggle editor mode');
  btn.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M14.5 2.5a2.121 2.121 0 0 1 3 3L6 17H3v-3L14.5 2.5z"'
    + ' stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
  btn.onclick = window.adminEditorToggle;
  container.appendChild(btn);
}

function _updateBtn(active) {
  var btn = document.getElementById('adminEditorNavBtn');
  if (!btn) return;
  btn.classList.toggle('admin-editor-nav-btn--active', active);
  btn.title = active ? 'Exit editor mode' : 'Editor mode — enter PIN to edit text';
}

/* ─────────────────────────────────────────────────────────────
   HOOK switchTab — re-mark elements in newly visible tab
───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  if (typeof switchTab === 'function') {
    var _origST = switchTab;
    window.switchTab = function(name) {
      _origST.apply(this, arguments);
      if (_editorActive) {
        // Small delay so render functions (renderPlans, etc.) finish first
        setTimeout(function() {
          document.querySelectorAll(EDITABLE_TAGS.join(',')).forEach(_markEditable);
        }, 80);
      }
    };
  }
});

/* ─────────────────────────────────────────────────────────────
   TOAST
───────────────────────────────────────────────────────────── */
function _toast(msg) {
  var old = document.getElementById('adminEditorToast');
  if (old) old.remove();
  var t = document.createElement('div');
  t.id = 'adminEditorToast';
  t.className = 'admin-editor-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() { t.classList.add('aet-show'); });
  });
  setTimeout(function() {
    t.classList.remove('aet-show');
    setTimeout(function() { if (t.parentNode) t.remove(); }, 400);
  }, 3500);
}

/* ─────────────────────────────────────────────────────────────
   SAFE HTML ESCAPE
───────────────────────────────────────────────────────────── */
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────────────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  _injectEditorBtn();
  _loadOverrides();
});
