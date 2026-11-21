// Security regression (demo data only): the admin page must
//  - take the Super Admin from the protected top-level field, not payloadJson,
//  - rebuild roles from the protected lists (authorizedEmails / editorEmails /
//    adminEmails) so emails or roles planted in payloadJson are ignored,
//  - write adminEmails on Super Admin saves, and send the stored lists back
//    unchanged on Admin/Editor saves,
//  - send revision = stored revision + 1 on every save,
//  - flag unverifiable admin roles on older documents,
// and the GEDCOM import text must not promise Edit access.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './lib/puppeteer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

const SUPER = 'owner@example.com', ADMIN = 'admin@example.com', EDITOR = 'editor@example.com', VIEWER = 'viewer@example.com';
const PLANT = 'planted@example.com';

function mainDoc({ legacy = false, revision = 7 } = {}) {
  const state = {
    tree: { id: 'demo', title: 'Demo Tree', revision },
    superAdminEmail: EDITOR, // planted: an editor rewrote the payload's Super Admin
    persons: { p1: { id: 'p1', given: 'Alex', surname: 'Lee', emails: [] }, p2: { id: 'p2', given: 'Sam', surname: 'Lee', emails: [] } },
    families: {},
    accessControl: {
      permissions: [
        { id: 'perm_super_admin', email: SUPER, role: 'super_admin' },
        { id: 'a', email: ADMIN, role: 'admin' },
        { id: 'e', email: EDITOR, role: 'admin' },          // planted self-promotion
        { id: 'v', email: VIEWER, role: 'view' },
        { id: 'x', email: PLANT, role: 'edit' }             // planted new editor
      ],
      auditLog: []
    }
  };
  const doc = {
    title: 'Demo Tree', revision, superAdminEmail: SUPER,
    authorizedEmails: [SUPER, ADMIN, EDITOR, VIEWER],
    editorEmails: [SUPER, ADMIN, EDITOR],
    updatedAt: '2026-11-20T10:00:00.000Z', updatedByEmail: EDITOR, updatedByUid: 'uid-ed',
    payloadJson: JSON.stringify(state)
  };
  if (!legacy) doc.adminEmails = [SUPER, ADMIN];
  return doc;
}
const logDoc = { changeLogJson: JSON.stringify({ changeEvents: [], changeSequence: 0 }), updatedAt: '2026-11-20T10:00:00.000Z', updatedByEmail: EDITOR, updatedByUid: 'uid-ed' };

const adminHtml = fs.readFileSync(path.join(DIST, 'admin.html'), 'utf8');
assert(!/automatically given <strong>Edit access<\/strong>/.test(adminHtml), 'GEDCOM option no longer claims imported emails get Edit access');
assert(/do <strong>not<\/strong> get sign-in access/.test(adminHtml), 'GEDCOM option says imported emails do not get sign-in access');

const treeSrc = fs.readFileSync(path.join(ROOT, 'src/tree.js'), 'utf8');
assert(treeSrc.includes("if (!canAccessAdminPanel()) {\n          showToast('Only an Admin or the Super Admin can rename the tree.');"), 'tree page only lets Admins rename the tree (matches the rules)');
const swSrc = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
assert(swSrc.includes("NEVER_CACHE_PATHS = ['/config.js', '/sw.js']"), 'built service worker never caches /config.js');

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = path.join(DIST, urlPath === '/' ? '/admin.html' : urlPath);
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

async function openAdmin() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { page._perr = (page._perr || []).concat(String(e)); });
  await page.goto(`http://127.0.0.1:${PORT}/admin.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__ADMIN && typeof window.__ADMIN.installTestSession === 'function', { timeout: 20000 });
  return page;
}

async function session(page, email, main) {
  return page.evaluate(async (email, main, log) => {
    const writes = [];
    window.__ADMIN.setTestWrite(async (m, l) => { writes.push(JSON.parse(JSON.stringify(m))); return { ok: true }; });
    window.__ADMIN.installTestSession({ email, uid: 'uid-' + email.split('@')[0], main, log });
    const st = window.__ADMIN.getState();
    const out = {
      superAdminEmail: st.superAdminEmail,
      perms: st.accessControl.permissions.map(p => ({ email: p.email, role: p.role })),
      toast: window.__ADMIN.toastText()
    };
    await window.__ADMIN.commitMutation('Edit 1', s => { s.persons.p1.given = 'Alexandra'; });
    await window.__ADMIN.commitMutation('Edit 2', s => { s.persons.p2.given = 'Samuel'; });
    out.writes = writes.map(w => ({
      revision: w.revision, authorizedEmails: w.authorizedEmails, editorEmails: w.editorEmails,
      adminEmails: w.adminEmails, hasAdminKey: Object.prototype.hasOwnProperty.call(w, 'adminEmails'),
      payloadPerms: JSON.parse(w.payloadJson).accessControl.permissions.map(p => ({ email: p.email, role: p.role })),
      payloadSuper: JSON.parse(w.payloadJson).superAdminEmail
    }));
    return out;
  }, email, main, logDoc);
}

try {
  // 1. Super Admin loads a document where an editor planted access in payloadJson.
  {
    const page = await openAdmin();
    const r = await session(page, SUPER, mainDoc());
    assert(r.superAdminEmail === SUPER, 'Super Admin comes from the protected field, not the planted payload value');
    assert(!r.perms.some(p => p.email === PLANT), 'planted email is dropped from permissions on load');
    assert(r.perms.find(p => p.email === EDITOR)?.role === 'edit', 'planted self-promotion (editor → admin) is reset to edit');
    assert(r.perms.find(p => p.email === ADMIN)?.role === 'admin', 'real admin keeps admin (from adminEmails)');
    assert(/Access check/.test(r.toast) && r.toast.includes(PLANT), 'Super Admin sees a warning naming the planted entry: ' + r.toast.slice(0, 160));
    const [w1, w2] = r.writes;
    assert(w1 && w1.revision === 8 && w2 && w2.revision === 9, 'saves send stored revision + 1, then + 1 again (got ' + (w1 && w1.revision) + ', ' + (w2 && w2.revision) + ')');
    assert(w1 && !w1.authorizedEmails.includes(PLANT) && !w1.editorEmails.includes(PLANT), 'Super Admin save does not grant the planted email');
    assert(w1 && JSON.stringify([...w1.adminEmails].sort()) === JSON.stringify([ADMIN, SUPER].sort()), 'Super Admin save writes adminEmails = Super Admin + real admins');
    assert(w1 && !w1.editorEmails.includes(VIEWER) && w1.editorEmails.includes(EDITOR), 'editor list unchanged apart from the plant');
    assert(w1 && w1.payloadSuper === SUPER, 'saved payload carries the real Super Admin');
    assert(!(page._perr || []).length, 'no page errors: ' + (page._perr || []).join(' | '));
    await page.close();
  }
  // 2. In-app Admin saves: lists go back exactly as stored; payload perms are reconciled.
  {
    const page = await openAdmin();
    const main = mainDoc();
    const r = await session(page, ADMIN, main);
    const w1 = r.writes[0];
    assert(w1 && JSON.stringify(w1.authorizedEmails) === JSON.stringify(main.authorizedEmails) && JSON.stringify(w1.editorEmails) === JSON.stringify(main.editorEmails), 'Admin save sends authorizedEmails/editorEmails back unchanged');
    assert(w1 && JSON.stringify(w1.adminEmails) === JSON.stringify(main.adminEmails), 'Admin save sends adminEmails back unchanged');
    assert(w1 && !w1.payloadPerms.some(p => p.email === PLANT), 'Admin save does not re-write the planted entry into payloadJson');
    assert(w1 && w1.revision === 8, 'Admin save sends stored revision + 1');
    assert(!/Access check/.test(r.toast), 'only the Super Admin gets the access warning');
    await page.close();
  }
  // 3. Older document (no adminEmails): rules lists cannot confirm admin roles.
  {
    const page = await openAdmin();
    const r = await session(page, SUPER, mainDoc({ legacy: true, revision: 3 }));
    assert(r.perms.find(p => p.email === EDITOR)?.role === 'admin', 'older document keeps a claimed admin role for an editor (cannot verify yet)');
    assert(/review the Admin role/.test(r.toast) && r.toast.includes(EDITOR), 'Super Admin is asked to review unverifiable admin roles: ' + r.toast.slice(0, 200));
    const w1 = r.writes[0];
    assert(w1 && w1.hasAdminKey && w1.adminEmails.includes(SUPER), 'first Super Admin save adds adminEmails');
    assert(w1 && w1.revision === 4, 'first save after deploy sends revision 3 + 1');
    await page.close();
  }
  // 4. Editor on an older document never adds adminEmails (the rules would refuse it).
  {
    const page = await openAdmin();
    const r = await session(page, ADMIN, mainDoc({ legacy: true, revision: 3 }));
    const w1 = r.writes[0];
    assert(w1 && !w1.hasAdminKey, 'non-Super-Admin save on an older document leaves adminEmails out');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failed.length) { console.error('FAILED', failed); process.exit(1); }
console.log('PASS security ACL / revision tests');
