import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './lib/puppeteer.mjs';
import { ROOT, DIST, readApp, hashedAppCss } from './app-source.mjs';

const SCREEN = path.join(ROOT, 'screenshots');
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
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

const html = readApp('index.html');
assert(html.includes('value="foster"') && html.includes('value="guardian"') && html.includes('Foster / Guardian'), 'foster and guardian options and legend exist');
assert(html.includes('function applyUnionOrderSwap'), 'multiple-marriage reorder helper exists');
assert(!/same-sex|same sex union/i.test(html.split('function normalizeLinkage')[1].slice(0, 4000)), 'new relationship work does not add #20 handling');

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

const report = await page.evaluate(() => {
  const T = window.__TREE;
  const state = {
    tree: { title: 'Relationship demo', id: 'demo', revision: 1 },
    persons: {
      p_f: { id: 'p_f', given: 'ZXQFather', surname: 'Reltest', sex: 'M', events: [] },
      p_m1: { id: 'p_m1', given: 'ZXQMotherA', surname: 'Reltest', sex: 'F', events: [] },
      p_m2: { id: 'p_m2', given: 'ZXQMotherB', surname: 'Reltest', sex: 'F', events: [] },
      p_s: { id: 'p_s', given: 'ZXQSon', surname: 'Reltest', sex: 'M', events: [] },
      p_d: { id: 'p_d', given: 'ZXQDaughter', surname: 'Reltest', sex: 'F', events: [] },
      p_w: { id: 'p_w', given: 'ZXQWard', surname: 'Reltest', sex: 'M', events: [] }
    },
    families: {
      u1: { id: 'u1', partner1Id: 'p_f', partner2Id: 'p_m2', marriageDate: '2005', status: 'divorced', unionOrder: 2, children: [] },
      u0: { id: 'u0', partner1Id: 'p_f', partner2Id: 'p_m1', marriageDate: '1990', status: 'married', unionOrder: 1, children: [
        { personId: 'p_s', linkage: 'biological' },
        { personId: 'p_w', linkage: 'foster' }
      ] },
      u2: { id: 'u2', partner1Id: 'p_m2', partner2Id: null, children: [] }
    },
    accessControl: { permissions: [] },
    changeEvents: [],
    changeSequence: 0,
    superAdminEmail: 'sa@example.com'
  };
  // half-siblings: p_s has parents f+m1; p_d has parent m2 only? Need them to share only father.
  // p_d should also be a child of u1 (f + m2)
  state.families.u1.children = [{ personId: 'p_d', linkage: 'biological' }];
  T.load(state);
  T.setTestWrite?.(() => ({ ok: true }));
  const half = T.computeKinship('p_s', 'p_d');
  const foster = T.computeKinship('p_f', 'p_w');
  const fosterChild = T.childRoleLabel('foster');
  const guardian = T.parentRoleLabel('guardian');
  const unionsBefore = T.unionsForPerson('p_f').map(f => f.id);
  T.commitMutation('Reordered marriages', s => T.applyUnionOrderSwap(s, 'p_f', 'u0', 1));
  const unionsAfter = T.unionsForPerson('p_f').map(f => ({ id: f.id, order: f.unionOrder }));
  return {
    half: half && half.title,
    foster: foster && foster.title,
    fosterChild,
    guardian,
    linkages: ['foster', 'guardian', 'nope'].map(T.normalizeLinkage),
    unionsBefore,
    unionsAfter,
    qualify: T.qualifyKinTitle('Son', ['foster'])
  };
});

assert(report.half === 'Half-sister', 'siblings who share one parent are half-siblings');
assert(report.foster === 'Foster son' || report.foster === 'Foster child', 'foster parent/child kinship is labelled');
assert(report.fosterChild === 'Foster child' && report.guardian === 'Guardian', 'foster and guardian role labels exist');
assert(report.linkages.join(',') === 'foster,guardian,biological', 'unknown linkages fall back to biological');
assert(report.unionsBefore[0] === 'u0' && report.unionsAfter[0].id === 'u1' && report.unionsAfter[0].order === 1, 'marriages can be reordered');
assert(report.qualify === 'Foster son', 'qualifyKinTitle supports foster');

await page.evaluate(() => {
  const ui = window.__TREE.getUi();
  ui.accordions = ui.accordions || {};
  ui.accordions.family = true;
  window.__TREE.openInspector('p_f', 'profile');
  document.getElementById('toast-banner')?.classList.add('hidden');
  document.querySelector('#inspector-body [data-search-pick], #inspector-body')?.scrollIntoView({ block: 'center' });
});
await new Promise(r => setTimeout(r, 250));
await page.screenshot({ path: path.join(SCREEN, 'a10-unions-1440.png') });
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.evaluate(() => {
  window.__TREE.openInspector('p_f', 'profile');
  document.querySelector('#inspector-body [data-search-pick], #inspector-body')?.scrollIntoView({ block: 'center' });
});
await new Promise(r => setTimeout(r, 250));
await page.screenshot({ path: path.join(SCREEN, 'a10-linkages-390.png') });

assert(errs.length === 0, 'no page errors: ' + errs.slice(0, 2).join(' | '));
await browser.close();
server.close();
if (failed.length) {
  console.error('\n' + failed.length + ' failed');
  process.exit(1);
}
console.log('\nAll a10 relationship tests passed');
