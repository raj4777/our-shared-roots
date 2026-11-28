import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Page tests drive the app through the window.__TREE / __ADMIN / __MIGRATE hooks,
// which only exist in the test build (npm run build:test -> dist-test/). The
// production dist/ is checked separately by test_no_test_hooks.mjs.
export const PROD_DIST = path.join(ROOT, 'dist');
export const DIST = path.join(ROOT, process.env.OSR_TEST_DIST || 'dist-test');

const PAGE_SOURCES = {
  'index.html': ['dist/index.html', 'src/tree.js', 'src/share-core.js', 'src/save-core.js', 'src/firebase-config.js'],
  'admin.html': ['dist/admin.html', 'src/admin.js', 'src/share-core.js', 'src/save-core.js', 'src/firebase-config.js'],
  'migrate-log.html': ['dist/migrate-log.html', 'src/migrate-log.js', 'src/firebase-config.js'],
  '404.html': ['dist/404.html'],
  'offline.html': ['dist/offline.html'],
  'sw.js': ['dist/sw.js']
};

export function readApp(name) {
  const n = String(name).replace(/^public\//, '').replace(/^\//, '');
  const parts = PAGE_SOURCES[n];
  if (parts) {
    return parts.map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  }
  const distPath = path.join(DIST, n);
  if (fs.existsSync(distPath) && fs.statSync(distPath).isFile()) {
    return fs.readFileSync(distPath, 'utf8');
  }
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

export function hashedAppCss() {
  const dir = path.join(DIST, 'assets');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^app\.[a-zA-Z0-9_-]+\.css$/.test(f)) : [];
  if (!names.length) throw new Error('dist/assets/app.[hash].css is missing; run npm run build');
  return names[0];
}

// ---- Optional, box-only inputs -------------------------------------------
// Some files exist only in the development copy on the box (for example
// firebase.merged.json, install-to-Z.ps1, the root robots.txt mirror) and are
// not part of the Z: / Mac copy. Tests check them when present and say so
// plainly when they are not, instead of failing with ENOENT.
export const SKIP_EXIT_CODE = 77;

export function hasFile(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

export function readOptional(rel, why = 'box-only') {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log('  info  ' + rel + ' not present (' + why + '); skipping its checks');
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

// firebase.json is the real deploy config. firebase.merged.json is a box-only
// reference copy; include it only when it exists.
export function firebaseConfigNames() {
  const names = ['firebase.json'];
  if (hasFile('firebase.merged.json')) names.push('firebase.merged.json');
  else console.log('  info  firebase.merged.json not present (box-only); checking firebase.json only');
  return names;
}

// Tests that need the private production fixture skip cleanly without it.
export function requireFixture(file, label = 'test/private/production-backup.json') {
  if (!fs.existsSync(file)) {
    console.log('SKIP  ' + label + ' not present; this test needs the private fixture (never published).');
    process.exit(SKIP_EXIT_CODE);
  }
}

// Box runs can also drop screenshots on /workspace. On a Mac (or any tree
// without that folder) write only to <repo>/screenshots/.
export function screenshotOutDir() {
  const fromEnv = process.env.OSR_SCREENSHOT_OUT;
  if (fromEnv) {
    const dir = path.resolve(fromEnv);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  try {
    if (fs.existsSync('/workspace') && fs.statSync('/workspace').isDirectory()) {
      fs.accessSync('/workspace', fs.constants.W_OK);
      return '/workspace';
    }
  } catch {
    // no shared box workspace
  }
  const fallback = path.join(ROOT, 'screenshots');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function keepScreenshot(srcPath, fileName) {
  const dest = path.join(ROOT, 'screenshots', fileName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(srcPath) !== path.resolve(dest)) fs.copyFileSync(srcPath, dest);
  return dest;
}
