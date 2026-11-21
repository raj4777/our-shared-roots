// Regression (public build): one-finger pan and two-finger pinch on phones (iPhone 13 / Pixel 7 emulation),
// plus mouse drag, wheel zoom and tap-to-open still working. Demo data only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from './lib/puppeteer.mjs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIST = path.join(ROOT, 'dist-test'); // test build: has the window.__TREE hook
const readApp = () => ['src/index.html', 'src/tree.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

const DIST = process.env.TOUCH_TEST_DIST || DEFAULT_DIST;
const SHOT = process.env.TOUCH_TEST_SHOT || path.join(ROOT, 'deploy-touch-test', 'touch-pan-390.png');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

if (!process.env.TOUCH_TEST_DIST) {
  const src = readApp('index.html');
  assert(/#canvas-viewport\s*\{\s*touch-action:\s*none;?\s*\}/.test(src), 'canvas viewport keeps touch-action: none');
  assert(src.includes('setPointerCapture') && src.includes('captureOnViewport'), 'pan/pinch capture the pointer on the viewport');
  assert(src.includes('canvasPinnedNodes.has(el)'), 'recull never removes a card under an active press');
  assert(/addEventListener\('touchmove'[\s\S]{0,200}preventDefault\(\)[\s\S]{0,40}passive: false/.test(src), 'non-passive touchmove backstop for iOS Safari');
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
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadDemo() {
  const persons = {}, families = {};
  let n = 0; const gens = [];
  for (let g = 0; g < 7; g++) {
    gens[g] = [];
    const c = g === 0 ? 2 : gens[g - 1].length * 2;
    for (let i = 0; i < Math.min(c, 120); i++) {
      const id = 'p' + (n++);
      persons[id] = { id, given: 'Demo ' + n, surname: 'Sample', sex: i % 2 ? 'F' : 'M', livingStatus: 'deceased', events: [] };
      gens[g].push(id);
    }
  }
  let f = 0;
  for (let g = 0; g < 6; g++) for (let i = 0; i < gens[g].length; i += 2) {
    const kids = gens[g + 1].slice(i, i + 2).map(id => ({ personId: id, linkage: 'biological' }));
    families['f' + f] = { id: 'f' + (f++), partner1Id: gens[g][i], partner2Id: gens[g][i + 1] || null, children: kids };
  }
  window.__TREE.load({ tree: { title: 'Demo tree', id: 'demo', revision: 1 }, persons, families, accessControl: { permissions: [] }, changeEvents: [], changeSequence: 0, superAdminEmail: 'sa@example.com' });
  window.__TREE.getUi().focusMode = false;
  if (window.__TREE.invalidateTreeLayoutCache) window.__TREE.invalidateTreeLayoutCache();
  window.__TREE.renderAll();
  window.__TREE.fitTreeToScreen();
  document.getElementById('toast-banner')?.classList.add('hidden');
  window.__probe = { moves: 0, captured: 0, prevented: 0, detached: 0 };
  const vp = document.getElementById('canvas-viewport');
  window.addEventListener('pointerdown', e => { window.__pressTarget = e.target; }, true);
  window.addEventListener('pointermove', e => { window.__probe.moves++; if (vp.hasPointerCapture && vp.hasPointerCapture(e.pointerId)) window.__probe.captured++; if (window.__pressTarget && !window.__pressTarget.isConnected) window.__probe.detached++; });
  window.addEventListener('touchmove', e => { if (e.defaultPrevented) window.__probe.prevented++; });
}

async function openPage(viewport, ua) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  if (ua) await page.setUserAgent(ua);
  await page.setViewport(viewport);
  await page.goto(`http://127.0.0.1:${PORT}/index.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__TREE, { timeout: 15000 });
  await page.evaluate(loadDemo);
  await sleep(300);
  return { page, errs };
}
const ui = (page) => page.evaluate(() => { const u = window.__TREE.getUi(); return { panX: u.panX, panY: u.panY, zoom: u.zoom }; });
const resetProbe = (page) => page.evaluate(() => { window.__probe = { moves: 0, captured: 0, prevented: 0, detached: 0 }; window.__pressTarget = null; });
const probe = (page) => page.evaluate(() => window.__probe);
// A card fully inside the viewport, preferring one near the given side.
const findCard = (page, side) => page.evaluate((side) => {
  const vr = document.getElementById('canvas-viewport').getBoundingClientRect();
  const cards = [...document.querySelectorAll('[data-person-card]')].map(el => ({ el, b: el.getBoundingClientRect() }))
    .filter(({ b }) => b.left > vr.left + 8 && b.right < vr.right - 8 && b.top > vr.top + 40 && b.bottom < vr.bottom - 90);
  if (!cards.length) return null;
  cards.sort((a, b) => side === 'right' ? b.b.left - a.b.left : a.b.left - b.b.left);
  const { el, b } = cards[0];
  window.__probeCard = el;
  return { id: el.getAttribute('data-person-card'), x: b.left + b.width / 2, y: b.top + b.height * 0.7 };
}, side);

const devices = {
  'iPhone 13': { vp: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'Pixel 7': { vp: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' }
};

for (const [name, d] of Object.entries(devices)) {
  console.log(`-- ${name}`);
  const { page, errs } = await openPage(d.vp, d.ua);
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i, radiusX: 4, radiusY: 4, force: 1 })) });
  const vr = await page.evaluate(() => { const r = document.getElementById('canvas-viewport').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

  // 1. One-finger pan that starts on a card and travels far enough to cull that card.
  const card = await findCard(page, 'right');
  assert(!!card, `${name}: found a card to press`);
  await resetProbe(page);
  const b0 = await ui(page);
  const steps = 60, stepPx = -14; // 840px to the left: the card leaves the 420px overscan
  await touch('touchStart', [[card.x, card.y]]);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[card.x + i * stepPx, card.y + i]]); await sleep(17); }
  const midDrag = await page.evaluate(() => ({ connected: window.__probeCard.isConnected }));
  await touch('touchEnd', []);
  await sleep(120);
  const a0 = await ui(page);
  const p0 = await probe(page);
  assert(Math.abs((a0.panX - b0.panX) - steps * stepPx) <= 2 && Math.abs((a0.panY - b0.panY) - steps) <= 2, `${name}: one-finger pan from a card follows the finger (dx=${Math.round(a0.panX - b0.panX)}, dy=${Math.round(a0.panY - b0.panY)})`);
  assert(midDrag.connected && p0.detached === 0, `${name}: the pressed card is never removed mid-gesture (iOS keeps sending touches to it)`);
  assert(p0.captured >= steps - 2, `${name}: moves are captured on the viewport once the pan starts (${p0.captured}/${p0.moves})`);
  assert(p0.prevented >= steps - 2, `${name}: touchmove default is prevented so Safari cannot scroll/zoom the page (${p0.prevented})`);
  const sel0 = await page.evaluate(() => window.__TREE.getState().selectedPersonId || null);
  assert(sel0 !== card.id, `${name}: a pan that started on a card does not open it`);

  // 2. One-finger pan on empty canvas.
  await page.evaluate(() => window.__TREE.fitTreeToScreen());
  await sleep(100);
  const empty = await page.evaluate(() => {
    const vr = document.getElementById('canvas-viewport').getBoundingClientRect();
    for (let y = vr.top + 50; y < vr.bottom - 100; y += 10) for (let x = vr.left + 10; x < vr.right - 10; x += 10) {
      const el = document.elementFromPoint(x, y);
      if (el && el.id === 'canvas-viewport') return { x, y };
    }
    return null;
  });
  if (empty) {
    const b1 = await ui(page);
    await touch('touchStart', [[empty.x, empty.y]]);
    for (let i = 1; i <= 10; i++) await touch('touchMove', [[empty.x + i * 8, empty.y - i * 6]]);
    await touch('touchEnd', []);
    await sleep(80);
    const a1 = await ui(page);
    assert(Math.round(a1.panX - b1.panX) === 80 && Math.round(a1.panY - b1.panY) === -60, `${name}: one-finger pan on empty canvas moves the tree`);
  }

  // 3. Two-finger pinch zooms in, then out.
  const cx = vr.x + vr.w / 2, cy = vr.y + vr.h / 2;
  const z0 = (await ui(page)).zoom;
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [[cx - 30 - i * 8, cy], [cx + 30 + i * 8, cy]]); await sleep(10); }
  await touch('touchEnd', []);
  await sleep(80);
  const z1 = (await ui(page)).zoom;
  assert(z1 > z0 * 1.5, `${name}: pinch-out zooms in (${z0.toFixed(2)} -> ${z1.toFixed(2)})`);
  await touch('touchStart', [[cx - 100, cy], [cx + 100, cy]]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [[cx - 100 + i * 9, cy], [cx + 100 - i * 9, cy]]); await sleep(10); }
  await touch('touchEnd', []);
  await sleep(80);
  const z2 = (await ui(page)).zoom;
  assert(z2 < z1, `${name}: pinch-in zooms out (${z1.toFixed(2)} -> ${z2.toFixed(2)})`);

  // 4. A tap on a card still opens it.
  await page.evaluate(() => window.__TREE.fitTreeToScreen());
  await sleep(150);
  const tapCard = await findCard(page, 'left');
  await page.touchscreen.tap(tapCard.x, tapCard.y);
  await sleep(250);
  const sel = await page.evaluate(() => window.__TREE.getState().selectedPersonId || null);
  assert(sel === tapCard.id, `${name}: tapping a card opens that person (${sel})`);

  if (name === 'iPhone 13') {
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__TREE.fitTreeToScreen(); document.getElementById('toast-banner')?.classList.add('hidden'); });
    await sleep(100);
    await touch('touchStart', [[cx, cy]]);
    for (let i = 1; i <= 12; i++) await touch('touchMove', [[cx - i * 10, cy - i * 12]]);
    await touch('touchEnd', []);
    await sleep(250);
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
  }
  assert(errs.length === 0, `${name}: no page errors ${errs.slice(0, 2).join(' | ')}`);
  await page.close();
}

// 5. Desktop mouse: drag pans, click opens a card, wheel zooms.
{
  console.log('-- desktop mouse');
  const { page, errs } = await openPage({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const empty = await page.evaluate(() => {
    const vr = document.getElementById('canvas-viewport').getBoundingClientRect();
    for (let y = vr.top + 60; y < vr.bottom - 100; y += 10) for (let x = vr.left + 10; x < vr.right - 10; x += 10) {
      const el = document.elementFromPoint(x, y);
      if (el && el.id === 'canvas-viewport') return { x, y };
    }
    return null;
  });
  const b = await ui(page);
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(empty.x + i * 10, empty.y + i * 5);
  await page.mouse.up();
  await sleep(80);
  const a = await ui(page);
  assert(Math.round(a.panX - b.panX) === 100 && Math.round(a.panY - b.panY) === 50, 'mouse drag pans the tree');
  const z0 = a.zoom;
  await page.mouse.move(640, 400);
  await page.mouse.wheel({ deltaY: -120 });
  await sleep(80);
  assert((await ui(page)).zoom > z0, 'mouse wheel zooms in');
  const c = await findCard(page, 'left');
  await page.mouse.click(c.x, c.y);
  await sleep(200);
  assert(await page.evaluate(() => window.__TREE.getState().selectedPersonId) === c.id, 'mouse click on a card opens it');
  assert(errs.length === 0, 'desktop: no page errors ' + errs.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();
server.close();
if (failed.length) { console.error('\n' + failed.length + ' failed'); process.exit(1); }
console.log('\nAll touch pan tests passed');
