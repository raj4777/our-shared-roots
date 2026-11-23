import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from './lib/puppeteer.mjs';
import { ROOT, DIST, screenshotOutDir, keepScreenshot } from './app-source.mjs';

const SCREEN = path.join(ROOT, 'screenshots');
const OUT = screenshotOutDir();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};
fs.mkdirSync(SCREEN, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/tree.js'), 'utf8');
assert(html.includes('id="modal-quick-edit"') && html.includes('openQuickEditModal'), 'Quick Edit modal and opener exist');
assert(html.includes('Exactly') && html.includes('Before') && html.includes('After') && html.includes('Circa') && html.includes('Unsure') && html.includes('Between') && html.includes('Free text'), 'date qualifier options are present');
assert(html.includes('Invite to join site') && html.includes('Edit more'), 'invite and Edit more are present');
assert(!/value=[\"']partner[\"']/.test(html) && !html.includes('Your wife') && !html.includes('WIFE:'), 'no partner status or gendered spouse labels');

const fixture = {
  tree: { title: 'Quick Edit demo', id: 'demo', revision: 1 },
  persons: {
    p1: {
      id: 'p1', given: 'Alice', surname: 'Example', prefix: 'Dr.', sex: 'F', livingStatus: 'living',
      emails: ['alice.example@example.com'],
      events: [{ id: 'evb1', type: 'BIRT', date: '4 Jul 1977', place: 'Testville' }]
    },
    p2: {
      id: 'p2', given: 'Bob', surname: 'Example', sex: 'M', livingStatus: 'deceased',
      events: [
        { id: 'evb2', type: 'BIRT', date: 'BET ABT Jan 1970 AND 1972', place: '' },
        { id: 'evd2', type: 'DEAT', date: '2010', place: 'Testville', cause: 'Illness' },
        { id: 'evu2', type: 'BURI', date: '', place: 'Test Cemetery' }
      ]
    }
  },
  families: {
    f1: { id: 'f1', partner1Id: 'p1', partner2Id: 'p2', status: 'married', marriageDate: '12 Jun 1999', marriagePlace: 'Test Harbor' }
  },
  accessControl: { permissions: [] },
  changeEvents: [],
  changeSequence: 0,
  superAdminEmail: 'sa@example.com'
};

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
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/index.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.__TREE, { timeout: 15000 });

const dates = await page.evaluate(() => {
  const T = window.__TREE;
  const round = (s, expect) => ({ in: s, out: T.qeToDateString(T.dateStringToQe(s)), expect });
  return {
    exact: round('4 Jul 1977', 'Jul 4 1977'),
    before: round('BEF 1980', 'BEF 1980'),
    after: T.qeToDateString({ mode: 'AFT', year: 1990, month: '', day: '' }),
    circa: T.qeToDateString({ mode: 'ABT', year: 1977, month: 7, day: 4 }),
    unsure: T.qeToDateString({ mode: 'unsure', year: 1977, month: 7, day: 4 }),
    between: T.qeToDateString({
      mode: 'BET', startQ: 'ABT', year: 1970, month: 1, day: '',
      endQ: 'exact', endYear: 1972, endMonth: '', endDay: ''
    }),
    betweenParsed: T.dateStringToQe('BET ABT Jan 1970 AND BEF 1980'),
    free: T.qeToDateString({ mode: 'free', free: 'spring of 1962' })
  };
});
assert(dates.exact.out === 'Jul 4 1977', 'exact dates store without a qualifier (' + dates.exact.out + ')');
assert(dates.before.out === 'BEF 1980', 'Before stores as BEF');
assert(dates.after === 'AFT 1990', 'After stores as AFT');
assert(dates.circa === 'ABT Jul 4 1977', 'Circa stores as ABT');
assert(dates.unsure === 'ABT Jul 4 1977', 'Unsure aliases Circa/ABT');
assert(dates.between === 'BET ABT Jan 1970 AND 1972', 'Between stores BET … AND … with side qualifiers (' + dates.between + ')');
assert(dates.betweenParsed.mode === 'BET' && dates.betweenParsed.startQ === 'ABT' && dates.betweenParsed.endQ === 'BEF' && dates.betweenParsed.endYear === 1980, 'Between sides keep their own qualifiers');
assert(dates.free === 'spring of 1962', 'Free text stores the raw string');

const ui = await page.evaluate((state) => {
  const T = window.__TREE;
  T.load(state);
  T.setTestWrite?.(() => ({ ok: true }));
  T.openInspector('p1', 'profile');
  T.openQuickEditModal('p1');
  const modal = document.getElementById('modal-quick-edit');
  const given = document.getElementById('qe-given')?.value;
  const surname = document.getElementById('qe-surname')?.value;
  const prefix = document.getElementById('qe-prefix')?.value;
  const sex = document.querySelector('#form-quick-edit input[name="qeSex"]:checked')?.value;
  const living = document.querySelector('#form-quick-edit input[name="qeLiving"]:checked')?.value;
  const birthMode = document.querySelector('[data-qe-date="birth"] [data-qe-mode]')?.value;
  const birthYear = document.querySelector('[data-qe-date="birth"] [data-qe-year]')?.value;
  const place = document.getElementById('qe-birth-place')?.value;
  const email = document.getElementById('qe-email')?.value;
  const andHidden = document.querySelector('[data-qe-date="birth"] [data-qe-and]')?.classList.contains('hidden');
  const deathHidden = document.getElementById('qe-death-fields')?.classList.contains('hidden');
  const spouseHead = document.querySelector('#qe-spouses .text-\\[11px\\]')?.textContent
    || document.querySelector('#qe-spouses')?.innerText || '';
  const statusOpts = [...document.querySelectorAll('[data-qe-union-status] option')].map(o => o.value);
  const panchang = document.querySelector('#qe-panchang [data-hindu-fields]') != null;
  const panchangBtn = document.querySelector('#qe-panchang .js-panchang-details') != null
    || document.querySelector('#qe-panchang [data-hindu-preview]') != null;
  const title = document.getElementById('qe-title')?.textContent;
  return {
    open: modal && !modal.classList.contains('hidden'),
    given, surname, prefix, sex, living, birthMode, birthYear, place, email,
    andHidden, deathHidden, spouseHead, statusOpts, panchang, panchangBtn, title
  };
}, fixture);

assert(ui.open && ui.title === 'Edit profile', 'modal opens as Edit profile');
assert(ui.given === 'Alice' && ui.surname === 'Example' && ui.prefix === 'Dr.', 'name and prefix fill from the person');
assert(ui.sex === 'F' && ui.living === 'living', 'existing sex and living radios are filled');
assert(ui.birthMode === 'exact' && String(ui.birthYear) === '1977' && ui.place === 'Testville', 'birth date and place fill');
assert(ui.email === 'alice.example@example.com', 'living people show the existing email');
assert(ui.andHidden === true, 'the And row is hidden until Between is chosen');
assert(ui.deathHidden === true, 'death fields stay hidden while Living is selected');
assert(/Spouse/.test(ui.spouseHead) && !/wife/i.test(ui.spouseHead) && !/husband/i.test(ui.spouseHead), 'spouse section uses a neutral label (' + ui.spouseHead.slice(0, 80) + ')');
assert(ui.statusOpts.join(',') === 'married,divorced,separated,widowed' && !ui.statusOpts.includes('partner'), 'union status is married, divorced, separated, or widowed (no partner)');
assert(!ui.panchang && !ui.panchangBtn, 'panchang / Hindu date UI is not present in the generic app');

const shot1440 = path.join(OUT, 'quickedit-1440.png');
await page.screenshot({ path: shot1440, fullPage: false });
keepScreenshot(shot1440, 'quickedit-1440.png');
console.log('  wrote ' + shot1440);

const betweenUi = await page.evaluate(() => {
  const mode = document.querySelector('[data-qe-date="birth"] [data-qe-mode]');
  mode.value = 'BET';
  mode.dispatchEvent(new Event('change', { bubbles: true }));
  const andBox = document.querySelector('[data-qe-date="birth"] [data-qe-and]');
  const startQ = document.querySelector('[data-qe-date="birth"] [data-qe-start-q]');
  return {
    andHidden: andBox?.classList.contains('hidden'),
    startQHidden: startQ?.classList.contains('hidden'),
    andLabel: andBox?.innerText?.includes('And')
  };
});
assert(betweenUi.andHidden === false && betweenUi.andLabel === true && betweenUi.startQHidden === false, 'Between reveals an And row with its own qualifier');

const shotBetween = path.join(OUT, 'quickedit-between.png');
await page.screenshot({ path: shotBetween, fullPage: false });
keepScreenshot(shotBetween, 'quickedit-between.png');
console.log('  wrote ' + shotBetween);

const saved = await page.evaluate(() => {
  const T = window.__TREE;
  const given = document.getElementById('qe-given');
  given.value = 'Alicia';
  const year2 = document.querySelector('[data-qe-date="birth"] [data-qe-end-year]');
  year2.value = '1978';
  const startQ = document.querySelector('[data-qe-date="birth"] [data-qe-start-q]');
  if (startQ) startQ.value = 'ABT';
  document.getElementById('form-quick-edit').requestSubmit();
  const p = T.getState().persons.p1;
  const birt = (p.events || []).find(e => e.type === 'BIRT');
  const beforeUndo = { given: p.given, date: birt?.date };
  T.undo();
  const p2 = T.getState().persons.p1;
  const birt2 = (p2.events || []).find(e => e.type === 'BIRT');
  return { beforeUndo, afterUndo: { given: p2.given, date: birt2?.date }, modalClosed: document.getElementById('modal-quick-edit').classList.contains('hidden') };
});
assert(saved.modalClosed, 'OK closes the modal');
assert(saved.beforeUndo.given === 'Alicia' && /^BET /.test(saved.beforeUndo.date) && /1978/.test(saved.beforeUndo.date), 'OK saves name and Between date atomically (' + saved.beforeUndo.date + ')');
assert(saved.afterUndo.given === 'Alice' && saved.afterUndo.date === '4 Jul 1977', 'undo restores name and date together');

const more = await page.evaluate(() => {
  const T = window.__TREE;
  T.openQuickEditModal('p1');
  document.getElementById('btn-qe-more').click();
  const ui = T.getUi();
  return {
    modalClosed: document.getElementById('modal-quick-edit').classList.contains('hidden'),
    inspectorOpen: ui.inspectorOpen,
    tab: ui.inspectorTab,
    hasForm: !!document.getElementById('form-edit-person-profile')
  };
});
assert(more.modalClosed && more.inspectorOpen && more.tab === 'edit' && more.hasForm, 'Edit more closes the modal and opens the detailed Inspector edit form');

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
const mobile = await page.evaluate(() => {
  const T = window.__TREE;
  T.openQuickEditModal('p2');
  const modal = document.getElementById('modal-quick-edit');
  const card = modal.querySelector('.relative');
  const r = card.getBoundingClientRect();
  const deathHidden = document.getElementById('qe-death-fields')?.classList.contains('hidden');
  const livingHidden = document.getElementById('qe-living-fields')?.classList.contains('hidden');
  const cause = document.getElementById('qe-death-cause')?.value;
  const burial = document.getElementById('qe-burial-place')?.value;
  const birthMode = document.querySelector('[data-qe-date="birth"] [data-qe-mode]')?.value;
  const andHidden = document.querySelector('[data-qe-date="birth"] [data-qe-and]')?.classList.contains('hidden');
  return {
    overflow: r.left < -1 || r.top < -1 || r.right > 391 || r.bottom > 845,
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
    deathHidden, livingHidden, cause, burial, birthMode, andHidden
  };
});
assert(mobile.deathHidden === false && mobile.livingHidden === true, 'deceased people show death fields, not email');
assert(mobile.cause === 'Illness' && mobile.burial === 'Test Cemetery', 'death cause and burial fill');
assert(mobile.birthMode === 'BET' && mobile.andHidden === false, 'an existing Between date opens with the And row');
assert(!mobile.overflow, 'modal stays in the 390px viewport (' + JSON.stringify(mobile.rect) + ')');

const shot390 = path.join(OUT, 'quickedit-390.png');
await page.screenshot({ path: shot390, fullPage: false });
keepScreenshot(shot390, 'quickedit-390.png');
console.log('  wrote ' + shot390);

const lock = await page.evaluate(() => {
  const T = window.__TREE;
  T.closeQuickEditModal();
  const calls = [];
  T.setEditLockManager({
    watch() { calls.push('watch'); },
    stop() { calls.push('stop'); },
    lockFor() { return null; },
    async acquire(id) { calls.push('acquire:' + id); return { ok: true }; },
    release(id) { calls.push('release:' + id); }
  });
  T.openQuickEditModal('p1');
  return calls.slice();
});
assert(lock.includes('acquire:p1'), 'opening Quick Edit calls the edit-lock acquire helper (' + lock.join(',') + ')');

assert(errs.length === 0, 'no page errors (' + errs.join(' | ') + ')');

await browser.close();
server.close();
if (failed.length) {
  console.log('FAILED ' + failed.length);
  process.exit(1);
}
console.log('All quick-edit checks passed');
