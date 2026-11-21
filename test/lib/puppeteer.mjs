/*
 * Browser helper for the page tests.
 *
 * Finds puppeteer-core and a Chrome/Chromium binary on any machine instead of
 * relying on a hardcoded /tmp/pw install:
 *   1. PUPPETEER_CORE_PATH (a path to puppeteer-core's ESM entry or package dir)
 *   2. puppeteer-core / puppeteer from this project's node_modules
 *      (puppeteer-core is a devDependency: run `npm install` once)
 *   3. the old /tmp/pw install, if present
 * Chrome: PUPPETEER_EXECUTABLE_PATH or CHROME_PATH, then the path the test
 * asked for, then the usual Linux, macOS, and Windows install locations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY = '/tmp/pw/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

async function tryImport(spec) {
  if (!spec) return null;
  try {
    let target = spec;
    if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) {
      if (!fs.existsSync(spec)) return null;
      if (fs.statSync(spec).isDirectory()) target = path.join(spec, 'lib/esm/puppeteer/puppeteer-core.js');
      target = pathToFileURL(target).href;
    }
    const mod = await import(target);
    const p = mod.default || mod;
    return typeof p.launch === 'function' ? p : null;
  } catch (e) {
    return null;
  }
}

async function loadPuppeteer() {
  for (const spec of [process.env.PUPPETEER_CORE_PATH, 'puppeteer-core', 'puppeteer', LEGACY]) {
    const p = await tryImport(spec);
    if (p) return p;
  }
  throw new Error('puppeteer-core was not found. Run `npm install` in the project folder (it is a devDependency), '
    + 'or set PUPPETEER_CORE_PATH to an existing puppeteer-core install.');
}

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

export function resolveChrome(requested) {
  const list = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH, requested, ...CHROME_CANDIDATES];
  for (const p of list) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('No Chrome or Chromium was found for the browser tests. Install Google Chrome, '
    + 'or set PUPPETEER_EXECUTABLE_PATH (or CHROME_PATH) to its executable.');
}

const real = await loadPuppeteer();

export default {
  launch(options = {}) {
    // Newer puppeteer-core only accepts headless true/false/'shell';
    // older tests pass 'new', which meant the same as true.
    const headless = options.headless === 'new' ? true : options.headless;
    return real.launch({ ...options, headless, executablePath: resolveChrome(options.executablePath) });
  }
};
