import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/pw/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

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

// --- setup: invalid project id ---
{
  const r = await run('node', ['setup.mjs', '--project-id', 'BAD_ID', '--super-admin', 'owner@example.com', '--firebase-config', CFG, '--out', path.join(ROOT, 'deploy-should-not-exist')]);
  assert(r.code !== 0 && /project id/i.test(r.stderr), 'rejects an invalid project ID');
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
assert(fs.existsSync(path.join(OUT, 'public/config.js')), 'writes public/config.js');
assert(fs.existsSync(path.join(OUT, 'firestore.rules')), 'writes firestore.rules');
assert(fs.existsSync(path.join(OUT, 'firebase.json')), 'writes firebase.json');
assert(fs.existsSync(path.join(OUT, '.firebaserc')), 'writes .firebaserc');
assert(fs.existsSync(path.join(OUT, 'public/index.html')), 'copies the tree page');
assert(fs.existsSync(path.join(OUT, 'public/admin.html')), 'copies the admin page');

const cfgJs = fs.readFileSync(path.join(OUT, 'public/config.js'), 'utf8');
assert(cfgJs.includes('owner@example.com') && cfgJs.includes('Harbor Family') && cfgJs.includes('familytree'), 'config.js contains the provided values');
const banned = [('raje'+'ndra'), ('gole'+'gaonkar'), ('our'+'shared'+'roots')];
assert(!banned.some((w) => cfgJs.toLowerCase().includes(w)), 'generated config.js has no personal production values');

const rules = fs.readFileSync(path.join(OUT, 'firestore.rules'), 'utf8');
assert(rules.includes("return 'owner@example.com';"), 'rules embed the Super Admin email');
assert(rules.includes('match /archives/familytree {') && rules.includes('match /archives/familytree_log {'), 'rules use the chosen archive IDs');
assert(!rules.includes('__SUPER_ADMIN_EMAIL__') && !rules.includes('__ARCHIVE_ID__'), 'no unfilled placeholders in rules');

const fb = JSON.parse(fs.readFileSync(path.join(OUT, 'firebase.json'), 'utf8'));
assert(fb.firestore.location === 'nam5', 'firebase.json uses the chosen location');
assert(fb.hosting && Array.isArray(fb.hosting.rewrites), 'firebase.json keeps hosting rewrites');
const rc = JSON.parse(fs.readFileSync(path.join(OUT, '.firebaserc'), 'utf8'));
assert(rc.projects.default === 'demo-family-tree', '.firebaserc has the project ID');

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'public/manifest.webmanifest'), 'utf8'));
assert(manifest.name === 'Harbor Family', 'manifest name is the site title');

// --- refuse overwrite without --force ---
{
  const r = await run('node', ['setup.mjs', '--project-id', 'demo-family-tree', '--super-admin', 'owner@example.com', '--firebase-config', CFG, '--out', OUT]);
  assert(r.code !== 0 && /already exists/i.test(r.stderr + r.stdout), 'refuses to overwrite without --force');
}

// --- serve and load pages ---
const PUBLIC = path.join(OUT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
  firebaseKey: window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey
}));
assert(tree.info.hasConfig && tree.info.siteTitle === 'Harbor Family', 'tree page loads OSR_CONFIG');
assert(tree.info.superAdmin === 'owner@example.com' && tree.info.archiveId === 'familytree', 'tree page sees Super Admin and archive id');
assert(tree.info.firebaseKey === 'test-api-key-not-real', 'tree page applies FIREBASE_CONFIG from OSR_CONFIG');
assert(tree.info.header === 'Harbor Family' || tree.info.title.includes('Harbor Family'), 'tree page shows the site title');
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

server.close();
if (failed.length) {
  console.error('FAILED', failed);
  process.exit(1);
}
console.log('PASS setup and page-load tests');
