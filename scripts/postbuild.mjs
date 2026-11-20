import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(ROOT, 'dist');
const assetsDir = path.join(dist, 'assets');
const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
const css = assets.filter((f) => /^app\.[a-zA-Z0-9_-]+\.css$/.test(f)).sort();
const js = assets.filter((f) => f.endsWith('.js')).sort();
if (!css.length) {
  console.warn('postbuild: no hashed app.[hash].css found in dist/assets:', assets);
}
const precache = [
  '/',
  '/index.html',
  '/offline.html',
  '/404.html',
  '/theme-boot.js',
  '/config-boot.js',
  ...css.map((f) => '/assets/' + f),
  ...js.map((f) => '/assets/' + f),
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png'
];

const swPath = path.join(dist, 'sw.js');
if (!fs.existsSync(swPath)) throw new Error('dist/sw.js missing; is publicDir static/?');
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE_VERSION = 'osr-pwa-v\d+';/, "const CACHE_VERSION = 'osr-pwa-v5';");
const list = precache.map((u) => `  '${u}'`).join(',\n');
if (!/const PRECACHE_URLS = \[/.test(sw)) throw new Error('PRECACHE_URLS not found in sw.js');
sw = sw.replace(/const PRECACHE_URLS = \[[\s\S]*?\];/, `const PRECACHE_URLS = [\n${list}\n];`);
fs.writeFileSync(swPath, sw);
fs.writeFileSync(path.join(dist, 'precache.json'), JSON.stringify(precache, null, 2) + '\n');
console.log('postbuild: CACHE_VERSION osr-pwa-v5, precache', precache.length, 'urls');
console.log(precache.join('\n'));
