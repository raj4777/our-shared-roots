// Startup must survive a page whose HTML lacks an optional menu button.
// On 2026-11-22 an outside edit removed the "Evidence & Citations" button
// (#btn-open-evidence-menu) from index.html; initEvents() then threw a
// TypeError and every listener after it was never wired. This serves the
// built page with that button stripped and checks startup still finishes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from './lib/puppeteer.mjs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_DIST = path.join(ROOT, 'dist');
const DIST = path.join(ROOT, 'dist-test'); // test build: has the window.__TREE hook

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const BUTTON_RE = /\s*<button id="btn-open-evidence-menu"[\s\S]*?<\/button>/;
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}
function serve(root) {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(root, urlPath);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      if (urlPath === '/index.html') data = Buffer.from(String(data).replace(BUTTON_RE, ''));
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

const original = fs.readFileSync(path.join(PROD_DIST, 'index.html'), 'utf8');
assert(BUTTON_RE.test(original), 'built index.html has the Evidence & Citations button (so stripping it is meaningful)');

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  for (const [label, root] of [['production dist', PROD_DIST], ['test build', DIST]]) {
    const server = serve(root);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const ALLOWED = new Set([`127.0.0.1:${PORT}`, 'www.gstatic.com', 'cdn.tailwindcss.com']);
    const p = await browser.newPage();
    const errors = [];
    await p.setRequestInterception(true);
    p.on('request', (req) => { if (ALLOWED.has(new URL(req.url()).host)) req.continue(); else req.abort(); });
    p.on('pageerror', (err) => errors.push(String(err)));
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1000));
    const info = await p.evaluate(() => ({
      button: !!document.getElementById('btn-open-evidence-menu'),
      deleteBtn: !!document.getElementById('btn-delete-person'),
      hooks: typeof window.__TREE,
      text: document.body.innerText
    }));
    assert(!info.button, `${label}: page served without the button`);
    assert(info.deleteBtn, `${label}: neighbouring Remove button still present`);
    assert(errors.length === 0, `${label}: starts without uncaught errors ${errors.join(' | ')}`);
    assert(info.text.includes('Sign in'), `${label}: renders the sign-in screen`);
    if (label === 'test build') {
      // window.__TREE is assigned after initEvents() returns, so it only exists
      // if startup ran past the listener wiring.
      assert(info.hooks === 'object', `${label}: startup finished past initEvents (window.__TREE is set)`);
    }
    await p.close();
    server.close();
  }
} finally {
  await browser.close();
}
if (failed.length) { console.log('FAILED ' + failed.length); process.exit(1); }
console.log('PASS page starts with the Evidence & Citations button missing');
