// Share links, the guest (link-visitor) view, and suggested changes.
// Pure logic plus a small Firestore store; both pages pass in the Firestore
// functions they already import, so this file never loads Firebase itself.
//
// Document IDs follow the archive id from config.js (default: familytree):
//   shareConfig/{archiveId}           Super Admin only: { token, active, treeId, updatedAt, updatedByUid }
//   shareLinks/{token}                Super Admin only (get by id, never listed): { active, treeId, createdAt, createdByUid }
//   guestAccess/{uid}                 the visitor's own pointer: { token, createdAt }
//   archives/{archiveId}_guest        redacted tree for link visitors (written by editors)
//   suggestions/{id}                  suggested changes from Google-signed-in users

export const DEFAULT_TREE_ID = 'familytree';

export function resolveTreeId(explicit) {
  if (typeof explicit === 'function') {
    try { const v = String(explicit() || '').trim(); if (v) return v; } catch (e) {}
  } else if (explicit) {
    const v = String(explicit).trim();
    if (v) return v;
  }
  try {
    if (typeof window !== 'undefined' && window.OSR_CONFIG && window.OSR_CONFIG.archiveId) {
      const v = String(window.OSR_CONFIG.archiveId).trim();
      if (v) return v;
    }
  } catch (e) {}
  return DEFAULT_TREE_ID;
}

export function shareConfigPath(treeId) { return ['shareConfig', resolveTreeId(treeId)]; }
export function guestDocPath(treeId) { return ['archives', resolveTreeId(treeId) + '_guest']; }
export const GUEST_FORMAT = 'guest-v1';
export const GUEST_TOKEN_STORAGE_KEY = 'osr_guest_token_v1';
export const GUEST_BANNER_TEXT = 'Viewing as guest. Sign in with Google to see full details.';
export const TOKEN_BYTES = 32; // 256 bits -> 43 base64url characters

export function generateShareToken(cryptoObj = globalThis.crypto) {
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') throw new Error('crypto.getRandomValues is not available');
  const bytes = new Uint8Array(TOKEN_BYTES);
  cryptoObj.getRandomValues(bytes);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isWellFormedToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(token);
}

export function readShareTokenFromUrl(href) {
  try {
    const t = new URL(href).searchParams.get('t');
    return isWellFormedToken(t) ? t : '';
  } catch (e) { return ''; }
}

// The tree page lives next to admin.html, so the link is "<this folder>/?t=<token>".
export function buildShareUrl(pageHref, token) {
  const u = new URL('./', pageHref);
  u.search = '';
  u.hash = '';
  u.searchParams.set('t', token);
  return u.toString();
}

export function stripShareTokenFromUrl(href) {
  const u = new URL(href);
  u.searchParams.delete('t');
  return u.toString();
}

// ---------------------------------------------------------------- redaction
// Allow-list: anything not named here is dropped, so a new private field added
// later stays out of the guest view by default.
const NAME_FIELDS = ['id', 'given', 'surname', 'nickname', 'altName', 'prefix', 'suffix', 'sex', 'livingStatus'];
const DECEASED_EVENT_TYPES = new Set(['BIRT', 'DEAT', 'BURI', 'CREM', 'BAPM', 'CHR', 'MARR', 'RESI', 'OCCU', 'EDUC', 'IMMI', 'EMIG']);

export function isDeceasedForGuest(person) {
  // Only an explicit "deceased" shows dates and places; unknown counts as living.
  return Boolean(person && person.livingStatus === 'deceased');
}

function str(v, max = 500) { return typeof v === 'string' ? v.slice(0, max) : ''; }

export function redactPersonForGuest(p) {
  const out = {};
  NAME_FIELDS.forEach(k => { if (p[k] != null && p[k] !== '') out[k] = typeof p[k] === 'string' ? str(p[k], 200) : p[k]; });
  out.id = p.id;
  out.emails = [];
  out.media = [];
  out.assertions = [];
  out.customTags = [];
  out.events = [];
  if (!out.livingStatus) out.livingStatus = 'living';
  if (isDeceasedForGuest(p)) {
    out.events = (Array.isArray(p.events) ? p.events : [])
      .filter(e => e && DECEASED_EVENT_TYPES.has(e.type))
      .map(e => ({ id: str(e.id, 100), type: e.type, date: str(e.date, 100), place: str(e.place, 300) }));
    if (typeof p.village === 'string' && p.village) out.village = str(p.village, 300);
    // A Firebase download URL is already public to anyone who has it.
    if (typeof p.photoUrl === 'string' && /^https:\/\//.test(p.photoUrl)) out.photoUrl = p.photoUrl;
  }
  return out;
}

export function redactStateForGuest(state) {
  const persons = {};
  const srcPersons = (state && state.persons) || {};
  Object.values(srcPersons).forEach(p => { if (p && p.id) persons[p.id] = redactPersonForGuest(p); });
  const families = {};
  Object.values((state && state.families) || {}).forEach(f => {
    if (!f || !f.id) return;
    const a = srcPersons[f.partner1Id], b = srcPersons[f.partner2Id];
    const bothDeceased = (!f.partner1Id || isDeceasedForGuest(a)) && (!f.partner2Id || isDeceasedForGuest(b));
    const out = {
      id: f.id,
      partner1Id: f.partner1Id || null,
      partner2Id: f.partner2Id || null,
      status: str(f.status, 40),
      marriageDate: '', marriagePlace: '',
      children: (Array.isArray(f.children) ? f.children : [])
        .filter(c => c && c.personId)
        .map(c => ({ personId: c.personId, linkage: str(c.linkage, 40) || 'biological' }))
    };
    if (bothDeceased) {
      out.marriageDate = str(f.marriageDate, 100);
      out.marriagePlace = str(f.marriagePlace, 300);
      if (f.divorceDate) out.divorceDate = str(f.divorceDate, 100);
      if (f.divorcePlace) out.divorcePlace = str(f.divorcePlace, 300);
    }
    families[f.id] = out;
  });
  const title = str(state && state.tree && state.tree.title, 500) || 'Family Tree';
  return {
    format: GUEST_FORMAT,
    tree: { id: str(state && state.tree && state.tree.id, 100) || 'tree', title, revision: (state && state.tree && state.tree.revision) || 1 },
    persons,
    families,
    centralPersonId: (state && state.centralPersonId && persons[state.centralPersonId]) ? state.centralPersonId : null
  };
}

export function buildGuestDocFields(state, meta) {
  const view = redactStateForGuest(state);
  return {
    format: GUEST_FORMAT,
    payloadJson: JSON.stringify(view),
    revision: view.tree.revision,
    updatedAt: meta.updatedAt,
    updatedByEmail: meta.updatedByEmail,
    updatedByUid: meta.updatedByUid
  };
}

// Turns the guest document into a state the tree page can render.
export function guestStateFromDoc(data) {
  if (!data || data.format !== GUEST_FORMAT || typeof data.payloadJson !== 'string') return null;
  const view = JSON.parse(data.payloadJson);
  return {
    tree: view.tree || { title: 'Family Tree', revision: 1 },
    persons: view.persons || {},
    families: view.families || {},
    centralPersonId: view.centralPersonId || null,
    superAdminEmail: '',
    accessControl: { permissions: [], auditLog: [] },
    changeEvents: [],
    changeSequence: 0
  };
}

// --------------------------------------------------------------- suggestions
export const SUGGESTION_FIELDS = [
  { key: 'given', label: 'First name' },
  { key: 'surname', label: 'Surname' },
  { key: 'nickname', label: 'Nickname' },
  { key: 'altName', label: 'Maiden / birth surname' },
  { key: 'birthDate', label: 'Birth date' },
  { key: 'birthPlace', label: 'Birth place' },
  { key: 'deathDate', label: 'Death date' },
  { key: 'deathPlace', label: 'Death place' },
  { key: 'other', label: 'Something else (describe it)' }
];
export const SUGGESTION_FIELD_KEYS = SUGGESTION_FIELDS.map(f => f.key);
export const SUGGESTION_MAX = 2000;

export function suggestionFieldLabel(key) {
  const f = SUGGESTION_FIELDS.find(x => x.key === key);
  return f ? f.label : key;
}

function eventFor(person, type) {
  return (Array.isArray(person && person.events) ? person.events : []).find(e => e && e.type === type) || null;
}

export function currentValueForField(person, field) {
  if (!person) return '';
  switch (field) {
    case 'given': case 'surname': case 'nickname': case 'altName':
      return str(person[field], SUGGESTION_MAX);
    case 'birthDate': return str(eventFor(person, 'BIRT')?.date, SUGGESTION_MAX);
    case 'birthPlace': return str(eventFor(person, 'BIRT')?.place, SUGGESTION_MAX);
    case 'deathDate': return str(eventFor(person, 'DEAT')?.date, SUGGESTION_MAX);
    case 'deathPlace': return str(eventFor(person, 'DEAT')?.place, SUGGESTION_MAX);
    default: return '';
  }
}

// Exactly the fields the rules accept on create (createdAt is added by the store).
export function buildSuggestion({ personId, field, oldValue, newValue, note, email, uid }) {
  const s = {
    personId: str(personId, 100),
    field: SUGGESTION_FIELD_KEYS.includes(field) ? field : 'other',
    oldValue: str(oldValue, SUGGESTION_MAX),
    newValue: str(String(newValue == null ? '' : newValue).trim(), SUGGESTION_MAX),
    note: str(String(note == null ? '' : note).trim(), SUGGESTION_MAX),
    email: String(email || '').trim().toLowerCase(),
    uid: String(uid || ''),
    status: 'pending'
  };
  return s;
}

export function validateSuggestion(s) {
  if (!s.personId) return 'Choose a person first.';
  if (!s.email || !s.uid) return 'Sign in with Google to suggest a change.';
  if (!s.newValue) return s.field === 'other' ? 'Describe the change.' : 'Enter the new value.';
  return '';
}

function ensureEvent(person, type, idFactory) {
  if (!Array.isArray(person.events)) person.events = [];
  let ev = eventFor(person, type);
  if (!ev) {
    ev = { id: idFactory ? idFactory('evt') : ('evt_' + Date.now().toString(36)), type, date: '', place: '' };
    person.events.push(ev);
  }
  return ev;
}

// Applies an approved suggestion to the tree state in place.
// Returns { ok, applied, summary } ; "other" is approved without a tree edit.
export function applySuggestionToState(state, s, { idFactory } = {}) {
  const person = state && state.persons && state.persons[s.personId];
  if (!person) return { ok: false, applied: false, error: 'That person is no longer in the tree.' };
  const label = suggestionFieldLabel(s.field);
  const v = s.newValue;
  switch (s.field) {
    case 'given': case 'surname': case 'nickname': case 'altName':
      person[s.field] = v; break;
    case 'birthDate': ensureEvent(person, 'BIRT', idFactory).date = v; break;
    case 'birthPlace': ensureEvent(person, 'BIRT', idFactory).place = v; break;
    case 'deathDate': ensureEvent(person, 'DEAT', idFactory).date = v; break;
    case 'deathPlace': ensureEvent(person, 'DEAT', idFactory).place = v; break;
    default:
      return { ok: true, applied: false, summary: 'Marked done: ' + label };
  }
  return { ok: true, applied: true, summary: label + ' → ' + v };
}

// ----------------------------------------------------------- Firestore store
// fs: { doc, getDoc, setDoc, deleteDoc, updateDoc, writeBatch, collection, addDoc,
//       getDocs, query, orderBy, limit, serverTimestamp }
export function createShareStore(getDb, fs, opts = {}) {
  const treeId = () => resolveTreeId(opts.treeId);
  const d = (...path) => fs.doc(getDb(), ...path);
  return {
    async loadConfig() {
      const snap = await fs.getDoc(d(...shareConfigPath(treeId())));
      return snap.exists() ? snap.data() : null;
    },
    // Creates a new link. If oldToken is given, that link is deleted in the
    // same batch, so the old URL stops working at once.
    async rotate({ newToken, oldToken, active, uid }) {
      const id = treeId();
      const b = fs.writeBatch(getDb());
      b.set(d('shareLinks', newToken), { active: Boolean(active), treeId: id, createdAt: fs.serverTimestamp(), createdByUid: uid });
      if (oldToken && oldToken !== newToken) b.delete(d('shareLinks', oldToken));
      b.set(d(...shareConfigPath(id)), { token: newToken, active: Boolean(active), treeId: id, updatedAt: fs.serverTimestamp(), updatedByUid: uid });
      await b.commit();
    },
    async setActive({ token, active, uid }) {
      const id = treeId();
      const b = fs.writeBatch(getDb());
      b.update(d('shareLinks', token), { active: Boolean(active) });
      b.set(d(...shareConfigPath(id)), { token, active: Boolean(active), treeId: id, updatedAt: fs.serverTimestamp(), updatedByUid: uid });
      await b.commit();
    },
    async publishGuestView(fields) {
      await fs.setDoc(d(...guestDocPath(treeId())), fields);
    },
    async guestViewExists() {
      const snap = await fs.getDoc(d(...guestDocPath(treeId())));
      return snap.exists();
    },
    // Visitor side: record which link this (anonymous or Google) user holds.
    async claimToken(uid, token) {
      await fs.setDoc(d('guestAccess', uid), { token, createdAt: fs.serverTimestamp() });
    },
    async loadGuestView() {
      const snap = await fs.getDoc(d(...guestDocPath(treeId())));
      return snap.exists() ? snap.data() : null;
    },
    async submitSuggestion(s) {
      const ref = await fs.addDoc(fs.collection(getDb(), 'suggestions'), { ...s, createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    async listSuggestions(max = 200) {
      const q = fs.query(fs.collection(getDb(), 'suggestions'), fs.orderBy('createdAt', 'desc'), fs.limit(max));
      const snap = await fs.getDocs(q);
      return snap.docs.map(x => ({ id: x.id, ...x.data() }));
    },
    async reviewSuggestion(id, { status, email, uid, reviewNote = '' }) {
      await fs.updateDoc(d('suggestions', id), { status, reviewedByEmail: email, reviewedByUid: uid, reviewedAt: fs.serverTimestamp(), reviewNote: str(reviewNote, SUGGESTION_MAX) });
    }
  };
}
