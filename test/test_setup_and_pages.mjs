import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './lib/puppeteer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'deploy-demo-family-tree');
const CFG = path.join(ROOT, 'test/fake-firebase-config.json');
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

// --- setup: invalid email ---
{
  const r = await run('node', ['setup.mjs', '--project-id', 'demo-family-tree', '--super-admin', 'not-an-email', '--firebase-config', CFG, '--out', path.join(ROOT, 'deploy-should-not-exist')]);
  assert(r.code !== 0 && /invalid email/i.test(r.stderr), 'rejects an invalid Super Admin email');
}

// --- setup: emails that could break out of the rules string ---
for (const bad of ["x'||true||'@example.com", 'a\\b@example.com', 'owner@example', 'Owner <owner@example.com>', "o'neil@example.com"]) {
  const r = await run('node', ['setup.mjs', '--project-id', 'demo-family-tree', '--super-admin', bad, '--firebase-config', CFG, '--out', path.join(ROOT, 'deploy-should-not-exist')]);
  assert(r.code !== 0 && /invalid email/i.test(r.stderr), 'rejects unsafe Super Admin email ' + JSON.stringify(bad));
}
assert(!fs.existsSync(path.join(ROOT, 'deploy-should-not-exist')), 'rejected setups write nothing');

// --- setup: invalid Firestore location (would be injected into firebase.json) ---
{
  const r = await run('node', ['setup.mjs', '--project-id', 'demo-family-tree', '--super-admin', 'owner@example.com', '--location', 'nam5","x":"y', '--firebase-config', CFG, '--out', path.join(ROOT, 'deploy-should-not-exist')]);
  assert(r.code !== 0 && /firestore location/i.test(r.stderr), 'rejects an unsafe Firestore location');
}

// --- setup: invalid project id ---
{
  const r = await run('node', ['setup.mjs', '--project-id', 'BAD_ID', '--super-admin', 'owner@example.com', '--firebase-config', CFG, '--out', path.join(ROOT, 'deploy-should-not-exist')]);
  assert(r.code !== 0 && /project id/i.test(r.stderr), 'rejects an invalid project ID');
}

// --- build ---
{
  const build = await run('npm', ['run', 'build']);
  assert(build.code === 0, 'npm run build succeeds: ' + (build.stderr || build.stdout).slice(-300));
  assert(fs.existsSync(path.join(ROOT, 'dist/index.html')), 'writes dist/index.html');
  assert(fs.existsSync(path.join(ROOT, 'dist/theme-boot.js')), 'copies theme-boot.js into dist');
  const assets = fs.existsSync(path.join(ROOT, 'dist/assets')) ? fs.readdirSync(path.join(ROOT, 'dist/assets')) : [];
  assert(assets.some((f) => /^app\.[A-Za-z0-9_-]+\.css$/.test(f)), 'emits hashed app.[hash].css');
  assert(assets.some((f) => f.endsWith('.js')), 'emits hashed JavaScript modules');
  for (const name of ['index.html', 'admin.html', 'migrate-log.html', 'offline.html', '404.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'dist', name), 'utf8');
    assert(!/<script(?![^>]*src=)/.test(html), name + ' has no inline script (CSP-safe)');
    assert(html.includes('/theme-boot.js') && html.includes('/config.js') && html.includes('/config-boot.js'), name + ' loads config and theme boot scripts');
  }
  const treeHtml = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(ROOT, 'dist/admin.html'), 'utf8');
  assert(treeHtml.includes('id="btn-theme-toggle"') && adminHtml.includes('id="btn-theme-toggle"'), 'tree and admin headers have the theme toggle');
  const sw = fs.readFileSync(path.join(ROOT, 'dist/sw.js'), 'utf8');
  assert(sw.includes("CACHE_VERSION = 'osr-pwa-v6'"), 'service worker cache is osr-pwa-v6');
  assert(/\/assets\/app\.[A-Za-z0-9_-]+\.css/.test(sw), 'service worker precaches hashed CSS');
  assert(sw.includes('/theme-boot.js') && sw.includes('/404.html') && sw.includes('/'), 'service worker precaches boot, 404, and /');
  assert(sw.includes("NEVER_CACHE_PATHS = ['/config.js', '/sw.js']") && sw.includes('isNeverCachePath(url)'), 'service worker never caches /config.js or sw.js');
  const precacheBlock = (sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/) || [])[1] || '';
  assert(precacheBlock && !precacheBlock.includes("'/config.js'"), 'precache list does not include /config.js');
}

// --- generate ---
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
const gen = await run('node', [
  'setup.mjs',
  '--project-id', 'demo-family-tree',
  '--super-admin', 'owner@example.com',
  '--firebase-config', CFG,
  '--site-title', 'Harbor Family',
  '--location', 'nam5',
  '--archive-id', 'familytree',
  '--out', OUT
]);
assert(gen.code === 0, 'setup succeeds non-interactively: ' + (gen.stderr || gen.stdout).slice(0, 200));
assert(fs.existsSync(path.join(OUT, 'dist/config.js')), 'writes dist/config.js');
assert(fs.existsSync(path.join(OUT, 'firestore.rules')), 'writes firestore.rules');
assert(fs.existsSync(path.join(OUT, 'firebase.json')), 'writes firebase.json');
assert(fs.existsSync(path.join(OUT, '.firebaserc')), 'writes .firebaserc');
assert(fs.existsSync(path.join(OUT, 'dist/index.html')), 'copies the built tree page');
assert(fs.existsSync(path.join(OUT, 'dist/admin.html')), 'copies the built admin page');

const cfgJs = fs.readFileSync(path.join(OUT, 'dist/config.js'), 'utf8');
assert(cfgJs.includes('owner@example.com') && cfgJs.includes('Harbor Family') && cfgJs.includes('familytree'), 'config.js contains the provided values');
const banned = [('raje'+'ndra'), ('gole'+'gaonkar'), ('our'+'shared'+'roots')];
assert(!banned.some((w) => cfgJs.toLowerCase().includes(w)), 'generated config.js has no personal production values');

const rules = fs.readFileSync(path.join(OUT, 'firestore.rules'), 'utf8');
assert(rules.includes("return 'owner@example.com';"), 'rules embed the Super Admin email');
assert((rules.match(/'owner@example\.com'/g) || []).length === 1, 'Super Admin email appears exactly once as a rules string');
assert(rules.includes('function revisionAdvances()') && rules.includes('adminEmails'), 'rules include the revision guard and adminEmails');
assert(rules.includes('match /archives/familytree {') && rules.includes('match /archives/familytree_log {'), 'rules use the chosen archive IDs');
assert(rules.includes('match /archives/familytree_guest {') && rules.includes('match /shareLinks/{token}'), 'rules include the guest view and share-link documents');
assert(!rules.includes('__SUPER_ADMIN_EMAIL__') && !rules.includes('__ARCHIVE_ID__'), 'no unfilled placeholders in rules');

const fb = JSON.parse(fs.readFileSync(path.join(OUT, 'firebase.json'), 'utf8'));
assert(fb.firestore.location === 'nam5', 'firebase.json uses the chosen location');
assert(fb.hosting && fb.hosting.public === 'dist', 'firebase.json hosting public is dist');
assert(fb.hosting && Array.isArray(fb.hosting.rewrites), 'firebase.json keeps hosting rewrites');
const csp = ((fb.hosting.headers || []).find((h) => h.source === '**')?.headers || []).find((h) => h.key === 'Content-Security-Policy');
const scriptSrc = ((csp && csp.value) || '').split('style-src')[0];
assert(csp && !scriptSrc.includes("'unsafe-inline'"), 'script-src does not allow unsafe-inline');
assert(/style-src 'self' 'unsafe-inline'/.test((csp && csp.value) || ''), 'style-src still allows unsafe-inline');
assert((fb.hosting.headers || []).some((h) => h.source === '/assets/**' && JSON.stringify(h).includes('31536000')), 'hashed /assets/** are cached immutably');

const rc = JSON.parse(fs.readFileSync(path.join(OUT, '.firebaserc'), 'utf8'));
assert(rc.projects.default === 'demo-family-tree', '.firebaserc has the project ID');

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'dist/manifest.webmanifest'), 'utf8'));
assert(manifest.name === 'Harbor Family', 'manifest name is the site title');

// --- refuse overwrite without --force ---
{
  const r = await run('node', ['setup.mjs', '--project-id', 'demo-family-tree', '--super-admin', 'owner@example.com', '--firebase-config', CFG, '--out', OUT]);
  assert(r.code !== 0 && /already exists/i.test(r.stderr + r.stdout), 'refuses to overwrite without --force');
}

// --- serve and load pages ---
const PUBLIC = path.join(OUT, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const expectedNoise = /firebase|auth|firestore|identitytoolkit|googleapis|failed to fetch|networkerror|err_failed|err_aborted|service worker|manifest|favicon|403|401|404|400|unauthenticated|api-key|invalid.api|installations|securetoken|measurement/i;

async function loadPage(pathname, pick) {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(origin + pathname, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));
  const info = await page.evaluate(pick);
  const unexpected = [...errors, ...consoleErrors].filter(t => !expectedNoise.test(t));
  await browser.close();
  return { info, unexpected, errors, consoleErrors };
}

const tree = await loadPage('/index.html', () => ({
  title: document.title,
  header: document.getElementById('header-tree-title') && document.getElementById('header-tree-title').textContent.trim(),
  hasConfig: !!(window.OSR_CONFIG && window.OSR_CONFIG.firebase),
  siteTitle: window.OSR_CONFIG && window.OSR_CONFIG.siteTitle,
  superAdmin: window.OSR_CONFIG && window.OSR_CONFIG.superAdminEmail,
  archiveId: window.OSR_CONFIG && window.OSR_CONFIG.archiveId,
  firebaseKey: window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey,
  hasThemeToggle: !!document.getElementById('btn-theme-toggle'),
  dataTheme: document.documentElement.getAttribute('data-theme')
}));
assert(tree.info.hasConfig && tree.info.siteTitle === 'Harbor Family', 'tree page loads OSR_CONFIG');
assert(tree.info.superAdmin === 'owner@example.com' && tree.info.archiveId === 'familytree', 'tree page sees Super Admin and archive id');
assert(tree.info.firebaseKey === 'test-api-key-not-real', 'tree page applies FIREBASE_CONFIG from OSR_CONFIG');
assert(tree.info.header === 'Harbor Family' || tree.info.title.includes('Harbor Family'), 'tree page shows the site title');
assert(tree.info.hasThemeToggle, 'tree page has the theme toggle in the header');
assert(tree.unexpected.length === 0, 'tree page has no unexpected console errors: ' + tree.unexpected.slice(0, 3).join(' | '));

const admin = await loadPage('/admin.html', () => ({
  title: document.title,
  name: document.getElementById('admin-tree-name') && document.getElementById('admin-tree-name').textContent.trim(),
  hasConfig: !!(window.OSR_CONFIG && window.OSR_CONFIG.siteTitle === 'Harbor Family'),
  superAdmin: window.OSR_CONFIG && window.OSR_CONFIG.superAdminEmail
}));
assert(admin.info.hasConfig && admin.info.superAdmin === 'owner@example.com', 'admin page loads OSR_CONFIG');
assert((admin.info.name === 'Harbor Family') || admin.info.title.includes('Harbor Family'), 'admin page shows the site title');
assert(admin.unexpected.length === 0, 'admin page has no unexpected console errors: ' + admin.unexpected.slice(0, 3).join(' | '));

// --- service worker must not store /config.js (Hosting serves it no-store) ---
{
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const swInfo = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 4000); });
    }
    await fetch('/config.js?probe=1').catch(() => null);
    await fetch('/config.js').catch(() => null);
    await fetch('/theme-boot.js').catch(() => null);
    await new Promise((r) => setTimeout(r, 500));
    const names = await caches.keys();
    const urls = [];
    for (const n of names) { const c = await caches.open(n); (await c.keys()).forEach((q) => urls.push(new URL(q.url).pathname)); }
    return { supported: true, controlled: !!navigator.serviceWorker.controller, names, urls };
  });
  await browser.close();
  assert(swInfo.supported && swInfo.names.includes('osr-pwa-v6'), 'service worker installs cache osr-pwa-v6: ' + JSON.stringify(swInfo.names));
  assert(swInfo.controlled, 'service worker controls the page');
  assert(swInfo.urls.length > 0 && !swInfo.urls.includes('/config.js'), 'Cache Storage never holds /config.js (' + swInfo.urls.length + ' cached URLs)');
}

server.close();
if (failed.length) {
  console.error('FAILED', failed);
  process.exit(1);
}
console.log('PASS setup and page-load tests');
