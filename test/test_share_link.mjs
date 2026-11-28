// Share link, guest (link visitor) view, and "Suggest a change" with admin review (demo data only).
//  - share-core: token strength, link URL, redaction allow-list, suggestion shape/apply
//  - tree page: guest banner, read-only guest UI, hidden living details,
//    inactive-link message, sign-in step before suggesting, suggestion payload,
//    editors refresh the guest copy after a save only when sharing is set up
//  - admin page: Share link card (Super Admin only): create, copy URL,
//    regenerate with confirm (old token deleted), on/off; Suggestions list:
//    approve applies through a normal tree save and records the approver; reject
//    leaves the tree alone
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from './lib/puppeteer.mjs';
import { ROOT, DIST, screenshotOutDir, keepScreenshot } from './app-source.mjs';
import * as SC from '../src/share-core.js';

const OUT = screenshotOutDir();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

// ---------------------------------------------------------------- unit: share-core
const SA = 'owner@example.com', ADMIN = 'admin@example.com';
const fixture = {
  tree: { id: 'demo', title: 'Demo Family', revision: 4 },
  superAdminEmail: SA,
  persons: {
    gp: { id: 'gp', given: 'Victor', surname: 'Example', sex: 'M', livingStatus: 'deceased', village: 'Oldtown', bio: 'Grandpa notes', notes: 'private note', emails: ['victor@example.com'], media: [{ url: 'https://example.com/doc.pdf' }],
      events: [{ id: 'e1', type: 'BIRT', date: '1920', place: 'Oldtown', note: 'hospital record' }, { id: 'e2', type: 'DEAT', date: '1999', place: 'Newtown', cause: 'Illness' }] },
    gm: { id: 'gm', given: 'Rosa', surname: 'Example', altName: 'Sample', sex: 'F', livingStatus: 'deceased', emails: [], events: [{ id: 'e3', type: 'BIRT', date: '1925', place: 'Hilltown' }, { id: 'e4', type: 'DEAT', date: '2005', place: 'Newtown' }] },
    p1: { id: 'p1', given: 'Alex', surname: 'Example', nickname: 'Al', sex: 'M', livingStatus: 'living', emails: ['alex@example.com'], phone: '+1 555 0100', bio: 'Alex bio', village: 'Hometown',
      photoUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/alex.jpg?alt=media&token=y', events: [{ id: 'e5', type: 'BIRT', date: '4 Jul 1977', place: 'Testville' }] },
    p2: { id: 'p2', given: 'Sam', surname: 'Example', sex: 'F', livingStatus: 'living', emails: [], events: [{ id: 'e6', type: 'BIRT', date: '1980', place: 'Seaside' }] },
    k1: { id: 'k1', given: 'Jamie', surname: 'Example', sex: 'F', emails: [], events: [{ id: 'e7', type: 'BIRT', date: '2010', place: 'Seaside' }] }
  },
  families: {
    f0: { id: 'f0', partner1Id: 'gp', partner2Id: 'gm', status: 'married', marriageDate: '1945', marriagePlace: 'Oldtown', children: [{ personId: 'p1', linkage: 'biological' }] },
    f1: { id: 'f1', partner1Id: 'p1', partner2Id: 'p2', status: 'married', marriageDate: '2005', marriagePlace: 'Seaside', children: [{ personId: 'k1', linkage: 'biological' }] }
  },
  accessControl: { permissions: [{ id: 'perm_super_admin', email: SA, role: 'super_admin' }, { id: 'a', email: ADMIN, role: 'admin' }], auditLog: [] },
  changeEvents: [{ id: 'c1', summary: 'secret history' }],
  changeSequence: 1
};

const tokens = new Set(Array.from({ length: 200 }, () => SC.generateShareToken()));
assert(tokens.size === 200, 'share tokens are unique (200 draws)');
const tok = [...tokens][0];
assert(tok.length === 43 && /^[A-Za-z0-9_-]+$/.test(tok) && SC.isWellFormedToken(tok), 'token is 256-bit base64url (43 chars)');
assert(!SC.isWellFormedToken('short') && !SC.isWellFormedToken('x'.repeat(39)), 'short tokens are refused');
assert(SC.buildShareUrl('https://demo.web.app/admin.html#sharing', tok) === 'https://demo.web.app/?t=' + tok, 'share URL points at the tree page with ?t=');
assert(SC.readShareTokenFromUrl('https://demo.web.app/?t=' + tok) === tok && SC.readShareTokenFromUrl('https://demo.web.app/?t=bad') === '', 'token is read from ?t= only when well formed');

const view = SC.redactStateForGuest(fixture);
const viewJson = JSON.stringify(view);
assert(!/@example\.com/.test(viewJson), 'guest view has no email addresses at all');
assert(!viewJson.includes('4 Jul 1977') && !viewJson.includes('Testville') && !viewJson.includes('Seaside'), 'living people: birth dates/places and their marriage date/place are left out');
assert(!viewJson.includes('alex.jpg') && !viewJson.includes('Alex bio') && !viewJson.includes('Hometown') && !viewJson.includes('555'), 'living people: photo, bio, village and phone are left out');
assert(view.persons.p1.given === 'Alex' && view.persons.p1.nickname === 'Al' && view.persons.p1.events.length === 0, 'living people keep their names (and nickname) only');
assert(view.persons.k1.livingStatus === 'living' && view.persons.k1.events.length === 0, 'unknown living status is treated as living');
assert(view.persons.gp.events.length === 2 && view.persons.gp.events[0].date === '1920' && view.persons.gp.events[1].place === 'Newtown', 'deceased people keep dates and places');
assert(!viewJson.includes('hospital record') && !viewJson.includes('Illness') && !viewJson.includes('Grandpa notes') && !viewJson.includes('private note'), 'deceased people: event notes, cause, bio and notes are left out');
assert(view.persons.gp.emails.length === 0 && !viewJson.includes('doc.pdf'), 'deceased people: no contact details or media');
assert(view.persons.gm.altName === 'Sample', 'maiden/birth surname is kept as a name');
assert(SC.redactPersonForGuest({ id: 'd', livingStatus: 'deceased', photoUrl: 'https://firebasestorage.googleapis.com/x' }).photoUrl && !SC.redactPersonForGuest({ id: 'l', livingStatus: 'living', photoUrl: 'https://firebasestorage.googleapis.com/x' }).photoUrl && !SC.redactPersonForGuest({ id: 'd2', livingStatus: 'deceased', photoUrl: 'data:image/png;base64,AAAA' }).photoUrl, 'portrait kept only for the deceased (https links only)');
assert(view.families.f0.marriageDate === '1945' && view.families.f1.marriageDate === '' && view.families.f1.marriagePlace === '', 'marriage date/place only when both partners are deceased');
assert(view.families.f1.children[0].personId === 'k1' && view.families.f0.partner1Id === 'gp', 'relationships and tree structure are kept');
assert(!viewJson.includes('secret history') && !viewJson.includes('permissions') && !viewJson.includes('superAdminEmail'), 'no change log, access lists or Super Admin in the guest view');
const gFields = SC.buildGuestDocFields(fixture, { updatedAt: 'x', updatedByEmail: ADMIN, updatedByUid: 'u' });
assert(Object.keys(gFields).sort().join(',') === 'format,payloadJson,revision,updatedAt,updatedByEmail,updatedByUid', 'guest document has exactly the fields the rules allow');
const back = SC.guestStateFromDoc(gFields);
assert(back && Object.keys(back.persons).length === 5 && back.accessControl.permissions.length === 0, 'guest document round-trips into a renderable state');

const sug = SC.buildSuggestion({ personId: 'p1', field: 'birthPlace', oldValue: 'Testville', newValue: '  Pune  ', note: ' aunt ', email: 'Cousin@Example.com', uid: 'u1' });
assert(JSON.stringify(Object.keys(sug).sort()) === JSON.stringify(['email', 'field', 'newValue', 'note', 'oldValue', 'personId', 'status', 'uid']) && sug.status === 'pending' && sug.email === 'cousin@example.com' && sug.newValue === 'Pune', 'suggestion shape matches the rules (pending, lowercased email, trimmed)');
assert(SC.buildSuggestion({ personId: 'p1', field: 'superAdminEmail', newValue: 'x', email: 'a@b.c', uid: 'u' }).field === 'other', 'unknown field names fall back to "other"');
assert(SC.validateSuggestion({ ...sug, email: '' }) !== '' && SC.validateSuggestion({ ...sug, newValue: '' }) !== '' && SC.validateSuggestion(sug) === '', 'validation needs a Google email and a value');
{
  const st = JSON.parse(JSON.stringify(fixture));
  const r = SC.applySuggestionToState(st, { personId: 'k1', field: 'deathPlace', newValue: 'Riverside' }, { idFactory: p => p + '_t' });
  assert(r.ok && r.applied && st.persons.k1.events.find(e => e.type === 'DEAT').place === 'Riverside', 'applying a suggestion creates the event when missing');
  const r2 = SC.applySuggestionToState(st, { personId: 'p1', field: 'other', newValue: 'Add my sister' });
  assert(r2.ok && !r2.applied, '"other" suggestions are approved without an automatic tree edit');
  const r3 = SC.applySuggestionToState(st, { personId: 'nobody', field: 'given', newValue: 'X' });
  assert(!r3.ok, 'a suggestion for a removed person is not applied');
}

// ---------------------------------------------------------------- pages
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = path.join(DIST, urlPath === '/' ? '/index.html' : urlPath);
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const errs = [];
const shot = async (page, name) => { const p = path.join(OUT, name); await page.screenshot({ path: p }); keepScreenshot(p, name); return p; };
const shots = [];

// Fake store installed in the page (mirrors createShareStore's methods).
const installFakeStore = (hook) => {
  const F = window.__fake = { calls: [], config: null, guestExists: true, guestDoc: null, suggestions: [], denyClaim: false, noGuestDoc: false };
  window[hook].setShareStore({
    async loadConfig() { F.calls.push(['loadConfig']); return F.config; },
    async rotate(a) { F.calls.push(['rotate', a]); F.config = { token: a.newToken, active: a.active }; },
    async setActive(a) { F.calls.push(['setActive', a]); F.config = { ...F.config, active: a.active }; },
    async publishGuestView(fields) { F.calls.push(['publish', fields]); F.guestExists = true; },
    async guestViewExists() { return F.guestExists; },
    async claimToken(uid, token) { F.calls.push(['claim', uid, token]); if (F.denyClaim) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } },
    async loadGuestView() { return F.noGuestDoc ? null : F.guestDoc; },
    async submitSuggestion(s) { F.calls.push(['submit', s]); return 'new-id'; },
    async listSuggestions() { return JSON.parse(JSON.stringify(F.suggestions)); },
    async reviewSuggestion(id, r) { F.calls.push(['review', id, r]); }
  });
};

{
  const page = await browser.newPage();
  page.on('pageerror', e => errs.push('tree: ' + String(e)));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__TREE && window.__TREE.setShareStore, { timeout: 15000 });
  await page.evaluate(installFakeStore, '__TREE');

  // Inactive link: claim refused by the rules -> clear message, nothing loaded.
  const inactive = await page.evaluate(async () => {
    window.__fake.denyClaim = true;
    await window.__TREE.enterGuestView({ uid: 'anon-1' }, 'x'.repeat(43));
    window.__fake.denyClaim = false;
    return { s: window.__TREE.guestSession(), title: document.getElementById('unauth-gate-title').textContent, overlay: !document.getElementById('unauthenticated-overlay').classList.contains('hidden'), people: Object.keys(window.__TREE.getState().persons).length };
  });
  assert(!inactive.s.active && inactive.s.status === 'inactive' && inactive.overlay && /not available/.test(inactive.title) && inactive.people === 0, 'a turned-off or replaced link shows "not available" and loads nothing');

  // Guest view through the real entry path with the fake store.
  const guestDoc = SC.buildGuestDocFields(fixture, { updatedAt: 'x', updatedByEmail: ADMIN, updatedByUid: 'u' });
  const g = await page.evaluate(async (doc) => {
    window.__fake.guestDoc = doc;
    await window.__TREE.enterGuestView({ uid: 'anon-1' }, 'y'.repeat(43));
    await new Promise(r => setTimeout(r, 300));
    const T = window.__TREE, st = T.getState();
    T.openInspector('p1');
    await new Promise(r => setTimeout(r, 400));
    const vis = id => { const el = document.getElementById(id); return Boolean(el && el.offsetWidth > 0 && el.offsetHeight > 0); };
    return {
      s: T.guestSession(), claim: window.__fake.calls.find(c => c[0] === 'claim'),
      banner: vis('readonly-banner') ? document.getElementById('readonly-banner-msg').textContent : '',
      badge: document.getElementById('readonly-banner-badge').textContent,
      bannerBtn: document.getElementById('btn-banner-signin').textContent,
      overlay: vis('unauthenticated-overlay'), cards: document.querySelectorAll('.person-card').length,
      edit: vis('btn-insp-circle-edit'), add: vis('btn-insp-circle-add'), camera: vis('btn-avatar-camera'), suggest: vis('btn-insp-suggest'),
      admin: vis('link-admin-panel'), inspector: (document.getElementById('inspector-body')?.innerText || '') + ' ' + (document.getElementById('inspector-vital-text')?.textContent || ''),
      you: document.querySelectorAll('.you-badge').length, kin: document.getElementById('inspector-kinship-label').textContent,
      canEdit: T.canSuggestChanges(), persons: Object.keys(st.persons).length, emails: JSON.stringify(st).includes('@example.com')
    };
  }, guestDoc);
  assert(g.s.active && g.claim && g.claim[1] === 'anon-1', 'guest visitor claims the token for their own uid before reading');
  assert(g.banner === 'Viewing as guest. Sign in with Google to see full details.' && g.badge === 'Guest' && g.bannerBtn === 'Sign in with Google', 'guest banner: "Viewing as guest. Sign in with Google to see full details."');
  assert(!g.overlay && g.cards >= 4 && g.persons === 5, 'guest sees the tree (names and structure)');
  assert(!g.edit && !g.add && !g.camera && !g.admin, 'guest has no Edit, Add, photo or Admin controls');
  assert(g.suggest && g.canEdit, 'guest sees "Suggest a change" on the person panel');
  assert(!/GOOGLE USER ACCESS|PHOTOS & VIDEOS|BIOGRAPHY/i.test(g.inspector), 'guest panel hides the photos, biography and Google-access sections');
  assert(g.you === 0 && /^Generation /.test(g.kin), 'guest sees no "You" badge or "This is you / Your ..." labels');
  assert(!/1977|Testville|Seaside|alex@/.test(g.inspector) && !g.emails, 'living person panel shows no birth date, place or email in the guest view');
  shots.push(await shot(page, 'bot14-guest-view.png'));

  // Anonymous -> must sign in with Google first.
  const anonStep = await page.evaluate(() => {
    window.__TREE.openSuggestChange('p1');
    return { signin: !document.getElementById('suggest-signin-step').classList.contains('hidden'), form: !document.getElementById('suggest-form').classList.contains('hidden') };
  });
  assert(anonStep.signin && !anonStep.form, 'anonymous visitor is asked to sign in with Google before the form');
  const anonSubmit = await page.evaluate(async () => (await window.__TREE.submitSuggestChange()).ok);
  assert(anonSubmit === false && !(await page.evaluate(() => window.__fake.calls.some(c => c[0] === 'submit'))), 'no suggestion is sent without a Google email');

  // After linking Google (same uid, now with an email) the form opens.
  const form = await page.evaluate(async (doc) => {
    document.getElementById('modal-suggest-change').classList.add('hidden');
    window.__TREE.loadGuest(doc, { email: 'cousin@example.com', uid: 'anon-1' });
    const T = window.__TREE; T.getState().selectedPersonId = 'gp'; T.getUi().inspectorOpen = true; T.renderAll();
    T.openSuggestChange('gp');
    const sel = document.getElementById('suggest-field'); sel.value = 'birthPlace'; sel.dispatchEvent(new Event('change'));
    document.getElementById('suggest-new').value = 'Old Harbor';
    document.getElementById('suggest-note').value = 'His school certificate says Old Harbor.';
    return { form: !document.getElementById('suggest-form').classList.contains('hidden'), current: document.getElementById('suggest-current').textContent, from: document.getElementById('suggest-from').textContent, banner: document.getElementById('readonly-banner-msg').textContent, opts: [...sel.options].map(o => o.value).join(',') };
  }, guestDoc);
  assert(form.form && form.current === 'Oldtown' && form.from === 'Sent as cousin@example.com', 'signed-in visitor gets the form with the current value and their email');
  assert(form.opts === 'given,surname,nickname,altName,birthDate,birthPlace,deathDate,deathPlace,other', 'form offers the fields the rules accept, plus free text');
  assert(/Viewing as guest/.test(form.banner) && /cousin@example\.com/.test(form.banner), 'a Google user not on the lists keeps the guest view, with the banner');
  await new Promise(r => setTimeout(r, 200));
  shots.push(await shot(page, 'bot14-suggest-form.png'));
  const sent = await page.evaluate(async () => { const r = await window.__TREE.submitSuggestChange(); return { r: r.ok, s: (window.__fake.calls.find(c => c[0] === 'submit') || [])[1], closed: document.getElementById('modal-suggest-change').classList.contains('hidden') }; });
  assert(sent.r && sent.closed && sent.s && sent.s.personId === 'gp' && sent.s.field === 'birthPlace' && sent.s.oldValue === 'Oldtown' && sent.s.newValue === 'Old Harbor' && sent.s.email === 'cousin@example.com' && sent.s.uid === 'anon-1' && sent.s.status === 'pending', 'suggestion is written as pending with own email and uid');
  assert(await page.evaluate(() => window.__TREE.getState().persons.gp.events.find(e => e.type === 'BIRT').place === 'Oldtown'), 'sending a suggestion does not change the tree');

  // Editor: normal role, no suggest button, guest copy refreshed only when sharing exists.
  const ed = await page.evaluate(async (fx) => {
    const T = window.__TREE; T.load(fx);
    T.getState().selectedPersonId = 'p1'; T.getUi().inspectorOpen = true; T.renderAll();
    const vis = id => { const el = document.getElementById(id); return Boolean(el && el.offsetWidth > 0); };
    const F = window.__fake; F.calls = [];
    F.guestExists = false; const r0 = await T.refreshGuestViewIfShared();
    F.guestExists = true; const r1 = await T.refreshGuestViewIfShared();
    const pub = F.calls.find(c => c[0] === 'publish');
    return { s: T.guestSession().active, suggest: vis('btn-insp-suggest'), edit: vis('btn-insp-circle-edit'), banner: vis('readonly-banner'), r0: r0.skipped === true, pub: pub ? pub[1] : null };
  }, fixture);
  assert(!ed.s && !ed.suggest && ed.edit && !ed.banner, 'Super Admin / editors keep the normal editing UI (no guest banner, no suggest button)');
  assert(ed.r0 && ed.pub && ed.pub.format === 'guest-v1' && !ed.pub.payloadJson.includes('@example.com') && !ed.pub.payloadJson.includes('1977') && ed.pub.updatedByEmail === SA, 'after a save the guest copy is refreshed (redacted) only when sharing is set up');
  await page.close();
}

{
  const page = await browser.newPage();
  page.on('pageerror', e => errs.push('admin: ' + String(e)));
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/admin.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__ADMIN && typeof window.__ADMIN.installTestSession === 'function', { timeout: 20000 });
  await page.evaluate(installFakeStore, '__ADMIN');
  await page.evaluate((fx) => {
    window.__writes = [];
    window.__ADMIN.setTestWrite(async (m, l) => { window.__writes.push({ m: JSON.parse(JSON.stringify(m)), l: JSON.parse(JSON.stringify(l)) }); return { ok: true }; });
    window.__fake.suggestions = [
      { id: 's1', personId: 'gp', field: 'birthPlace', oldValue: 'Oldtown', newValue: 'Old Harbor', note: 'His school certificate says Old Harbor.', email: 'cousin@example.com', uid: 'anon-1', status: 'pending', createdAt: '2026-11-27T10:15:00Z' },
      { id: 's2', personId: 'p2', field: 'nickname', oldValue: '', newValue: 'Sammy', note: '', email: 'friend@example.com', uid: 'g-2', status: 'pending', createdAt: '2026-11-27T11:40:00Z' },
      { id: 's3', personId: 'p1', field: 'other', oldValue: '', newValue: 'Please add our daughter Riley (born 2015).', note: 'From Alex', email: 'alex@example.com', uid: 'g-3', status: 'pending', createdAt: '2026-11-28T08:05:00Z' }
    ];
    window.__ADMIN.installTestSession({ email: 'owner@example.com', uid: 'uid-owner', state: fx });
    window.__ADMIN.setAdminTab('sharing');
  }, fixture);
  await new Promise(r => setTimeout(r, 400));
  const vis = (id) => page.evaluate((i) => { const el = document.getElementById(i); return Boolean(el && el.offsetWidth > 0 && el.offsetHeight > 0); }, id);
  assert(await vis('share-link-card') && await vis('share-link-empty') && !(await vis('share-link-present')), 'Super Admin sees the Share link card with "Create share link"');
  await page.click('#btn-share-create');
  await new Promise(r => setTimeout(r, 300));
  const created = await page.evaluate(() => ({ url: document.getElementById('share-link-url').value, on: document.getElementById('share-link-active').checked, label: document.getElementById('share-link-active-label').textContent, rot: window.__fake.calls.find(c => c[0] === 'rotate')[1], pub: window.__fake.calls.find(c => c[0] === 'publish') }));
  const t1 = created.rot.newToken;
  assert(SC.isWellFormedToken(t1) && created.rot.oldToken === null && created.rot.active === true && created.rot.uid === 'uid-owner', 'create: a random 256-bit token, link on');
  assert(created.url === `http://127.0.0.1:${PORT}/?t=${t1}` && created.on && created.label === 'On', 'create: the link is shown with the toggle On');
  assert(created.pub && !created.pub[1].payloadJson.includes('@example.com'), 'create: the redacted guest view is published');
  shots.push(await shot(page, 'bot14-admin-share-link.png'));
  // keep a cropped close-up too
  {
    const el = await page.$('#share-link-card');
    const p = path.join(OUT, 'bot14-admin-share-link-card.png'); await el.screenshot({ path: p }); keepScreenshot(p, 'bot14-admin-share-link-card.png');
  }
  await page.click('#btn-share-regenerate');
  const confirm = await page.evaluate(() => ({ open: !document.getElementById('modal-admin-confirm').classList.contains('hidden'), desc: document.getElementById('confirm-modal-desc').textContent, rotations: window.__fake.calls.filter(c => c[0] === 'rotate').length }));
  assert(confirm.open && /stops working immediately/.test(confirm.desc) && confirm.rotations === 1, 'regenerate asks for confirmation first (nothing changed yet)');
  await page.click('#btn-exec-confirm-modal');
  await new Promise(r => setTimeout(r, 300));
  const regen = await page.evaluate(() => { const r = window.__fake.calls.filter(c => c[0] === 'rotate'); return { r: r[r.length - 1][1], url: document.getElementById('share-link-url').value, status: document.getElementById('share-link-status').textContent }; });
  assert(regen.r.oldToken === t1 && regen.r.newToken !== t1 && SC.isWellFormedToken(regen.r.newToken) && regen.url.endsWith('?t=' + regen.r.newToken) && /old link stopped working/.test(regen.status), 'regenerate: new token, old token deleted in the same batch');
  await page.click('#share-link-active');
  await new Promise(r => setTimeout(r, 300));
  const off = await page.evaluate(() => { const r = window.__fake.calls.filter(c => c[0] === 'setActive'); return { a: r[r.length - 1][1], label: document.getElementById('share-link-active-label').textContent }; });
  assert(off.a.active === false && off.a.token === regen.r.newToken && off.label === 'Off', 'toggle: turning the link off');
  await page.click('#share-link-active');
  await new Promise(r => setTimeout(r, 300));
  assert(await page.evaluate(() => document.getElementById('share-link-active-label').textContent === 'On'), 'toggle: turning it back on');

  // Suggestions
  const list = await page.evaluate(() => ({ n: document.querySelectorAll('#suggestions-list .suggestion-item').length, count: document.getElementById('suggestions-pending-count').textContent, text: document.getElementById('suggestions-list').innerText }));
  assert(list.n === 3 && list.count === '3' && /Old Harbor/.test(list.text) && /cousin@example\.com/.test(list.text) && /In the tree now: Oldtown/.test(list.text), 'Suggestions list shows who, what, current and proposed values');
  await page.evaluate(() => document.getElementById('suggestions-card').scrollIntoView());
  await new Promise(r => setTimeout(r, 150));
  {
    const el = await page.$('#suggestions-card');
    const p = path.join(OUT, 'bot14-admin-suggestions.png'); await el.screenshot({ path: p }); keepScreenshot(p, 'bot14-admin-suggestions.png'); shots.push(p);
  }
  assert(await page.evaluate(() => window.__writes.length === 0), 'nothing is written to the tree before approval');
  await page.click('[data-suggestion-approve="s1"]');
  await new Promise(r => setTimeout(r, 400));
  const appr = await page.evaluate(() => {
    const w = window.__writes[window.__writes.length - 1];
    const st = JSON.parse(w.m.payloadJson); const log = JSON.parse(w.l.changeLogJson);
    const ev = log.changeEvents.find(e => /Approved suggestion/.test(e.summary || ''));
    const rv = window.__fake.calls.find(c => c[0] === 'review' && c[1] === 's1');
    return { writes: window.__writes.length, place: st.persons.gp.events.find(e => e.type === 'BIRT').place, summary: ev && (ev.summary || ev.description || ''), by: ev && (ev.userEmail || ev.actorEmail || ev.email || JSON.stringify(ev).match(/owner@example\.com/)?.[0]), rv: rv && rv[2], pending: document.getElementById('suggestions-pending-count').textContent };
  });
  assert(appr.writes === 1 && appr.place === 'Old Harbor', 'approve applies the change through a normal tree save');
  assert(/Approved suggestion from cousin@example\.com/.test(appr.summary) && appr.by === 'owner@example.com', 'approve is recorded in the change log under the approving admin');
  assert(appr.rv && appr.rv.status === 'approved' && appr.rv.email === 'owner@example.com' && appr.rv.uid === 'uid-owner' && appr.pending === '2', 'approve marks the suggestion approved with the approver');
  await page.click('[data-suggestion-reject="s2"]');
  await new Promise(r => setTimeout(r, 300));
  const rej = await page.evaluate(() => ({ writes: window.__writes.length, rv: (window.__fake.calls.find(c => c[0] === 'review' && c[1] === 's2') || [])[2], nick: window.__ADMIN.getState().persons.p2.nickname || '' }));
  assert(rej.writes === 1 && rej.rv && rej.rv.status === 'rejected' && rej.nick === '', 'reject leaves the tree unchanged');
  await page.click('[data-suggestion-approve="s3"]');
  await new Promise(r => setTimeout(r, 300));
  const other = await page.evaluate(() => ({ writes: window.__writes.length, rv: (window.__fake.calls.find(c => c[0] === 'review' && c[1] === 's3') || [])[2] }));
  assert(other.writes === 1 && other.rv && other.rv.status === 'approved', 'free-text suggestions are marked done without an automatic tree edit');

  // An Admin (not Super Admin) reviews suggestions but never sees the share link.
  await page.evaluate((fx) => { window.__ADMIN.installTestSession({ email: 'admin@example.com', uid: 'uid-adm', state: fx }); window.__ADMIN.setAdminTab('sharing'); }, fixture);
  await new Promise(r => setTimeout(r, 300));
  assert(!(await vis('share-link-card')) && await vis('suggestions-card'), 'an Admin sees Suggestions but not the Share link');
  const admTry = await page.evaluate(async () => { const before = window.__fake.calls.filter(c => c[0] === 'rotate').length; await window.__ADMIN.createShareLink(); return window.__fake.calls.filter(c => c[0] === 'rotate').length - before; });
  assert(admTry === 0, 'an Admin cannot create or rotate the share link from the page');
  await page.close();
}

await browser.close();
server.close();
assert(errs.length === 0, 'no page errors (' + errs.join(' | ') + ')');
console.log('screenshots: ' + shots.join(', '));
if (failed.length) { console.log(`\n${failed.length} failed`); process.exit(1); }
console.log('\nall ok');
