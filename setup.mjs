#!/usr/bin/env node
/**
 * Generate a self-contained Firebase deploy folder for this family tree app.
 *
 * Usage:
 *   node setup.mjs --project-id my-proj --super-admin you@example.com \
 *     --firebase-config ./firebase-web-config.json \
 *     [--site-title "Family Tree"] [--location nam5] [--archive-id familytree] \
 *     [--archive-log-id familytree_log] [--out ./deploy-my-proj] [--force]
 *
 *   Individual Firebase fields (instead of a JSON file):
 *     --api-key --auth-domain --storage-bucket --messaging-sender-id --app-id [--measurement-id]
 *
 *   --firebase-config -   read the web config JSON from stdin
 *
 * If required values are missing and stdin is a TTY, the script asks for them.
 * It will not overwrite an existing output directory unless you pass --force
 * or confirm at the prompt.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const TEMPLATES = path.join(ROOT, 'templates');

// Strict, lowercase-only email: no quotes, backslashes, spaces, or other
// characters that could break out of the rules string it is written into.
const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCATION_RE = /^[a-z][a-z0-9-]{1,39}$/;
const PROJECT_RE = /^[a-z][a-z0-9-]{5,29}$/;
const ARCHIVE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function usage() {
  return `Generate a deploy folder for the family tree app.

Usage:
  node setup.mjs --project-id <id> --super-admin <email> --firebase-config <file.json>
                 [--site-title "Family Tree"] [--location nam5]
                 [--archive-id familytree] [--out ./deploy-<id>] [--force]

  setup.sh and setup.ps1 call this script with the same arguments.

Required:
  --project-id          Firebase project ID
  --super-admin         Super Admin email (the first Google account that may create the archive)
  --firebase-config     Path to a Firebase web SDK config JSON, or "-" for stdin
                        (or pass --api-key, --auth-domain, --storage-bucket,
                        --messaging-sender-id, --app-id, and optional --measurement-id)

Optional:
  --site-title          Display name (default: "Family Tree")
  --location            Firestore location (default: nam5). asia-south2 is also common.
  --archive-id          Tree document ID under archives/ (default: familytree)
  --archive-log-id      Change-log document ID (default: <archive-id>_log)
  --out                 Output directory (default: ./deploy-<project-id>)
  --force               Overwrite an existing output directory without asking
  -h, --help            Show this help
`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = val;
        i++;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

function fail(msg) {
  console.error('Error: ' + msg);
  process.exit(1);
}

function validateEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v) || v.includes('..')) fail(`Invalid email address: ${JSON.stringify(String(email))}`);
  return v;
}

function validateLocation(loc) {
  const v = String(loc || '').trim().toLowerCase();
  if (!LOCATION_RE.test(v)) fail(`Invalid Firestore location "${loc}". Use a location ID such as nam5, eur3, or asia-south2.`);
  return v;
}

// Escapes a value for a single-quoted string in firestore.rules. The email is
// already validated above, so this is defence in depth.
function rulesStringLiteral(value) {
  const v = String(value);
  if (/[\u0000-\u001f\u007f]/.test(v)) fail('Refusing to write a control character into firestore.rules.');
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Escapes a value for a JSON string written into a template.
function jsonStringBody(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

function validateProjectId(id) {
  const v = String(id || '').trim();
  if (!PROJECT_RE.test(v)) {
    fail(`Invalid Firebase project ID "${id}". Use 6–30 characters: start with a letter, then lowercase letters, digits, or hyphens.`);
  }
  return v;
}

function validateArchiveId(id, label) {
  const v = String(id || '').trim();
  if (!ARCHIVE_RE.test(v) || v === '.' || v === '..') {
    fail(`Invalid ${label} "${id}". Use 1–64 letters, digits, underscores, or hyphens.`);
  }
  return v;
}

function parseFirebaseJson(raw, source) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail(`Could not parse Firebase web config from ${source}: ${e.message}`);
  }
  // Allow either the raw SDK object or { firebase: { ... } } or a firebaseConfig wrapper
  if (data && data.firebase && typeof data.firebase === 'object') data = data.firebase;
  if (data && data.firebaseConfig && typeof data.firebaseConfig === 'object') data = data.firebaseConfig;
  const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
  const missing = required.filter((k) => !data || !String(data[k] || '').trim());
  if (missing.length) fail(`Firebase web config from ${source} is missing: ${missing.join(', ')}`);
  const cfg = {
    apiKey: String(data.apiKey).trim(),
    authDomain: String(data.authDomain).trim(),
    projectId: String(data.projectId).trim(),
    storageBucket: String(data.storageBucket).trim(),
    messagingSenderId: String(data.messagingSenderId).trim(),
    appId: String(data.appId).trim()
  };
  if (data.measurementId) cfg.measurementId = String(data.measurementId).trim();
  return cfg;
}

async function prompt(rl, question, def) {
  const suffix = def ? ` [${def}]` : '';
  const answer = (await rl.question(question + suffix + ': ')).trim();
  return answer || def || '';
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function fillTemplate(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(key).join(value);
  }
  return out;
}

function writeConfigJs(file, cfg) {
  const firebase = { ...cfg.firebase };
  const body = {
    firebase,
    superAdminEmail: cfg.superAdminEmail,
    siteTitle: cfg.siteTitle,
    archiveId: cfg.archiveId,
    archiveLogId: cfg.archiveLogId
  };
  const js = '/* Generated by setup.mjs. Do not commit a filled-in config.js. */\n'
    + 'window.OSR_CONFIG = ' + JSON.stringify(body, null, 2) + ';\n';
  fs.writeFileSync(file, js);
}

function updateManifest(file, siteTitle) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.name = siteTitle;
  manifest.short_name = siteTitle.length > 12 ? siteTitle.slice(0, 12).trim() : siteTitle;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

async function collectConfig(args) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let rl = null;
  const ask = async (q, def) => {
    if (!interactive) return def || '';
    if (!rl) rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
    return prompt(rl, q, def);
  };

  let firebase = null;
  if (args['api-key'] || args['auth-domain'] || args['storage-bucket'] || args['messaging-sender-id'] || args['app-id']) {
    firebase = parseFirebaseJson(JSON.stringify({
      apiKey: args['api-key'],
      authDomain: args['auth-domain'],
      projectId: args['project-id'] || args['firebase-project-id'],
      storageBucket: args['storage-bucket'],
      messagingSenderId: args['messaging-sender-id'],
      appId: args['app-id'],
      measurementId: args['measurement-id']
    }), 'command-line fields');
  } else if (args['firebase-config']) {
    const src = args['firebase-config'];
    const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8');
    firebase = parseFirebaseJson(raw, src === '-' ? 'stdin' : src);
  } else if (interactive) {
    console.log('Paste your Firebase web config JSON (from Project settings → Your apps), then a blank line:');
    const lines = [];
    if (!rl) rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
    for (;;) {
      const line = await rl.question('');
      if (!line.trim() && lines.length) break;
      lines.push(line);
    }
    let pasted = lines.join('\n').trim();
    // Tolerate a pasted JS object (firebaseConfig = { ... };)
    const objStart = pasted.indexOf('{');
    const objEnd = pasted.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) pasted = pasted.slice(objStart, objEnd + 1);
    pasted = pasted.replace(/(\w+)\s*:/g, (m, k) => {
      if (m.includes('"') || m.trim().startsWith('"')) return m;
      return `"${k}":`;
    }).replace(/,(\s*[}\]])/g, '$1');
    firebase = parseFirebaseJson(pasted, 'pasted JSON');
  } else {
    fail('Missing Firebase web config. Pass --firebase-config <file.json> or the individual --api-key / --auth-domain / --storage-bucket / --messaging-sender-id / --app-id fields.');
  }

  let projectId = args['project-id'] || firebase.projectId;
  if (!projectId) projectId = await ask('Firebase project ID');
  projectId = validateProjectId(projectId);
  if (firebase.projectId && firebase.projectId !== projectId) {
    console.warn(`Note: --project-id (${projectId}) differs from firebase.projectId (${firebase.projectId}). Using ${projectId} for .firebaserc; the web config is left as given.`);
  }

  let superAdmin = args['super-admin'] || args['super-admin-email'];
  if (!superAdmin) superAdmin = await ask('Super Admin email');
  if (!superAdmin) fail('Super Admin email is required.');
  superAdmin = validateEmail(superAdmin);

  let siteTitle = args['site-title'] || '';
  if (!siteTitle && interactive) siteTitle = await ask('Site title', 'Family Tree');
  siteTitle = (siteTitle || 'Family Tree').trim() || 'Family Tree';

  let location = args.location || args['firestore-location'] || '';
  if (!location && interactive) location = await ask('Firestore location (nam5, asia-south2, …)', 'nam5');
  location = validateLocation((location || 'nam5').trim() || 'nam5');

  let archiveId = args['archive-id'] || '';
  if (!archiveId && interactive) archiveId = await ask('Archive document ID', 'familytree');
  archiveId = validateArchiveId(archiveId || 'familytree', 'archive id');

  let archiveLogId = args['archive-log-id'] || '';
  if (!archiveLogId) archiveLogId = archiveId + '_log';
  archiveLogId = validateArchiveId(archiveLogId, 'archive log id');

  let outDir = args.out || args.output || '';
  if (!outDir && interactive) outDir = await ask('Output directory', path.join('.', 'deploy-' + projectId));
  outDir = path.resolve(process.cwd(), outDir || path.join('.', 'deploy-' + projectId));

  if (rl) rl.close();

  return { firebase, projectId, superAdminEmail: superAdmin, siteTitle, location, archiveId, archiveLogId, outDir, force: Boolean(args.force) };
}

async function confirmOverwrite(dir, force) {
  if (!fs.existsSync(dir)) return;
  const has = fs.readdirSync(dir).length > 0;
  if (!has) return;
  if (force) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    fail(`Output directory already exists: ${dir}\nRe-run with --force to overwrite.`);
  }
  const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
  const answer = (await rl.question(`Output directory ${dir} already exists. Overwrite? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') fail('Aborted. Existing output directory was left unchanged.');
  fs.rmSync(dir, { recursive: true, force: true });
}

function generate(cfg) {
  const dest = cfg.outDir;
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    fail('Missing dist/. Run npm install && npm run build in the repository root first, then re-run setup.');
  }
  fs.mkdirSync(dest, { recursive: true });
  const publicDir = path.join(dest, 'dist');
  copyDir(DIST, publicDir);

  writeConfigJs(path.join(publicDir, 'config.js'), cfg);
  updateManifest(path.join(publicDir, 'manifest.webmanifest'), cfg.siteTitle);

  const rulesTpl = fs.readFileSync(path.join(TEMPLATES, 'firestore.rules.template'), 'utf8');
  fs.writeFileSync(path.join(dest, 'firestore.rules'), fillTemplate(rulesTpl, {
    __SUPER_ADMIN_EMAIL__: rulesStringLiteral(validateEmail(cfg.superAdminEmail)),
    __ARCHIVE_ID__: validateArchiveId(cfg.archiveId, 'archive id'),
    __ARCHIVE_LOG_ID__: validateArchiveId(cfg.archiveLogId, 'archive log id')
  }));

  const fbTpl = fs.readFileSync(path.join(TEMPLATES, 'firebase.json.template'), 'utf8');
  const firebaseJson = fillTemplate(fbTpl, { __FIRESTORE_LOCATION__: jsonStringBody(validateLocation(cfg.location)) });
  // sanity: still valid JSON
  JSON.parse(firebaseJson);
  fs.writeFileSync(path.join(dest, 'firebase.json'), firebaseJson);

  fs.copyFileSync(path.join(TEMPLATES, 'firestore.indexes.json'), path.join(dest, 'firestore.indexes.json'));

  fs.writeFileSync(path.join(dest, '.firebaserc'), JSON.stringify({ projects: { default: cfg.projectId } }, null, 2) + '\n');

  const readme = `# ${cfg.siteTitle} — deploy folder

This folder was generated by setup.mjs. From here:

    firebase deploy

That publishes Hosting (the built \`dist/\` site) and the Firestore rules in this folder
to Firebase project \`${cfg.projectId}\`.

Sign in first with the Super Admin account (${cfg.superAdminEmail}) to create
the archive documents (\`${'archives/' + cfg.archiveId}\` and \`${'archives/' + cfg.archiveLogId}\`).
Then add editors and viewers in the Admin panel.
`;
  fs.writeFileSync(path.join(dest, 'README.md'), readme);

  return dest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!fs.existsSync(path.join(SRC, 'index.html')) || !fs.existsSync(path.join(TEMPLATES, 'firestore.rules.template'))) {
    fail('This script must be run from the family-tree repository (missing src/ or templates/).');
  }
  const cfg = await collectConfig(args);
  await confirmOverwrite(cfg.outDir, cfg.force);
  const dest = generate(cfg);
  console.log('Wrote deploy folder: ' + dest);
  console.log('  dist/                built site + config.js');
  console.log('  firestore.rules      filled from the template');
  console.log('  firestore.indexes.json');
  console.log('  firebase.json        hosting public=dist + Firestore location ' + cfg.location);
  console.log('  .firebaserc          project ' + cfg.projectId);
  console.log('');
  console.log('Next:');
  console.log('  cd ' + path.relative(process.cwd(), dest) + ' && firebase deploy');
  console.log('Then open the site and sign in with ' + cfg.superAdminEmail + ' to create the archive.');
}

await main();
