import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, runTransaction, onSnapshot, collection } from 'firebase/firestore';
import fs from 'node:fs';

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
function pagePayload(email, uid, perms, extra = {}) {
  const superEmail = SUPER;
  const auth = new Set([superEmail]), edit = new Set([superEmail]);
  perms.forEach(p => { auth.add(p.email); if (['super_admin', 'admin', 'edit'].includes(p.role)) edit.add(p.email); });
  const state = { tree: { title: 'Family Tree', revision: 1 }, superAdminEmail: superEmail, persons: { p1: { id: 'p1', given: 'Alex' } }, families: {}, accessControl: { permissions: perms, auditLog: [] }, changeEvents: [], changeSequence: 1, ...extra.state };
  return { title: 'Family Tree', revision: 1, superAdminEmail: superEmail, authorizedEmails: [...auth], editorEmails: [...edit],
    updatedAt: new Date().toISOString() + Math.random(), updatedByEmail: email.toLowerCase(), updatedByUid: uid, payloadJson: JSON.stringify(state), ...extra.meta };
}
const basePerms = [{ email: ADMIN, role: 'admin' }, { email: EDITOR, role: 'edit' }, { email: VIEWER, role: 'view' }];
const ctx = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const ref = db => doc(db, 'archives', ARCHIVE_ID);
const logRef = db => doc(db, 'archives', ARCHIVE_LOG_ID);
const txSave = (db, payload) => runTransaction(db, async tx => { await tx.get(ref(db)); tx.set(ref(db), payload, { merge: true }); });
const txSaveBoth = (db, main, log) => runTransaction(db, async tx => { await tx.get(ref(db)); await tx.get(logRef(db)); tx.set(ref(db), main, { merge: true }); tx.set(logRef(db), log, { merge: true }); });
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
const seed = async (perms = basePerms) => env.withSecurityRulesDisabled(async c => { await setDoc(ref(c.firestore()), pagePayload(SUPER, 'uid-super', perms)); });

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
await check('super admin: setDoc merge fallback save', true, () => setDoc(ref(sup), pagePayload(SUPER, 'uid-super', basePerms), { merge: true }));
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
await check('editor: setDoc merge fallback save', true, () => setDoc(ref(ed), pagePayload(EDITOR, 'uid-ed', basePerms), { merge: true }));
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
await check('viewer: setDoc fallback denied', false, () => setDoc(ref(vw), pagePayload(VIEWER, 'uid-vw', basePerms), { merge: true }));
await check('viewer: cannot promote self to editor', false, () => txSave(vw, pagePayload(VIEWER, 'uid-vw', basePerms.map(p => p.email === VIEWER ? { ...p, role: 'edit' } : p))));
await check('viewer: delete denied', false, () => deleteDoc(ref(vw)));
// --- Everyone else
await check('outsider: getDoc denied', false, () => getDoc(ref(out)));
await check('outsider: onSnapshot denied', false, () => snapOnce(out));
await check('outsider: write denied', false, () => setDoc(ref(out), pagePayload(OUTSIDER, 'uid-out', [...basePerms, { email: OUTSIDER, role: 'edit' }]), { merge: true }));
await check('signed-out: getDoc denied', false, () => getDoc(ref(anon)));
await check('signed-out: write denied', false, () => setDoc(ref(anon), pagePayload(SUPER, 'x', basePerms)));
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
const supUpper = ctx('uid-super', 'Owner@Example.com');
const edUpper = ctx('uid-ed', 'Editor@Example.com');

await env.clearFirestore();
await seedLive();
await check('prod-like: SA transaction migrates revision-3 embedded log', true, () => txSaveBoth(sup, migratedMain(SUPER, 'uid-super', 3), migratedLog(SUPER, 'uid-super', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: editor transaction migrates revision-3 embedded log', true, () => txSaveBoth(ed, migratedMain(EDITOR, 'uid-ed', 3), migratedLog(EDITOR, 'uid-ed', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: SA with uppercase token email can migrate', true, () => txSaveBoth(supUpper, migratedMain('Owner@Example.com', 'uid-super', 3), migratedLog('Owner@Example.com', 'uid-super', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: unverified SA can migrate', true, () => txSaveBoth(supUnverified, migratedMain(SUPER, 'uid-super', 3), migratedLog(SUPER, 'uid-super', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: editor with uppercase token email can migrate', true, () => txSaveBoth(edUpper, migratedMain('Editor@Example.com', 'uid-ed', 3), migratedLog('Editor@Example.com', 'uid-ed', 3)));

await env.clearFirestore();
await seedLive({ legacyNote: 'present' });
await check('prod-like: SA migrate when main doc has an extra field', true, () => txSaveBoth(sup, migratedMain(SUPER, 'uid-super', 3), migratedLog(SUPER, 'uid-super', 3)));

await env.clearFirestore();
await seedLive({ legacyNote: 'present' });
await check('prod-like: editor migrate when main doc has an extra field', true, () => txSaveBoth(ed, migratedMain(EDITOR, 'uid-ed', 3), migratedLog(EDITOR, 'uid-ed', 3)));

await env.clearFirestore();
await seedLive();
await check('prod-like: SA migrate writing revision 4', true, () => txSaveBoth(sup, migratedMain(SUPER, 'uid-super', 4), migratedLog(SUPER, 'uid-super', 4)));

await seed();
// --- Super admin delete
await check('super admin: can delete archive', true, () => deleteDoc(ref(sup)));

await env.cleanup();
const fails = results.filter(r => r[0] === 'FAIL');
results.forEach(r => console.log(r.join(' | ')));
console.log(`\n${results.length - fails.length}/${results.length} passed (Option B on)`);
process.exit(fails.length ? 1 : 0);
