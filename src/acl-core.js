/*
 * Shared access-control core used by the tree page (tree.js) and the admin
 * page (admin.js). Pure functions only: no Firebase, no DOM.
 *
 * Source of truth for roles is the set of lists on the tree document that
 * only the Super Admin can change (enforced by firestore.rules):
 *   authorizedEmails  everyone who may sign in and read
 *   editorEmails      everyone who may edit (includes admins)
 *   adminEmails       in-app admins (added by this update; missing on older docs)
 * accessControl.permissions inside payloadJson is editable by any editor, so it
 * is treated as display data and rebuilt from those lists whenever a document
 * is loaded. That stops "ACL planting": an editor writing a new email or role
 * into payloadJson no longer reaches the real lists on the Super Admin's next save.
 */

export function normAclEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function lowerList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const em of list) {
    const v = normAclEmail(em);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const EDIT_ROLES = ['super_admin', 'admin', 'edit'];
const ADMIN_ROLES = ['super_admin', 'admin'];

/**
 * Lists the Super Admin's page writes, computed from the (already reconciled)
 * permissions. Every admin is an editor and every editor is a viewer.
 */
export function computeAccessListsFromPermissions(permissions, superAdminEmail) {
  const superEmail = normAclEmail(superAdminEmail);
  const auth = new Set();
  const edit = new Set();
  const admin = new Set();
  if (superEmail) { auth.add(superEmail); edit.add(superEmail); admin.add(superEmail); }
  (Array.isArray(permissions) ? permissions : []).forEach((pm) => {
    const em = normAclEmail(pm && pm.email);
    if (!em) return;
    auth.add(em);
    if (EDIT_ROLES.includes(pm.role)) edit.add(em);
    if (ADMIN_ROLES.includes(pm.role)) admin.add(em);
  });
  return {
    superAdminEmail: superEmail,
    authorizedEmails: Array.from(auth),
    editorEmails: Array.from(edit),
    adminEmails: Array.from(admin)
  };
}

/**
 * Lists a non-Super-Admin page must send back unchanged. adminEmails is only
 * included when the stored document already has it, so a merge write never
 * adds the field on behalf of an editor (the rules would refuse that).
 */
export function frozenAccessListsFromMainDoc(mainData, fallbackSuperEmail) {
  const d = mainData || {};
  const superEmail = String(d.superAdminEmail || fallbackSuperEmail || '').trim();
  const out = {
    superAdminEmail: superEmail,
    authorizedEmails: Array.isArray(d.authorizedEmails) ? d.authorizedEmails.slice() : (superEmail ? [superEmail] : []),
    editorEmails: Array.isArray(d.editorEmails) ? d.editorEmails.slice() : (superEmail ? [superEmail] : [])
  };
  if (Array.isArray(d.adminEmails)) out.adminEmails = d.adminEmails.slice();
  return out;
}

/**
 * Rebuilds state.accessControl.permissions from the protected lists on the
 * loaded tree document. Keeps display fields (personId, note, id) from the
 * payload, but the email set and every role come from the lists.
 *
 * Returns a report; report.issues() is true when the payload disagreed with
 * the lists (a planted or stale entry was corrected).
 */
export function reconcilePermissionsWithMainDoc(state, mainData, opts = {}) {
  const report = {
    applied: false,
    legacyNoAdminList: false,
    dropped: [],
    changedRole: [],
    added: [],
    unverifiedAdmins: [],
    issues() {
      return this.dropped.length > 0 || this.changedRole.length > 0 || this.added.length > 0;
    }
  };
  if (!state || !mainData) return report;
  const auth = lowerList(mainData.authorizedEmails);
  const edit = lowerList(mainData.editorEmails);
  if (!auth || !edit) return report;
  const admins = lowerList(mainData.adminEmails);
  const superEmail = normAclEmail(opts.superAdminEmail || mainData.superAdminEmail || state.superAdminEmail);
  const authSet = new Set(auth);
  const editSet = new Set(edit);
  const adminSet = admins ? new Set(admins) : null;
  report.applied = true;
  report.legacyNoAdminList = !adminSet;

  state.accessControl = state.accessControl || { activeSessionRole: 'guest', permissions: [], auditLog: [] };
  const perms = Array.isArray(state.accessControl.permissions) ? state.accessControl.permissions : [];
  const out = [];
  const seen = new Set();

  const roleFor = (em, claimed) => {
    if (em === superEmail) return 'super_admin';
    if (!editSet.has(em)) return 'view';
    if (adminSet) return adminSet.has(em) ? 'admin' : 'edit';
    // Older document without adminEmails: the lists cannot tell admin from
    // edit, so keep the claimed admin role but flag it for review.
    if (claimed === 'admin' || claimed === 'super_admin') {
      report.unverifiedAdmins.push(em);
      return 'admin';
    }
    return 'edit';
  };

  for (const pm of perms) {
    if (!pm || typeof pm !== 'object') continue;
    const em = normAclEmail(pm.email);
    if (!em) continue;
    if (seen.has(em)) { report.dropped.push(em); continue; }
    if (em !== superEmail && !authSet.has(em)) { report.dropped.push(em); continue; }
    seen.add(em);
    const role = roleFor(em, pm.role);
    if (pm.role !== role) report.changedRole.push({ email: em, from: String(pm.role || ''), to: role });
    out.push(pm.role === role && pm.email === em ? pm : { ...pm, email: em, role });
  }
  for (const em of auth) {
    if (seen.has(em)) continue;
    seen.add(em);
    const person = typeof opts.findPersonByEmail === 'function' ? opts.findPersonByEmail(em) : null;
    out.push({
      id: 'perm_' + em.replace(/[^a-z0-9]/g, '_'),
      email: em,
      personId: person && person.id ? person.id : null,
      role: roleFor(em, ''),
      note: 'Restored from the protected access list',
      updatedAt: new Date().toISOString().slice(0, 10)
    });
    report.added.push(em);
  }
  state.accessControl.permissions = out;
  return report;
}

/** Short text for the Super Admin when a load corrected the permissions. */
export function describeAclReport(report) {
  if (!report || !report.applied) return '';
  const parts = [];
  if (report.dropped.length) parts.push('ignored access entries not on the protected list: ' + report.dropped.join(', '));
  if (report.changedRole.length) parts.push('reset roles to match the protected lists: ' + report.changedRole.map((c) => `${c.email} (${c.from || 'none'} → ${c.to})`).join(', '));
  if (report.added.length) parts.push('restored entries from the protected list: ' + report.added.join(', '));
  return parts.length ? 'Access check: ' + parts.join('; ') + '.' : '';
}

/**
 * Revision the next save must carry. The rules accept only stored revision + 1.
 * baseRevision is the revision of the document this page last loaded or wrote;
 * null means the document did not exist (first-time create).
 */
export function nextArchiveRevision(baseRevision, localRevision) {
  if (baseRevision != null && baseRevision !== '') {
    const base = Number(baseRevision);
    if (Number.isFinite(base)) return Math.floor(base) + 1;
  }
  const local = Number(localRevision);
  return Number.isFinite(local) && local >= 1 ? Math.floor(local) : 1;
}
