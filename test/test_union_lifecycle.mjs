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

const src = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8') + '\n'
  + fs.readFileSync(path.join(ROOT, 'src/tree.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(ROOT, 'src/admin.js'), 'utf8');
assert(src.includes("value: 'separated'") || src.includes("value=\"separated\"") || src.includes("'separated'"), 'separated status exists');
assert(src.includes("1 _SEPR") && src.includes("1 _WIDO") && src.includes('1 DIV Y'), 'GEDCOM encodings exist for divorced, separated, and widowed');
assert(!/partner/.test(src.match(/function unionStatusOptionsHtml[\s\S]{0,600}/)?.[0] || ''), 'no partner status in the union select helper');
assert(!src.includes('Your wife') && !src.includes('WIFE:'), 'no gendered spouse labels');

function person(id, given, surname, sex, events) {
  return { id, given, surname, sex, livingStatus: events.some(e => e.type === 'DEAT') ? 'deceased' : 'living', events };
}
function fixture() {
  const persons = {
    pat: person('pat', 'Pat', 'Example', 'U', [{ id: 'bp', type: 'BIRT', date: '1940' }]),
    quin: person('quin', 'Quin', 'Example', 'U', [{ id: 'bq', type: 'BIRT', date: '1942' }]),
    a1: person('a1', 'Ann', 'Example', 'F', [{ id: 'b1', type: 'BIRT', date: '1970' }]),
    a2: person('a2', 'Ben', 'Example', 'M', [{ id: 'b2', type: 'BIRT', date: '1968' }]),
    c1: person('c1', 'Cara', 'Example', 'F', [{ id: 'b3', type: 'BIRT', date: '1972' }]),
    c2: person('c2', 'Dan', 'Example', 'M', [{ id: 'b4', type: 'BIRT', date: '1971' }]),
    e1: person('e1', 'Eve', 'Example', 'F', [{ id: 'b5', type: 'BIRT', date: '1974' }]),
    e2: person('e2', 'Finn', 'Example', 'M', [{ id: 'b6', type: 'BIRT', date: '1975' }]),
    g1: person('g1', 'Gus', 'Example', 'M', [{ id: 'b7', type: 'BIRT', date: '1965' }]),
    g2: person('g2', 'Hana', 'Example', 'F', [{ id: 'b8', type: 'BIRT', date: '1966' }, { id: 'd8', type: 'DEAT', date: '2020' }])
  };
  const child = (id) => ({ personId: id, linkage: 'biological' });
  const families = {
    fp: { id: 'fp', partner1Id: 'pat', partner2Id: 'quin', status: 'married', marriageDate: '1964', marriagePlace: '', children: [child('a1'), child('c1'), child('e1'), child('g1')] },
    fm: { id: 'fm', partner1Id: 'a1', partner2Id: 'a2', status: 'married', marriageDate: '12 Jun 1995', marriagePlace: 'Test Harbor', children: [] },
    fd: { id: 'fd', partner1Id: 'c1', partner2Id: 'c2', status: 'divorced', marriageDate: '4 Jul 1998', marriagePlace: 'Testville', divorceDate: '10 Mar 2005', divorcePlace: 'Testville', children: [] },
    fs: { id: 'fs', partner1Id: 'e1', partner2Id: 'e2', status: 'separated', marriageDate: 'ABT 2001', marriagePlace: '', divorceDate: 'BEF 2010', divorcePlace: 'Oak Place', children: [] },
    fw: { id: 'fw', partner1Id: 'g1', partner2Id: 'g2', status: 'widowed', marriageDate: '1988', marriagePlace: '', children: [] }
  };
  return {
    tree: { title: 'Union lifecycle demo', id: 'demo', revision: 1 },
    persons,
    families,
    accessControl: { permissions: [] },
    changeEvents: [],
    changeSequence: 0,
    superAdminEmail: 'sa@example.com',
    centralPersonId: 'pat'
  };
}

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

const treeReport = await page.evaluate((state) => {
  const T = window.__TREE;
  T.load(state);
  T.setTestWrite?.(() => ({ ok: true }));
  T.fitTreeToScreen?.();
  const styles = {
    married: T.unionLineStyle('married'),
    divorced: T.unionLineStyle('divorced'),
    separated: T.unionLineStyle('separated'),
    widowed: T.unionLineStyle('widowed'),
    unknown: T.unionLineStyle('old-status')
  };
  const lines = {};
  for (const id of ['fm', 'fd', 'fs', 'fw', 'fp']) {
    const node = document.querySelector(`[data-edge-key="union-line:${id}"], [data-edge-key="union-arch:${id}"]`);
    lines[id] = node ? {
      stroke: node.getAttribute('stroke'),
      dash: node.getAttribute('stroke-dasharray') || '',
      key: node.getAttribute('data-edge-key')
    } : null;
  }
  const allEdges = [...document.querySelectorAll('[data-edge-key^="union-line:"], [data-edge-key^="union-arch:"]')].map(n => ({
    edge: n.getAttribute('data-edge-key') || '',
    stroke: n.getAttribute('stroke'),
    dash: n.getAttribute('stroke-dasharray') || ''
  }));

  T.openQuickEditModal('c1');
  const status = document.querySelector('[data-qe-union-status]')?.value;
  const heading = document.querySelector('[data-qe-union-heading]')?.textContent;
  const endHidden = document.querySelector('[data-qe-divorce-fields]')?.classList.contains('hidden');
  const endYear = document.querySelector('[data-qe-date="div-fd"] [data-qe-year]')?.value;
  const endPlace = document.querySelector('[data-qe-divorce-place]')?.value;
  const opts = [...document.querySelectorAll('[data-qe-union-status] option')].map(o => o.value);
  return {
    styles,
    headings: {
      married: T.unionSpouseHeading('married'),
      divorced: T.unionSpouseHeading('divorced'),
      separated: T.unionSpouseHeading('separated'),
      widowed: T.unionSpouseHeading('widowed')
    },
    labels: ['married', 'divorced', 'separated', 'widowed', 'mystery'].map(s => [s, T.normalizeUnionStatus(s)]),
    lines,
    allEdges,
    qe: { status, heading, endHidden, endYear, endPlace, opts }
  };
}, fixture());

assert(treeReport.styles.married.stroke === '#94A3B8' && !treeReport.styles.married.dash, 'married line is solid slate');
assert(treeReport.styles.divorced.stroke === '#DC2626' && treeReport.styles.divorced.dash === '5,4', 'divorced line is dashed red');
assert(treeReport.styles.separated.stroke === '#D97706' && treeReport.styles.separated.dash, 'separated line is dotted amber');
assert(treeReport.styles.widowed.stroke === '#6B7280' && !treeReport.styles.widowed.dash, 'widowed line is solid grey');
assert(treeReport.styles.unknown.stroke === '#94A3B8', 'unknown statuses keep the married style');
assert(treeReport.headings.married === 'Spouse' && treeReport.headings.divorced === 'Former spouse' && treeReport.headings.separated === 'Former spouse' && treeReport.headings.widowed === 'Former spouse', 'spouse headings stay neutral');
assert(JSON.stringify(treeReport.labels) === JSON.stringify([['married','married'],['divorced','divorced'],['separated','separated'],['widowed','widowed'],['mystery','married']]), 'normalizeUnionStatus maps unknown to married');

const canvasStrokes = new Set((treeReport.allEdges.length ? treeReport.allEdges : Object.values(treeReport.lines).filter(Boolean)).map(e => `${e.stroke}|${e.dash || ''}`));
assert(canvasStrokes.has('#94A3B8|') || canvasStrokes.has('#94A3B8|null'), 'canvas draws a married slate line (' + JSON.stringify(treeReport.lines) + ' / ' + JSON.stringify(treeReport.allEdges) + ')');
assert([...canvasStrokes].some(s => s.startsWith('#DC2626')), 'canvas draws a divorced red line');
assert([...canvasStrokes].some(s => s.startsWith('#D97706')), 'canvas draws a separated amber line');
assert([...canvasStrokes].some(s => s.startsWith('#6B7280')), 'canvas draws a widowed grey line');

assert(treeReport.qe.status === 'divorced' && treeReport.qe.heading === 'Former spouse', 'Quick Edit shows divorced with Former spouse');
assert(treeReport.qe.endHidden === false && String(treeReport.qe.endYear) === '2005' && treeReport.qe.endPlace === 'Testville', 'divorce date and place appear for divorced');
assert(treeReport.qe.opts.join(',') === 'married,divorced,separated,widowed', 'Quick Edit offers the four statuses');

const saved = await page.evaluate(() => {
  const T = window.__TREE;
  const sel = document.querySelector('[data-qe-union-status]');
  sel.value = 'separated';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const heading = document.querySelector('[data-qe-union-heading]')?.textContent;
  const endHidden = document.querySelector('[data-qe-divorce-fields]')?.classList.contains('hidden');
  document.getElementById('form-quick-edit').requestSubmit();
  const fam = T.getState().families.fd;
  const before = { status: fam.status, divorceDate: fam.divorceDate, divorcePlace: fam.divorcePlace };
  T.undo();
  const after = T.getState().families.fd;
  return { heading, endHidden, before, after: { status: after.status, divorceDate: after.divorceDate, divorcePlace: after.divorcePlace } };
});
assert(saved.heading === 'Former spouse' && saved.endHidden === false, 'switching to Separated keeps end-date fields and a former-spouse heading');
assert(saved.before.status === 'separated', 'OK saves separated');
assert(saved.after.status === 'divorced' && saved.after.divorceDate === '10 Mar 2005', 'undo restores union status and end date atomically');

// Screenshots: reopen QE on Eve (separated) and scroll the spouse / end-date block into view
await page.evaluate(() => {
  const T = window.__TREE;
  T.closeQuickEditModal();
  T.openQuickEditModal('e1');
  const spouses = document.getElementById('qe-spouses');
  if (spouses) spouses.scrollIntoView({ block: 'center' });
});
await new Promise(r => setTimeout(r, 150));
const qeShot = path.join(OUT, 'phase2-quickedit.png');
await page.screenshot({ path: qeShot, fullPage: false });
keepScreenshot(qeShot, 'phase2-quickedit.png');
console.log('  wrote ' + qeShot);

await page.evaluate(() => {
  const T = window.__TREE;
  T.closeQuickEditModal();
  const close = document.getElementById('btn-close-inspector');
  if (close) close.click();
  const toast = document.getElementById('toast-banner');
  if (toast) toast.classList.add('hidden');
  T.fitTreeToScreen?.();
});
await new Promise(r => setTimeout(r, 200));
const canvasShot = path.join(OUT, 'phase2-canvas.png');
await page.screenshot({ path: canvasShot, fullPage: false });
keepScreenshot(canvasShot, 'phase2-canvas.png');
console.log('  wrote ' + canvasShot);

const legend = await page.evaluate(() => {
  const pill = document.getElementById('canvas-legend-pill');
  return { text: pill?.innerText || '', hidden: pill?.classList.contains('hidden') || pill?.classList.contains('auth-hidden') };
});
assert(/Married/.test(legend.text) && /Divorced/.test(legend.text) && /Separated/.test(legend.text) && /Widowed/.test(legend.text), 'canvas legend lists the four union styles (' + legend.text + ')');

// GEDCOM round-trip on admin
await page.goto(`http://127.0.0.1:${PORT}/admin.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.__ADMIN, { timeout: 20000 });
const ged = await page.evaluate((state) => {
  const A = window.__ADMIN;
  A.installTestSession({ email: 'sa@example.com', uid: 'test-uid', state });
  const text = A.serializeArchiveToGedcom('7.0', false);
  const parsed = A.parseGedcomArchiveText(text);
  const byPair = {};
  for (const fam of Object.values(parsed.families || {})) {
    const p1 = parsed.persons[fam.partner1Id];
    const p2 = parsed.persons[fam.partner2Id];
    const names = [p1?.given, p2?.given].filter(Boolean).sort().join('+');
    byPair[names] = {
      status: fam.status,
      marriageDate: fam.marriageDate,
      marriagePlace: fam.marriagePlace,
      divorceDate: fam.divorceDate || '',
      divorcePlace: fam.divorcePlace || ''
    };
  }
  const divCount = (text.match(/^1 DIV Y$/gm) || []).length;
  const seprCount = (text.match(/^1 _SEPR Y$/gm) || []).length;
  const widoCount = (text.match(/^1 _WIDO Y$/gm) || []).length;
  return { text, byPair, divCount, seprCount, widoCount, familyCount: parsed.familyCount };
}, fixture());

assert(ged.divCount === 1 && ged.seprCount === 1 && ged.widoCount === 1, 'export writes one DIV, one _SEPR, and one _WIDO (' + [ged.divCount, ged.seprCount, ged.widoCount].join(',') + ')');
assert(ged.text.includes('1 _SEPR Y') && !/1 _SEPR[\s\S]{0,40}1 DIV/.test(ged.text), 'separated unions are encoded as _SEPR, not DIV');
assert(ged.byPair['Ann+Ben']?.status === 'married' && ged.byPair['Ann+Ben']?.marriageDate === '12 Jun 1995', 'married round-trips');
assert(ged.byPair['Cara+Dan']?.status === 'divorced' && ged.byPair['Cara+Dan']?.divorceDate === '10 Mar 2005' && ged.byPair['Cara+Dan']?.divorcePlace === 'Testville', 'divorced date/place round-trip: ' + JSON.stringify(ged.byPair['Cara+Dan']));
assert(ged.byPair['Eve+Finn']?.status === 'separated' && ged.byPair['Eve+Finn']?.divorceDate === 'BEF 2010' && ged.byPair['Eve+Finn']?.divorcePlace === 'Oak Place', 'separated _SEPR date/place round-trip: ' + JSON.stringify(ged.byPair['Eve+Finn']));
assert(ged.byPair['Gus+Hana']?.status === 'widowed', 'widowed _WIDO round-trips: ' + JSON.stringify(ged.byPair['Gus+Hana']));

assert(errs.length === 0, 'no page errors (' + errs.join(' | ') + ')');

await browser.close();
server.close();
if (failed.length) {
  console.log('FAILED ' + failed.length);
  process.exit(1);
}
console.log('All union-lifecycle checks passed');
