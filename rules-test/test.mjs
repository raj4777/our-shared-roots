import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, runTransaction, onSnapshot, collection } from 'firebase/firestore';
import fs from 'node:fs';
import { reconcilePermissionsWithMainDoc, computeAccessListsFromPermissions, frozenAccessListsFromMainDoc, nextArchiveRevision } from '../src/acl-core.js';

const SUPER = (process.env.OSR_SUPER_ADMIN || 'owner@example.com').toLowerCase();
const ARCHIVE_ID = process.env.OSR_ARCHIVE_ID || 'familytree';
const ARCHIVE_LOG_ID = process.env.OSR_ARCHIVE_LOG_ID || (ARCHIVE_ID + '_log');
function loadRules() {
  const rawPath = process.env.RULES_FILE;
  let raw;
  if (rawPath) raw = fs.readFileSync(rawPath, 'utf8');
  else raw = fs.readFileSync(new URL('../templates/firestore.rules.template', import.meta.url), 'utf8');
  return raw
    .replaceAll('__SUPER_ADMIN_EMAIL__', SUPER)
    .replaceAll('__ARCHIVE_ID__', ARCHIVE_ID)
    .replaceAll('__ARCHIVE_LOG_ID__', ARCHIVE_LOG_ID);
}
const RULES = loadRules();
const EDITOR = 'editor@example.com', ADMIN = 'admin@example.com', VIEWER = 'viewer@example.com', OUTSIDER = 'stranger@example.com';

const env = await initializeTestEnvironment({ projectId: 'demo-family-tree', firestore: { rules: RULES, host: '127.0.0.1', port: 8181 } });

// Builds exactly what the pages send (computeRuleAccessLists + persist engine meta).
// revision: AUTO means "stored revision + 1", filled in just before the write,
// which is what the pages send. Tests that probe the guard pass a number.
const AUTO = 'auto-revision';
function pagePayload(email, uid, perms, extra = {}) {
  const superEmail = SUPER;
  const auth = new Set([superEmail]), edit = new Set([superEmail]), admins = new Set([superEmail]);
  perms.forEach(p => { auth.add(p.email); if (['super_admin', 'admin', 'edit'].includes(p.role)) edit.add(p.email); if (['super_admin', 'admin'].includes(p.role)) admins.add(p.email); });
  const state = { tree: { title: 'Family Tree', revision: 1 }, superAdminEmail: superEmail, persons: { p1: { id: 'p1', given: 'Alex' } }, families: {}, accessControl: { permissions: perms, auditLog: [] }, changeEvents: [], changeSequence: 1, ...extra.state };
  return { title: 'Family Tree', revision: AUTO, superAdminEmail: superEmail, authorizedEmails: [...auth], editorEmails: [...edit], adminEmails: [...admins],
    updatedAt: new Date().toISOString() + Math.random(), updatedByEmail: email.toLowerCase(), updatedByUid: uid, payloadJson: JSON.stringify(state), ...extra.meta };
}
const basePerms = [{ email: ADMIN, role: 'admin' }, { email: EDITOR, role: 'edit' }, { email: VIEWER, role: 'view' }];
const ctx = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const ref = db => doc(db, 'archives', ARCHIVE_ID);
const logRef = db => doc(db, 'archives', ARCHIVE_LOG_ID);
async function storedMain() {
  let data = null;
  await env.withSecurityRulesDisabled(async c => { const s = await getDoc(ref(c.firestore())); data = s.exists() ? s.data() : null; });
  return data;
}
async function withRev(payload) {
  if (!payload || payload.revision !== AUTO) return payload;
  const cur = await storedMain();
  return { ...payload, revision: cur && typeof cur.revision === 'number' ? cur.revision + 1 : 1 };
}
const txSave = async (db, payload) => { const p = await withRev(payload); return runTransaction(db, async tx => { await tx.get(ref(db)); tx.set(ref(db), p, { merge: true }); }); };
const txSaveBoth = async (db, main, log) => { const p = await withRev(main); return runTransaction(db, async tx => { await tx.get(ref(db)); await tx.get(logRef(db)); tx.set(ref(db), p, { merge: true }); tx.set(logRef(db), log, { merge: true }); }); };
const setMain = async (db, payload, opts = { merge: true }) => setDoc(ref(db), await withRev(payload), opts);
const snapOnce = db => new Promise((res, rej) => { const un = onSnapshot(ref(db), s => { un(); res(s); }, e => { un(); rej(e); }); });
const snapLogOnce = db => new Promise((res, rej) => { const un = onSnapshot(logRef(db), s => { un(); res(s); }, e => { un(); rej(e); }); });
function logPayload(email, uid, extra = {}) {
  return { changeLogJson: JSON.stringify({ changeEvents: extra.events || [], changeSequence: extra.seq ?? 0 }),
    updatedAt: new Date().toISOString() + Math.random(), updatedByEmail: email.toLowerCase(), updatedByUid: uid, ...extra.meta };
}

const results = [];
async function check(name, expectOk, fn) {
  try { await (expectOk ? assertSucceeds(fn()) : assertFails(fn())); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, String(e?.message || e).slice(0, 160)]); }
}
const seed = async (perms = basePerms, opts = {}) => env.withSecurityRulesDisabled(async c => {
  const p = { ...pagePayload(SUPER, 'uid-super', perms), revision: opts.revision || 1 };
  if (opts.legacy) delete p.adminEmails;
  await setDoc(ref(c.firestore()), p);
});

const sup = ctx('uid-super', SUPER), ed = ctx('uid-ed', EDITOR), adm = ctx('uid-adm', ADMIN), vw = ctx('uid-vw', VIEWER), out = ctx('uid-out', OUTSIDER);
const anon = env.unauthenticatedContext().firestore();

await env.clearFirestore();
// --- Missing document (first run)
await check('outsider: getDoc on missing archive is denied', false, () => getDoc(ref(out)));
await check('outsider: cannot create the archive (no "first user becomes super admin")', false, () => txSave(out, { ...pagePayload(OUTSIDER, 'uid-out', []), superAdminEmail: OUTSIDER, authorizedEmails: [OUTSIDER], editorEmails: [OUTSIDER] }));
await check('super admin: getDoc on missing archive allowed', true, () => getDoc(ref(sup)));
await check('super admin: creates archive via page transaction', true, () => txSave(sup, pagePayload(SUPER, 'uid-super', [])));

await env.clearFirestore(); await seed();
// --- Super admin
await check('super admin: getDoc', true, () => getDoc(ref(sup)));
await check('super admin: onSnapshot', true, () => snapOnce(sup));
await check('super admin: transaction save', true, () => txSave(sup, pagePayload(SUPER, 'uid-super', basePerms)));
await check('super admin: setDoc merge fallback save', true, () => setMain(sup, pagePayload(SUPER, 'uid-super', basePerms), { merge: true }));
await check('super admin: revoke an editor (lists shrink)', true, () => txSave(sup, pagePayload(SUPER, 'uid-super', basePerms.filter(p => p.email !== EDITOR))));
await seed();
// --- Admin role (in editorEmails)
await check('admin: getDoc + onSnapshot', true, async () => { await getDoc(ref(adm)); await snapOnce(adm); });
await check('admin (in-app): cannot grant a new editor (only Super Admin may change access lists)', false, () => txSave(adm, pagePayload(ADMIN, 'uid-adm', [...basePerms, { email: 'new@example.com', role: 'edit' }])));
await seed();
// --- Editor
await check('editor: getDoc', true, () => getDoc(ref(ed)));
await check('editor: onSnapshot', true, () => snapOnce(ed));
await check('editor: transaction save of tree edits', true, () => txSave(ed, pagePayload(EDITOR, 'uid-ed', basePerms, { state: { persons: { p1: { id: 'p1', given: 'Alex' }, p2: { id: 'p2', given: 'Jordan' } } } })));
await check('editor: setDoc merge fallback save', true, () => setMain(ed, pagePayload(EDITOR, 'uid-ed', basePerms), { merge: true }));
await check('editor: uppercase Google email still matches', true, () => getDoc(ref(ctx('uid-ed', 'Editor@Example.com'))));
await check('editor: cannot add a person email to access lists (even as View)', false, () => txSave(ed, pagePayload(EDITOR, 'uid-ed', [...basePerms, { email: 'cousin@example.com', role: 'view' }])));
await seed();
await check('editor: cannot add a person email to access lists as Edit', false, () => txSave(ed, pagePayload(EDITOR, 'uid-ed', [...basePerms, { email: 'cousin@example.com', role: 'edit' }])));
await seed();
await check('super admin: can grant a new editor', true, () => txSave(sup, pagePayload(SUPER, 'uid-super', [...basePerms, { email: 'new@example.com', role: 'edit' }])));
await seed();
await check('super admin: can grant a new viewer', true, () => txSave(sup, pagePayload(SUPER, 'uid-super', [...basePerms, { email: 'newview@example.com', role: 'view' }])));
await seed();
{
  const payload = pagePayload(EDITOR, 'uid-ed', basePerms, { state: { persons: { p1: { id: 'p1', given: 'Alex' }, p2: { id: 'p2', given: 'Jordan', emails: ['cousin@example.com'] } } } });
  const state = JSON.parse(payload.payloadJson);
  state.accessControl.permissions = [...(state.accessControl.permissions || []), { email: 'cousin@example.com', role: 'view' }];
  payload.payloadJson = JSON.stringify(state);
  await check('editor: can save tree edits that mention a new email in the payload without changing access lists', true, () => txSave(ed, payload));
}
await seed();
await check('editor: cannot change superAdminEmail', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), superAdminEmail: EDITOR }));
await check('editor: cannot remove super admin from editorEmails', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), editorEmails: [EDITOR, ADMIN] }));
await check('editor: cannot remove super admin from authorizedEmails', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), authorizedEmails: [EDITOR, ADMIN, VIEWER] }));
await check('editor: cannot impersonate (updatedByUid of someone else)', false, () => txSave(ed, pagePayload(EDITOR, 'uid-super', basePerms)));
await check('editor: cannot impersonate (updatedByEmail of someone else)', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), updatedByEmail: SUPER }));
await check('editor: cannot add unknown fields', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), isAdmin: true }));
await check('editor: cannot delete the archive', false, () => deleteDoc(ref(ed)));
// --- Viewer
await check('viewer: getDoc', true, () => getDoc(ref(vw)));
await check('viewer: onSnapshot', true, () => snapOnce(vw));
await check('viewer: transaction save denied', false, () => txSave(vw, pagePayload(VIEWER, 'uid-vw', basePerms)));
await check('viewer: setDoc fallback denied', false, () => setMain(vw, pagePayload(VIEWER, 'uid-vw', basePerms), { merge: true }));
await check('viewer: cannot promote self to editor', false, () => txSave(vw, pagePayload(VIEWER, 'uid-vw', basePerms.map(p => p.email === VIEWER ? { ...p, role: 'edit' } : p))));
await check('viewer: delete denied', false, () => deleteDoc(ref(vw)));
// --- Everyone else
await check('outsider: getDoc denied', false, () => getDoc(ref(out)));
await check('outsider: onSnapshot denied', false, () => snapOnce(out));
await check('outsider: write denied', false, () => setMain(out, pagePayload(OUTSIDER, 'uid-out', [...basePerms, { email: OUTSIDER, role: 'edit' }]), { merge: true }));
await check('signed-out: getDoc denied', false, () => getDoc(ref(anon)));
await check('signed-out: write denied', false, () => setMain(anon, pagePayload(SUPER, 'x', basePerms)));
await check('unverified Super Admin email: getDoc allowed', true, () => getDoc(ref(ctx('uid-super', SUPER, false))));
await check('unverified editor: getDoc denied', false, () => getDoc(ref(ctx('uid-ed', EDITOR, false))));
await check('other collections: denied even for super admin', false, () => getDoc(doc(sup, 'other', 'x')));
await check('archive listing (collection query) denied', false, async () => { const { getDocs } = await import('firebase/firestore'); return getDocs(collection(sup, 'archives')); });
// --- Change log document
await seed();
await check('super admin: getDoc on missing log is allowed', true, () => getDoc(logRef(sup)));
await check('editor: getDoc on missing log is allowed (archive exists)', true, () => getDoc(logRef(ed)));
await check('viewer: getDoc on missing log is allowed (archive exists)', true, () => getDoc(logRef(vw)));
await check('outsider: getDoc on missing log is denied', false, () => getDoc(logRef(out)));
await check('signed-out: getDoc on missing log is denied', false, () => getDoc(logRef(anon)));
await check('super admin: creates log via transaction', true, () => txSaveBoth(sup, pagePayload(SUPER, 'uid-super', basePerms), logPayload(SUPER, 'uid-super')));
await check('super admin: getDoc + onSnapshot of log', true, async () => { await getDoc(logRef(sup)); await snapLogOnce(sup); });
await check('editor: getDoc of log', true, () => getDoc(logRef(ed)));
await check('editor: onSnapshot of log', true, () => snapLogOnce(ed));
await check('editor: update log', true, () => setDoc(logRef(ed), logPayload(EDITOR, 'uid-ed', { events: [{ id: 'chg_1', sequence: 1, summary: 'edit' }], seq: 1 }), { merge: true }));
await check('editor: transaction write of tree + log together', true, () => txSaveBoth(ed, pagePayload(EDITOR, 'uid-ed', basePerms), logPayload(EDITOR, 'uid-ed')));
await check('editor: cannot add unknown fields to log', false, () => setDoc(logRef(ed), { ...logPayload(EDITOR, 'uid-ed'), secret: true }, { merge: true }));
await check('editor: cannot impersonate on log (updatedByUid)', false, () => setDoc(logRef(ed), logPayload(EDITOR, 'uid-super'), { merge: true }));
await check('editor: cannot impersonate on log (updatedByEmail)', false, () => setDoc(logRef(ed), { ...logPayload(EDITOR, 'uid-ed'), updatedByEmail: SUPER }, { merge: true }));
await check('editor: cannot delete the log', false, () => deleteDoc(logRef(ed)));
await check('viewer: getDoc of log', true, () => getDoc(logRef(vw)));
await check('viewer: onSnapshot of log', true, () => snapLogOnce(vw));
await check('viewer: cannot update log', false, () => setDoc(logRef(vw), logPayload(VIEWER, 'uid-vw'), { merge: true }));
await check('viewer: cannot delete log', false, () => deleteDoc(logRef(vw)));
await check('outsider: getDoc of existing log denied', false, () => getDoc(logRef(out)));
await check('outsider: write log denied', false, () => setDoc(logRef(out), logPayload(OUTSIDER, 'uid-out'), { merge: true }));
await check('unverified Super Admin: log get allowed', true, () => getDoc(logRef(ctx('uid-super', SUPER, false))));
await check('unverified editor: log get denied', false, () => getDoc(logRef(ctx('uid-ed', EDITOR, false))));
await check('super admin: can delete the log', true, () => deleteDoc(logRef(sup)));
// Recreate the log after the delete test so later checks (if any) are unaffected
await env.withSecurityRulesDisabled(async c => { await setDoc(logRef(c.firestore()), logPayload(SUPER, 'uid-super')); });
// Editor can create the log when the archive already exists
await check('editor: can create log when archive exists', true, () => deleteDoc(logRef(sup)).then(() => setDoc(logRef(ed), logPayload(EDITOR, 'uid-ed'))));
// Missing archive: editor cannot read/create a log
await env.clearFirestore();
await check('editor: getDoc log denied when archive is missing', false, () => getDoc(logRef(ed)));
await check('editor: cannot create log when archive is missing', false, () => setDoc(logRef(ed), logPayload(EDITOR, 'uid-ed')));
await seed();


// --- Production-like migration: revision >= 3, embedded log still in payloadJson
function embeddedState(revision = 3) {
  const persons = { p1: { id: 'p1', given: 'Alex', surname: 'Rivera', notes: 'x'.repeat(2000) } };
  const families = {};
  const before = { tree: { title: 'Family Tree', revision }, persons, families, accessControl: { permissions: [] } };
  const changeEvents = [];
  for (let i = 5; i >= 1; i--) {
    changeEvents.push({
      id: 'chg_' + i, sequence: i, timestamp: '2026-11-0' + i + ' 10:00',
      actorRole: 'Super Admin', category: 'Tree', summary: 'Edit ' + i,
      reverted: false, beforeSnapshot: before, afterSnapshot: before
    });
  }
  return {
    tree: { id: 'tree-familytree', title: 'Family Tree', revision },
    superAdminEmail: SUPER, persons, families,
    accessControl: { permissions: [
      { email: SUPER, role: 'super_admin' }, { email: EDITOR, role: 'edit' }, { email: VIEWER, role: 'view' }
    ], auditLog: [] },
    changeEvents, changeSequence: 5
  };
}
function liveMainDoc(revision = 3, extra = {}) {
  return {
    title: 'Family Tree', revision, superAdminEmail: SUPER,
    authorizedEmails: [SUPER, EDITOR, VIEWER], editorEmails: [SUPER, EDITOR],
    updatedAt: '2026-11-19T08:00:00.000Z', updatedByEmail: SUPER, updatedByUid: 'uid-super',
    payloadJson: JSON.stringify(embeddedState(revision)), ...extra
  };
}
function migratedMain(email, uid, revision = 3) {
  const state = embeddedState(revision);
  delete state.changeEvents; delete state.changeSequence;
  return {
    title: 'Family Tree', revision, superAdminEmail: SUPER,
    authorizedEmails: [SUPER, EDITOR, VIEWER], editorEmails: [SUPER, EDITOR],
    updatedAt: new Date().toISOString(), updatedByEmail: email.toLowerCase(), updatedByUid: uid,
    payloadJson: JSON.stringify(state)
  };
}
function migratedLog(email, uid, revision = 3) {
  const state = embeddedState(revision);
  return {
    changeLogJson: JSON.stringify({ changeEvents: state.changeEvents, changeSequence: state.changeSequence }),
    updatedAt: new Date().toISOString(), updatedByEmail: email.toLowerCase(), updatedByUid: uid
  };
}
const seedLive = (extra = {}) => env.withSecurityRulesDisabled(async c => { await setDoc(ref(c.firestore()), liveMainDoc(3, extra)); });
const supUnverified = ctx('uid-super', SUPER, false);
const SUPER_MIXED = SUPER.charAt(0).toUpperCase() + SUPER.slice(1, SUPER.indexOf('@')) + SUPER.slice(SUPER.indexOf('@')).replace(/^@(.)/, (m, c) => '@' + c.toUpperCase());
const supUpper = ctx('uid-super', SUPER_MIXED);
const edUpper = ctx('uid-ed', 'Editor@Example.com');

await env.clearFirestore();
await seedLive();
await check('prod-like: SA transaction migrates revision-3 embedded log', true, () => txSaveBoth(sup, migratedMain(SUPER, 'uid-super', 4), migratedLog(SUPER, 'uid-super', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: editor transaction migrates revision-3 embedded log', true, () => txSaveBoth(ed, migratedMain(EDITOR, 'uid-ed', 4), migratedLog(EDITOR, 'uid-ed', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: SA with uppercase token email can migrate', true, () => txSaveBoth(supUpper, migratedMain(SUPER_MIXED, 'uid-super', 4), migratedLog(SUPER_MIXED, 'uid-super', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: unverified SA can migrate', true, () => txSaveBoth(supUnverified, migratedMain(SUPER, 'uid-super', 4), migratedLog(SUPER, 'uid-super', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: editor with uppercase token email can migrate', true, () => txSaveBoth(edUpper, migratedMain('Editor@Example.com', 'uid-ed', 4), migratedLog('Editor@Example.com', 'uid-ed', 3)));

await env.clearFirestore();
await seedLive({ legacyNote: 'present' });
await check('prod-like: SA migrate when main doc has an extra field', true, () => txSaveBoth(sup, migratedMain(SUPER, 'uid-super', 4), migratedLog(SUPER, 'uid-super', 3)));

await env.clearFirestore();
await seedLive({ legacyNote: 'present' });
await check('prod-like: editor migrate when main doc has an extra field', true, () => txSaveBoth(ed, migratedMain(EDITOR, 'uid-ed', 4), migratedLog(EDITOR, 'uid-ed', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: SA migrate re-writing the same revision 3 is denied (revision guard)', false, () => txSaveBoth(sup, migratedMain(SUPER, 'uid-super', 3), migratedLog(SUPER, 'uid-super', 3)));

// --- Production shape after deploy (no adminEmails yet)
await env.clearFirestore();
await seedLive();
await check('prod-like: SA first save after deploy adds adminEmails', true, () => txSaveBoth(sup, { ...migratedMain(SUPER, 'uid-super', 4), adminEmails: [SUPER] }, migratedLog(SUPER, 'uid-super', 3)));
await env.clearFirestore();
await seedLive();
await check('prod-like: editor cannot add adminEmails to an older document', false, () => txSave(ed, { ...migratedMain(EDITOR, 'uid-ed', 4), adminEmails: [SUPER, EDITOR] }));
await env.clearFirestore();
await seedLive();
await check('prod-like: editor may still rename an older document (before adminEmails exists)', true, () => txSave(ed, { ...migratedMain(EDITOR, 'uid-ed', 4), title: 'Renamed by editor' }));

// --- Fix 1: ACL planting
await env.clearFirestore(); await seed();
{
  // An editor may write anything inside payloadJson (it is opaque to the rules)...
  const planted = pagePayload(EDITOR, 'uid-ed', basePerms);
  const st = JSON.parse(planted.payloadJson);
  st.accessControl.permissions = [
    ...st.accessControl.permissions.map(p => p.email === EDITOR ? { ...p, role: 'admin' } : p),
    { email: 'planted@example.com', role: 'edit' },
    { email: 'planted-admin@example.com', role: 'super_admin' }
  ];
  st.superAdminEmail = EDITOR;
  planted.payloadJson = JSON.stringify(st);
  await check('planting: editor payload with planted permissions is stored (payload is opaque)', true, () => txSave(ed, planted));
  // ...but the real lists did not change, and the Super Admin page ignores the plant.
  const stored = await storedMain();
  const state = JSON.parse(stored.payloadJson);
  state.superAdminEmail = stored.superAdminEmail;  // pages take this from the protected field
  const report = reconcilePermissionsWithMainDoc(state, stored, { superAdminEmail: SUPER });
  const lists = computeAccessListsFromPermissions(state.accessControl.permissions, SUPER);
  await check('planting: SA page drops planted emails before its next save', true, async () => {
    if (lists.authorizedEmails.includes('planted@example.com') || lists.editorEmails.includes('planted@example.com')) throw new Error('planted email reached the lists');
    if (lists.adminEmails.includes('planted-admin@example.com') || lists.authorizedEmails.includes('planted-admin@example.com')) throw new Error('planted admin reached the lists');
    if (!report.dropped.includes('planted@example.com')) throw new Error('report did not flag the plant');
  });
  await check('planting: editor self-promotion to admin is reset from adminEmails', true, async () => {
    const mine = state.accessControl.permissions.find(p => p.email === EDITOR);
    if (!mine || mine.role !== 'edit') throw new Error('editor role is ' + (mine && mine.role));
    if (lists.adminEmails.includes(EDITOR)) throw new Error('editor reached adminEmails');
  });
  await check('planting: SA save after an editor plant keeps the real lists', true, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', state.accessControl.permissions.filter(p => p.email !== SUPER)) }));
  const after = await storedMain();
  await check('planting: stored lists still match the Super Admin grants only', true, async () => {
    const want = JSON.stringify([SUPER, ADMIN, EDITOR, VIEWER].sort());
    if (JSON.stringify([...after.authorizedEmails].sort()) !== want) throw new Error('authorizedEmails ' + after.authorizedEmails);
    if (JSON.stringify([...after.adminEmails].sort()) !== JSON.stringify([SUPER, ADMIN].sort())) throw new Error('adminEmails ' + after.adminEmails);
  });
}
await seed();
await check('planting: editor cannot write a planted email into authorizedEmails', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), authorizedEmails: [SUPER, ADMIN, EDITOR, VIEWER, 'planted@example.com'] }));
await check('planting: editor cannot add self to adminEmails', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), adminEmails: [SUPER, ADMIN, EDITOR] }));
await check('planting: editor cannot remove adminEmails', false, async () => { const p = pagePayload(EDITOR, 'uid-ed', basePerms); const { deleteField } = await import('firebase/firestore'); p.adminEmails = deleteField(); return txSave(ed, p); });
await check('planting: editor page frozen lists send the stored lists unchanged', true, async () => {
  const stored = await storedMain();
  const frozen = frozenAccessListsFromMainDoc(stored, SUPER);
  return txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', []), ...frozen });
});

// --- Fix 2: Admin vs edit enforced by the rules (adminEmails)
await seed();
await check('admin-only: editor (edit role) cannot rename the tree', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), title: 'Renamed by editor' }));
await check('admin-only: admin can rename the tree', true, () => txSave(adm, { ...pagePayload(ADMIN, 'uid-adm', basePerms), title: 'Renamed by admin' }));
await check('admin-only: super admin can rename the tree', true, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), title: 'Renamed by super admin' }));
await seed();
await check('admin-only: admin cannot change adminEmails', false, () => txSave(adm, { ...pagePayload(ADMIN, 'uid-adm', basePerms), adminEmails: [SUPER, ADMIN, EDITOR] }));
await check('admin-only: admin cannot grant edit (editorEmails)', false, () => txSave(adm, { ...pagePayload(ADMIN, 'uid-adm', basePerms), editorEmails: [SUPER, ADMIN, EDITOR, VIEWER] }));
await check('admin-only: super admin can promote an editor to admin', true, () => txSave(sup, pagePayload(SUPER, 'uid-super', basePerms.map(p => p.email === EDITOR ? { ...p, role: 'admin' } : p))));
await seed();
await check('admin-only: super admin cannot make an admin who is not an editor', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), adminEmails: [SUPER, ADMIN, VIEWER] }));
await check('admin-only: super admin cannot drop self from adminEmails', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), adminEmails: [ADMIN] }));

// --- Fix 3: server-side revision guard
await seed(basePerms, { revision: 7 });
await check('revision: editor writing stored revision + 1 succeeds', true, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: 8 }));
await check('revision: editor stale write (same revision as stored) denied', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: 8 }));
await check('revision: editor older revision denied', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: 3 }));
await check('revision: editor skipping ahead (+2) denied', false, () => txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: 10 }));
await check('revision: blind setDoc from a stale tab denied', false, () => setDoc(ref(ed), { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: 8 }, { merge: true }));
await check('revision: write without revision change (field omitted) denied', false, async () => { const p = pagePayload(EDITOR, 'uid-ed', basePerms); delete p.revision; return setDoc(ref(ed), p, { merge: true }); });
await check('revision: string revision denied', false, () => setDoc(ref(ed), { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: '9' }, { merge: true }));
await check('revision: super admin stale write denied too', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), revision: 8 }));
await check('revision: super admin stored + 1 succeeds', true, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), revision: 9 }));
await check('revision: two tabs from the same base: second save denied', true, async () => {
  const base = (await storedMain()).revision;
  await txSave(ed, { ...pagePayload(EDITOR, 'uid-ed', basePerms), revision: base + 1 });
  await assertFails(txSave(adm, { ...pagePayload(ADMIN, 'uid-adm', basePerms), revision: base + 1 }));
});
await check('revision: page helper nextArchiveRevision gives stored + 1', true, async () => {
  if (nextArchiveRevision(41, 3) !== 42 || nextArchiveRevision(null, 5) !== 5 || nextArchiveRevision(null, undefined) !== 1) throw new Error('nextArchiveRevision');
});

// --- Fix 4: Super Admin writes are validated and stamped
await seed();
await check('SA path: invalid archive (payloadJson not a string) denied', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), payloadJson: 123 }));
await check('SA path: invalid archive (authorizedEmails not a list) denied', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), authorizedEmails: 'everyone' }));
await check('SA path: invalid archive (title too long) denied', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), title: 'x'.repeat(501) }));
await check('SA path: unknown field denied', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), isAdmin: true }));
await check('SA path: stamping another uid denied', false, () => txSave(sup, pagePayload(SUPER, 'uid-ed', basePerms)));
await check('SA path: stamping another email denied', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), updatedByEmail: EDITOR }));
await check('SA path: removing self from editorEmails denied', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), editorEmails: [ADMIN, EDITOR] }));
await check('SA path: editor not in authorizedEmails denied (inconsistent lists)', false, () => txSave(sup, { ...pagePayload(SUPER, 'uid-super', basePerms), authorizedEmails: [SUPER, ADMIN] }));
await check('SA path: create without stamp denied', false, async () => { await env.clearFirestore(); const p = { ...pagePayload(SUPER, 'uid-other', []), revision: 1 }; return setDoc(ref(sup), p); });
await seed();
await check('SA path: log without stamp denied', false, () => setDoc(logRef(sup), { ...logPayload(SUPER, 'uid-ed') }, { merge: true }));
await check('SA path: log with unknown field denied', false, () => setDoc(logRef(sup), { ...logPayload(SUPER, 'uid-super'), secret: true }, { merge: true }));
await check('SA path: log with non-string changeLogJson denied', false, () => setDoc(logRef(sup), { ...logPayload(SUPER, 'uid-super'), changeLogJson: 5 }, { merge: true }));
await check('SA path: valid stamped log allowed', true, () => setDoc(logRef(sup), logPayload(SUPER, 'uid-super'), { merge: true }));
await env.withSecurityRulesDisabled(async c => { await setDoc(logRef(c.firestore()), { ...logPayload(SUPER, 'uid-super'), legacyNote: 'x' }); });
await check('log: an older log doc with an extra field can still be updated by an editor', true, () => setDoc(logRef(ed), logPayload(EDITOR, 'uid-ed'), { merge: true }));
await check('log: an older log doc with an extra field can still be updated by the SA', true, () => setDoc(logRef(sup), logPayload(SUPER, 'uid-super'), { merge: true }));

await seed();
// --- Super admin delete
await check('super admin: can delete archive', true, () => deleteDoc(ref(sup)));

await env.cleanup();
const fails = results.filter(r => r[0] === 'FAIL');
results.forEach(r => console.log(r.join(' | ')));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
