// Production builds must not ship the test hooks (window.__TREE / __ADMIN /
// __MIGRATE, installTestSession, setTestWrite, the ?test=1 shortcut). They are
// compiled in only by `npm run build:test` (dist-test/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}
function readAll(dir) {
  const out = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|html|mjs)$/.test(name)) out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
    }
  })(dir);
  return out;
}
const FORBIDDEN = ['__TREE', '__ADMIN', '__MIGRATE', '__OSR_TEST_HOOKS__', 'installTestSession', 'setTestWrite', 'setTestStorageUpload', 'setTestStorageDelete', 'setTestLogWriteCount', "params.get('test')", 'sessionAuth.isAuthenticated = true'];
const prod = path.join(ROOT, 'dist');
assert(fs.existsSync(path.join(prod, 'index.html')), 'production dist/ exists (run npm run build)');
const prodFiles = readAll(prod);
assert(prodFiles.some(([n]) => n.startsWith('assets/') && n.endsWith('.js')), 'production dist has JS bundles');
for (const term of FORBIDDEN) {
  const hits = prodFiles.filter(([, text]) => text.includes(term)).map(([n]) => n);
  assert(hits.length === 0, 'production dist has no ' + term + (hits.length ? ' (found in ' + hits.join(', ') + ')' : ''));
}
const testDist = path.join(ROOT, 'dist-test');
if (fs.existsSync(testDist)) {
  const testFiles = readAll(testDist);
  for (const term of ['window.__TREE', 'window.__ADMIN', 'window.__MIGRATE']) {
    assert(testFiles.some(([, text]) => text.includes(term)), 'test build (dist-test) still has ' + term);
  }
}
if (failed.length) { console.log('FAILED ' + failed.length); process.exit(1); }
console.log('PASS production build has no test hooks');
