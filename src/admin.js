window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

import { applyHostingAuthDomain } from './firebase-config.js';
import { computeAccessListsFromPermissions, frozenAccessListsFromMainDoc, reconcilePermissionsWithMainDoc, describeAclReport, nextArchiveRevision } from './acl-core.js';
import { createShareStore, generateShareToken, buildShareUrl, buildGuestDocFields, applySuggestionToState, suggestionFieldLabel, currentValueForField } from './share-core.js';
import { configureSaveCore, LOG_CHECKPOINT_LIMIT, OFFLINE_SAVE_MESSAGE, appendChangeLogEntry, applyDomainDiffToSnap, clearAppErrorLog, compactChangeLogEvents, computeDomainDiff, deepClone, describeLogStorage, describeMainStorage, downloadAppErrorLog, entryIsRevertible, escapeHtml, extractEmbeddedLog, findRevertConflictsFromDiff, formatFirestoreError, formatStorageKb, generateId, getArchiveDocPath, getArchiveId, getArchiveLogDocPath, getArchiveLogId, getEntryDiff, getOsConfig, hasLegacySnapshots, hasUsableDiff, isOwnEchoSnapshot, jsonFitsInDoc, loadAppErrorLog, logStateFromLogDoc, mergeLogStates, miniSnapFromDiff, openFirestoreDatabase, paintStorageRow, reconstructStateBeforeEntry, recordAppError, rememberOwnStamp, reservedSizeForFields, trimChangeLogToFit, utf8ByteLength, writeArchiveAndLog } from './save-core.js';

    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
    import {
      getAuth,
      onAuthStateChanged,
      setPersistence,
      browserLocalPersistence,
      browserSessionPersistence,
      GoogleAuthProvider,
      signInWithPopup,
      signInWithRedirect,
      getRedirectResult,
      signOut
    } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
    import {
      getFirestore,
      initializeFirestore,
      persistentLocalCache,
      persistentMultipleTabManager,
      memoryLocalCache,
      doc,
      getDoc,
      setDoc,
      onSnapshot,
      runTransaction,
      deleteDoc,
      updateDoc,
      writeBatch,
      collection,
      addDoc,
      getDocs,
      query,
      orderBy,
      limit,
      serverTimestamp,
    } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

    configureSaveCore({ getDb: () => db, getFirebaseUser: () => firebaseUser });

    function getSiteTitle() {
      const t = String(getOsConfig().siteTitle || 'Family Tree').trim();
      return t || 'Family Tree';
    }
    function getConfiguredSuperAdminEmail() {
      return String(getOsConfig().superAdminEmail || '').trim().toLowerCase();
    }
    function getDefaultTreeId() { return 'tree-' + getArchiveId(); }
    function applyOsFirebaseConfig() {
      const fb = getOsConfig().firebase;
      if (fb && fb.apiKey) window.FIREBASE_CONFIG = fb;
    }
    function applyConfigToDom() {
      const title = getSiteTitle();
      document.querySelectorAll('[data-site-title]').forEach((el) => { el.textContent = title; });
      document.querySelectorAll('[data-archive-path]').forEach((el) => { el.textContent = getArchiveDocPath(); });
      document.querySelectorAll('[data-archive-log-path]').forEach((el) => { el.textContent = getArchiveLogDocPath(); });
      document.querySelectorAll('[data-super-admin-email]').forEach((el) => {
        const email = getConfiguredSuperAdminEmail();
        el.textContent = email || 'the archive owner';
      });
      const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if (apple) apple.setAttribute('content', title);
    }
    applyOsFirebaseConfig();


    const LEGACY_STORAGE_KEYS = ['genealogy_studio_shared_v1', 'genealogy_studio_v1_state'];

    function purgeLocalCachedRecords() {
      LEGACY_STORAGE_KEYS.forEach(k => {
        try { window.localStorage.removeItem(k); } catch (e) {}
      });
    }

    purgeLocalCachedRecords();

    let firebaseApp = null;
    let auth = null;
    let db = null;
    let firebaseUser = null;
    let unsubscribeArchive = null;
    let unsubscribeLog = null;
    let firestoreAccessDenied = false;
    let authStateResolved = false;
    let authGeneration = 0; // guards against stale async work when the account changes mid-load

    let syncChannel = null;
    let authChannel = null;
    try {
      if ('BroadcastChannel' in window) {
        syncChannel = new BroadcastChannel('genealogy_studio_sync');
        authChannel = new BroadcastChannel('genealogy_studio_auth');
      }
    } catch (e) {
      syncChannel = null;
      authChannel = null;
    }



    const escapeAttr = escapeHtml;


    function normEmail(email) {
      return String(email || '').trim().toLowerCase();
    }

    function showToast(msg) {
      const el = document.getElementById('admin-toast');
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(el._timer);
      const hold = String(msg || '').length > 80 ? 7000 : 3200;
      el._timer = setTimeout(() => el.classList.add('hidden'), hold);
    }

    function createBlankDataset() {
      return {
        tree: { id: getDefaultTreeId(), title: getSiteTitle(), revision: 1 },
        superAdminEmail: '',
        loggedInEmail: '',
        centralPersonId: null,
        selectedPersonId: null,
        changeSequence: 0,
        changeEvents: [],
        accessControl: {
          activeSessionRole: 'guest',
          permissions: [],
          auditLog: []
        },
        persons: {},
        families: {}
      };
    }

    function getStoredSuperAdminEmail(stateObj = appState) {
      if (stateObj && stateObj.superAdminEmail) return String(stateObj.superAdminEmail).trim().toLowerCase();
      const superPerm = (stateObj && stateObj.accessControl?.permissions || []).find(pm => pm.role === 'super_admin' && pm.email);
      if (superPerm) return String(superPerm.email).trim().toLowerCase();
      return getConfiguredSuperAdminEmail();
    }

    function isSuperAdminEmail(email, stateObj = appState) {
      const clean = (email || '').trim().toLowerCase();
      const storedSuper = getStoredSuperAdminEmail(stateObj);
      return Boolean(clean && storedSuper && clean === storedSuper);
    }

    function syncTreeEmailsWithPermissions(s) {
      s.accessControl = s.accessControl || { activeSessionRole: 'guest', permissions: [], auditLog: [] };
      s.accessControl.permissions = s.accessControl.permissions || [];
      const perms = s.accessControl.permissions;
      const storedSuper = getStoredSuperAdminEmail(s);

      if (storedSuper) {
        s.superAdminEmail = storedSuper;
        const idx = perms.findIndex(pm => (pm.email || '').toLowerCase() === storedSuper);
        if (idx === -1) {
          perms.unshift({
            id: 'perm_super_admin',
            email: storedSuper,
            personId: findPersonByEmailInState(s, storedSuper)?.id || null,
            role: 'super_admin',
            note: 'Super Admin & Archive Owner',
            updatedAt: new Date().toISOString().slice(0, 10)
          });
        } else {
          perms[idx].role = 'super_admin';
          perms[idx].email = storedSuper;
        }
      }

      // Person emails are contact details only. Sign-in access is granted
      // separately by the Super Admin (View by default, never auto-Edit).
    }

    function findPersonByEmailInState(stateObj, email) {
      const clean = (email || '').trim().toLowerCase();
      if (!clean || !stateObj || !stateObj.persons) return null;
      return Object.values(stateObj.persons).find(p =>
        (p.emails || []).some(em => normEmail(em) === clean)
      ) || null;
    }

    function normalizeState(raw) {
      const s = raw || createBlankDataset();
      s.tree = s.tree || { id: getDefaultTreeId(), title: getSiteTitle(), revision: 1 };
      s.persons = s.persons || {};
      s.families = s.families || {};
      Object.values(s.persons).forEach(p => {
        if (!Array.isArray(p.emails)) p.emails = p.email ? [p.email] : [];
        if (!Array.isArray(p.media)) p.media = [];
      });
      Object.values(s.families).forEach(f => {
        if (f && !Array.isArray(f.children)) f.children = [];
      });
      syncTreeEmailsWithPermissions(s);
      if (!Array.isArray(s.accessControl.auditLog)) s.accessControl.auditLog = [];
      if (!Array.isArray(s.changeEvents)) s.changeEvents = [];
      if (typeof s.changeSequence !== 'number') s.changeSequence = s.changeEvents.length;
      return s;
    }

    let appState = normalizeState(createBlankDataset());
    let filterRole = 'all';
    let changeLogFilter = 'all';
    let changeLogPage = 1;
    const CHANGE_LOG_PAGE_SIZE = 15;
    const ADMIN_TABS = ['overview', 'people', 'changelog', 'data', 'sharing', 'settings'];
    let activeAdminTab = 'overview';
    let pendingAdminGedcomParsed = null;

    function getActiveAdminEmail() {
      if (firebaseUser && firebaseUser.email) {
        return firebaseUser.email.trim().toLowerCase();
      }
      return '';
    }

    function isAdminAuthorized() {
      if (!firebaseUser || !firebaseUser.email || firestoreAccessDenied) return false;
      const email = getActiveAdminEmail();
      if (isSuperAdminEmail(email)) return true;
      const perm = (appState.accessControl?.permissions || []).find(
        pm => (pm.email || '').toLowerCase() === email
      );
      return Boolean(perm && (perm.role === 'super_admin' || perm.role === 'admin'));
    }

    function canManageAccess(stateObj = appState) {
      return isSuperAdminEmail(getActiveAdminEmail(), stateObj);
    }


    const DEFAULT_LIVING_STATUS = 'living';
    const LIVING_BORN_BEFORE_YEAR = 1926;

    function canRunMarkLivingTool() {
      if (typeof canManageAccess === 'function') return canManageAccess();
      const email = typeof getActiveAdminEmail === 'function' ? getActiveAdminEmail() : '';
      return typeof isSuperAdminEmail === 'function' && isSuperAdminEmail(email);
    }

    function personHasDeathEvent(person) {
      return Boolean(person && (person.events || []).some(ev => ev && String(ev.type || '').toUpperCase() === 'DEAT'));
    }

    function birthYearOfPerson(person) {
      if (typeof yearFromPersonEvent === 'function') {
        const y = yearFromPersonEvent(person, 'BIRT');
        if (y) return Number(y);
      }
      const ev = (person && person.events || []).find(e => e && String(e.type || '').toUpperCase() === 'BIRT' && e.date);
      if (!ev) return null;
      const m = String(ev.date).match(/\b((?:1[5-9]|20)\d{2})\b/);
      return m ? Number(m[1]) : null;
    }

    function planMarkLivingForNonDeceased(state) {
      const toLiving = [];
      const alreadyLiving = [];
      const deceased = [];
      const deathRecordNotDeceased = [];
      const bornBeforeCutoff = [];
      for (const [id, person] of Object.entries((state && state.persons) || {})) {
        if (!person) continue;
        const status = person.livingStatus || 'unknown';
        const hasDeath = personHasDeathEvent(person);
        if (hasDeath && person.livingStatus !== 'deceased') {
          deathRecordNotDeceased.push({ id, from: status });
          continue;
        }
        if (person.livingStatus === 'deceased') {
          deceased.push(id);
          continue;
        }
        if (person.livingStatus === 'living') {
          alreadyLiving.push(id);
          continue;
        }
        toLiving.push({ id, from: status });
        const year = birthYearOfPerson(person);
        if (year != null && year < LIVING_BORN_BEFORE_YEAR) bornBeforeCutoff.push({ id, year });
      }
      return { toLiving, alreadyLiving, deceased, deathRecordNotDeceased, bornBeforeCutoff };
    }

    function applyMarkLivingForNonDeceased(state, plan) {
      const items = (plan && plan.toLiving) || planMarkLivingForNonDeceased(state).toLiving;
      let changed = 0;
      for (const item of items) {
        const id = item && item.id ? item.id : item;
        const p = state.persons && state.persons[id];
        if (!p) continue;
        if (p.livingStatus === 'deceased' || p.livingStatus === 'living') continue;
        if (personHasDeathEvent(p)) continue;
        p.livingStatus = 'living';
        changed += 1;
      }
      return changed;
    }

    function formatMarkLivingConfirmation(plan) {
      const fromCounts = {};
      for (const item of (plan.toLiving || [])) {
        const key = item.from || 'unknown';
        fromCounts[key] = (fromCounts[key] || 0) + 1;
      }
      const labelFor = (from) => from === 'unknown' ? 'Unknown' : from === 'living' ? 'Living' : from === 'deceased' ? 'Deceased' : from;
      const changeLines = Object.keys(fromCounts).sort().map(from => {
        const n = fromCounts[from];
        return n + ' ' + (n === 1 ? 'person' : 'people') + ' will change from ' + labelFor(from) + ' to Living.';
      });
      const parts = changeLines.length ? changeLines : ['0 people will change.'];
      if (plan.deathRecordNotDeceased && plan.deathRecordNotDeceased.length) {
        const n = plan.deathRecordNotDeceased.length;
        parts.push(n + (n === 1 ? ' person has' : ' people have') + ' a death record but ' + (n === 1 ? 'is' : 'are') + ' not marked deceased — left unchanged.');
      }
      if (plan.alreadyLiving && plan.alreadyLiving.length) {
        parts.push(plan.alreadyLiving.length + ' already marked Living.');
      }
      if (plan.deceased && plan.deceased.length) {
        parts.push(plan.deceased.length + ' already marked Deceased.');
      }
      if (plan.bornBeforeCutoff && plan.bornBeforeCutoff.length) {
        parts.push(plan.bornBeforeCutoff.length + ' of those changing were born before ' + LIVING_BORN_BEFORE_YEAR + '.');
      }
      return parts.join(' ');
    }

    async function loadLatestTreeForMaintenance() {
      if (typeof testWriteImpl === 'function') return appState;
      try {
        if (typeof getArchiveDocRef !== 'function' || typeof getDoc !== 'function') return appState;
        const mainRef = getArchiveDocRef();
        const logRef = typeof getLogDocRef === 'function' ? getLogDocRef() : null;
        if (!mainRef) return appState;
        const [snap, logSnap] = logRef
          ? await Promise.all([getDoc(mainRef), getDoc(logRef)])
          : [await getDoc(mainRef), null];
        if (snap && snap.exists() && typeof applyLoadedDocuments === 'function') {
          applyLoadedDocuments(snap.data(), logSnap && logSnap.exists() ? logSnap.data() : null);
        }
      } catch (err) {
        console.warn('Could not refresh the latest tree before the living-status update:', err);
        if (typeof showToast === 'function') {
          showToast('Could not refresh the latest tree. Using the copy already on this page.');
        }
      }
      return appState;
    }

    function refreshLivingStatusCard(plan) {
      const can = canRunMarkLivingTool();
      const card = document.getElementById('living-status-card');
      if (card) card.classList.toggle('hidden', !can);
      const computed = plan || planMarkLivingForNonDeceased(appState);
      const n = computed.toLiving.length;
      const summary = document.getElementById('living-status-summary');
      if (summary) {
        summary.textContent = n
          ? (n + (n === 1 ? ' person is' : ' people are') + ' not marked deceased and have no death record.')
          : 'No people need updating. Everyone not marked deceased already has Living status, or has a death record.';
      }
      const actionBtn = document.getElementById('btn-mark-living');
      if (actionBtn) actionBtn.disabled = !can || n === 0;
    }

    function closeMarkLivingDialog() {
      document.getElementById('living-confirm-modal')?.classList.add('hidden');
    }

    async function openMarkLivingDialog() {
      if (!canRunMarkLivingTool()) {
        if (typeof showToast === 'function') showToast('Only the Super Admin can mark people as Living in bulk.');
        return;
      }
      const actionBtn = document.getElementById('btn-mark-living');
      if (actionBtn) actionBtn.disabled = true;
      try {
        await loadLatestTreeForMaintenance();
      } finally {
        if (actionBtn) actionBtn.disabled = false;
      }
      const plan = planMarkLivingForNonDeceased(appState);
      refreshLivingStatusCard(plan);
      const modal = document.getElementById('living-confirm-modal');
      const desc = document.getElementById('living-confirm-desc');
      if (desc) desc.textContent = formatMarkLivingConfirmation(plan);
      const confirmBtn = document.getElementById('btn-living-confirm');
      if (confirmBtn) confirmBtn.disabled = plan.toLiving.length === 0;
      if (modal) modal.classList.remove('hidden');
    }

    function runMarkLivingMutation(summary, plan) {
      const mutator = (s) => { applyMarkLivingForNonDeceased(s, plan); };
      if (typeof commitMutation === 'function') return commitMutation(summary, mutator);
      if (typeof showToast === 'function') showToast('This change could not be saved from here.');
      return false;
    }

    async function confirmMarkLiving() {
      if (!canRunMarkLivingTool()) {
        if (typeof showToast === 'function') showToast('Only the Super Admin can mark people as Living in bulk.');
        return;
      }
      const plan = planMarkLivingForNonDeceased(appState);
      if (!plan.toLiving.length) {
        refreshLivingStatusCard(plan);
        closeMarkLivingDialog();
        return;
      }
      const summary = 'Marked ' + plan.toLiving.length + ' ' + (plan.toLiving.length === 1 ? 'person' : 'people') + ' as Living';
      const ok = runMarkLivingMutation(summary, plan);
      closeMarkLivingDialog();
      if (ok && typeof ok.then === 'function') {
        try { await ok; } catch (err) { console.error(err); }
      }
      refreshLivingStatusCard();
    }


    /* =====================================================================
     * FIREBASE HOSTING AUTO-CONFIG & NON-BLOCKING PERSISTENT GOOGLE SSO
     * ===================================================================== */
    // Prefer the current *.web.app host for Auth so sign-in uses /__/auth/handler
    // on this origin instead of <project>.firebaseapp.com from /__/firebase/init.json.
    async function resolveFirebaseConfig() {
      let config = null;
      if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) {
        config = window.FIREBASE_CONFIG;
      } else if (typeof __firebase_config !== 'undefined' && __firebase_config) {
        config = JSON.parse(__firebase_config);
      } else {
        try {
          const resp = await fetch('/__/firebase/init.json', { cache: 'no-store' });
          if (resp.ok) {
            const jsonCfg = await resp.json();
            if (jsonCfg && jsonCfg.apiKey) config = jsonCfg;
          }
        } catch (e) {}
      }
      return applyHostingAuthDomain(config);
    }

    function getArchiveDocRef() {
      if (!db) return null;
      return doc(db, 'archives', getArchiveId());
    }

    function getLogDocRef() {
      if (!db) return null;
      return doc(db, 'archives', getArchiveLogId());
    }

    function stopDocListeners() {
      if (unsubscribeArchive) { unsubscribeArchive(); unsubscribeArchive = null; }
      if (unsubscribeLog) { unsubscribeLog(); unsubscribeLog = null; }
    }




    function assembleStateFromDocs(mainData, logData) {
      if (!mainData && !logData) return null;
      let parsed = null;
      if (mainData && mainData.payloadJson) {
        parsed = JSON.parse(mainData.payloadJson);
      } else if (mainData) {
        parsed = createBlankDataset();
      } else {
        parsed = createBlankDataset();
      }
      // The top-level superAdminEmail is protected by the rules (it must equal
      // the hardcoded Super Admin). Never trust a different value an editor
      // may have written into payloadJson.
      if (parsed && mainData && typeof mainData.superAdminEmail === 'string' && mainData.superAdminEmail.trim()) {
        parsed.superAdminEmail = mainData.superAdminEmail.trim().toLowerCase();
      }
      const extracted = extractEmbeddedLog(parsed);
      const mergedLog = mergeLogStates(extracted.embeddedLog, logStateFromLogDoc(logData));
      const state = normalizeState({
        ...extracted.tree,
        changeEvents: mergedLog.changeEvents,
        changeSequence: mergedLog.changeSequence
      });
      // Roles come from the rules-protected lists on the document, not from
      // accessControl.permissions in payloadJson (which any editor can write).
      const aclReport = reconcilePermissionsWithMainDoc(state, mainData, {
        superAdminEmail: getStoredSuperAdminEmail(state),
        findPersonByEmail: (em) => findPersonByEmailInState(state, em)
      });
      return {
        state,
        aclReport,
        hadEmbeddedLog: Boolean(extracted.hadEmbeddedLog && ((extracted.embeddedLog?.changeEvents || []).length > 0 || (extracted.embeddedLog?.changeSequence || 0) > 0)),
        hadEmbeddedShape: extracted.hadEmbeddedLog
      };
    }

    // Parse the main Firestore document into app state. If a dedicated log document
    // is also supplied, the change log is taken from there (with a safe merge if the
    // main payload still has a legacy embedded log).
    function stateFromArchiveDoc(data, logData) {
      const assembled = assembleStateFromDocs(data, logData);
      return assembled ? assembled.state : null;
    }

    function applyLoadedDocuments(mainData, logData) {
      const assembled = assembleStateFromDocs(mainData, logData);
      if (!assembled) return null;
      appState = assembled.state;
      pendingLogMigration = assembled.hadEmbeddedLog || assembled.hadEmbeddedShape;
      archiveBaseUpdatedAt = (mainData && mainData.updatedAt) || null;
      archiveBaseRevision = (mainData && mainData.revision != null) ? mainData.revision : null;
      logBaseUpdatedAt = (logData && logData.updatedAt) || null;
      latestMainData = mainData || null;
      latestLogData = logData || null;
      notifyAclReport(assembled.aclReport);
      return assembled;
    }

    let lastAclNotice = '';
    function notifyAclReport(report) {
      if (!report || !report.applied) return;
      const msg = describeAclReport(report);
      if (msg) console.warn(msg);
      let text = msg;
      if (report.legacyNoAdminList && report.unverifiedAdmins.length) {
        text = (text ? text + ' ' : '') + 'Please review the Admin role for: ' + report.unverifiedAdmins.join(', ')
          + '. Older data could not confirm it; your next save stores roles in the protected lists.';
      }
      if (!text || !canManageAccess()) return;
      if (text === lastAclNotice) return;
      lastAclNotice = text;
      try { showToast(text); } catch (e) {}
    }

    function frozenAccessListsFromDoc(stateObj) {
      return frozenAccessListsFromMainDoc(latestMainData, getStoredSuperAdminEmail(stateObj));
    }

    function computeRuleAccessLists(stateObj) {
      // Editors and in-app Admins must send the exact lists already on the
      // document (Option B). Only the Super Admin rebuilds them, from
      // permissions that were reconciled with the protected lists on load.
      if (!canManageAccess(stateObj)) {
        return frozenAccessListsFromDoc(stateObj);
      }
      return computeAccessListsFromPermissions(stateObj.accessControl?.permissions || [], getStoredSuperAdminEmail(stateObj));
    }


    /* =====================================================================
     * SERIALIZED, CONFLICT-AWARE FIRESTORE SAVES
     * - Saves run one at a time and coalesce (only the newest state is sent).
     * - A transaction checks that nobody else saved since our copy was loaded,
     *   so one session can no longer silently overwrite another's edits.
     * - The family tree is written to <span data-archive-path>archives/familytree</span>. The change log
     *   (history and revert snapshots) is written to <span data-archive-log-path>archives/familytree_log</span>
     *   in the same transaction or batch, so each document has its own 1 MB budget.
     * - If the log document would overflow, the oldest snapshots (then oldest
     *   entries) are trimmed; the tree save is not blocked by the log size.
     * ===================================================================== */
    let archiveBaseUpdatedAt = null;  // updatedAt of the remote main doc appState derives from
    let archiveBaseRevision = null;   // revision of that same remote main doc
    let logBaseUpdatedAt = null;      // updatedAt of the remote log doc
    let pendingSaveState = null;
    let saveChain = Promise.resolve();
    let pendingLogMigration = false;
    let latestMainData = null;
    let latestLogData = null;









    function shouldDeferLogMigration() {
      return Boolean(pendingLogMigration);
    }

    // By default this returns the split (migrated) shape used for size estimates and backups.
    // Pass keepEmbedded: true (or rely on a pending migration during a regular save) to leave
    // the log inside payloadJson so a tree edit does not move history without a backup.
    function splitStateForWrite(stateObj, opts = {}) {
      const src = stateObj || createBlankDataset();
      const keepEmbedded = opts.keepEmbedded === true;
      const tree = {};
      Object.keys(src).forEach(k => {
        if (keepEmbedded || (k !== 'changeEvents' && k !== 'changeSequence')) tree[k] = src[k];
      });
      return {
        tree,
        log: {
          changeEvents: Array.isArray(src.changeEvents) ? src.changeEvents : [],
          changeSequence: typeof src.changeSequence === 'number' ? src.changeSequence : 0
        },
        keepEmbedded
      };
    }



    function buildMainDocFields(treeState, payloadJson, metaExtras = {}) {
      const aclLists = computeRuleAccessLists(treeState);
      return {
        title: treeState.tree?.title || getSiteTitle(),
        revision: treeState.tree?.revision || 1,
        superAdminEmail: aclLists.superAdminEmail || '',
        authorizedEmails: aclLists.authorizedEmails || [],
        editorEmails: aclLists.editorEmails || [],
        ...(Array.isArray(aclLists.adminEmails) ? { adminEmails: aclLists.adminEmails } : {}),
        updatedAt: metaExtras.updatedAt || new Date().toISOString(),
        updatedByEmail: metaExtras.updatedByEmail != null ? metaExtras.updatedByEmail : (getActiveAdminEmail() || ''),
        updatedByUid: metaExtras.updatedByUid != null ? metaExtras.updatedByUid : ((firebaseUser && firebaseUser.uid) || ''),
        payloadJson: payloadJson != null ? String(payloadJson) : JSON.stringify(treeState)
      };
    }

    function buildLogDocFields(logState, metaExtras = {}) {
      return {
        changeLogJson: JSON.stringify({
          changeEvents: (logState && logState.changeEvents) || [],
          changeSequence: (logState && typeof logState.changeSequence === 'number') ? logState.changeSequence : 0
        }),
        updatedAt: metaExtras.updatedAt || new Date().toISOString(),
        updatedByEmail: metaExtras.updatedByEmail != null ? metaExtras.updatedByEmail : (getActiveAdminEmail() || ''),
        updatedByUid: metaExtras.updatedByUid != null ? metaExtras.updatedByUid : ((firebaseUser && firebaseUser.uid) || '')
      };
    }


    /* =====================================================================
     * COMPACT CHANGE LOG (osr-diff-v1)
     * Each entry stores a diff of only the touched people, families, title
     * and permissions. At most LOG_CHECKPOINT_LIMIT full snapshots are kept
     * as checkpoints so a revert can be rebuilt and checked.
     * ===================================================================== */
























    function estimateAllStorage(stateObj, metaExtras) {
      const split = splitStateForWrite(stateObj);
      const mainFields = buildMainDocFields(split.tree, null, metaExtras);
      const logFields = buildLogDocFields(split.log, metaExtras);
      return {
        main: describeMainStorage(mainFields, split.tree),
        log: describeLogStorage(logFields, split.log)
      };
    }

    // Kept as a convenience for tests and older call sites: estimate the MAIN document only.
    function estimateArchiveStorage(stateObj, payloadJson, metaExtras) {
      const split = splitStateForWrite(stateObj);
      const fields = buildMainDocFields(split.tree, payloadJson, metaExtras);
      return describeMainStorage(fields, split.tree);
    }

    function prepareMainWrite(treeState, metaExtras = {}) {
      const baseMeta = buildMainDocFields(treeState, '', metaExtras);
      delete baseMeta.payloadJson;
      const reserved = reservedSizeForFields(baseMeta, 'payloadJson', getArchiveDocPath());
      const json = JSON.stringify(treeState);
      const fit = jsonFitsInDoc(json, reserved);
      const fields = { ...baseMeta, payloadJson: json };
      const estimate = describeMainStorage(fields, treeState);
      return { ok: fit.ok, json, fields, estimate, bytes: fit.total, reason: fit.ok ? null : (fit.rulesOk ? 'document' : 'payloadJson') };
    }

    // May trim oldest snapshots, then drop oldest entries, in place on logState.changeEvents.
    // Always returns ok: true once the log fits (an empty log always fits), so a large log
    // never blocks a tree save.
    function prepareLogWrite(logState, metaExtras = {}) {
      const baseMeta = {
        updatedAt: metaExtras.updatedAt || new Date().toISOString(),
        updatedByEmail: metaExtras.updatedByEmail != null ? metaExtras.updatedByEmail : (getActiveAdminEmail() || ''),
        updatedByUid: metaExtras.updatedByUid != null ? metaExtras.updatedByUid : ((firebaseUser && firebaseUser.uid) || '')
      };
      const reserved = reservedSizeForFields(baseMeta, 'changeLogJson', getArchiveLogDocPath());
      const pack = () => JSON.stringify({
        changeEvents: logState.changeEvents || [],
        changeSequence: typeof logState.changeSequence === 'number' ? logState.changeSequence : 0
      });

      const trimmed = trimChangeLogToFit(logState, pack, jsonFitsInDoc, reserved);
      let json = trimmed.json;
      let fit = trimmed.fit;
      let trimmedSnapshots = trimmed.trimmedSnapshots;
      let droppedEntries = trimmed.droppedEntries;

      const fields = { ...baseMeta, changeLogJson: json };
      const estimate = describeLogStorage(fields, logState);
      return {
        ok: true,
        fitted: fit.ok,
        json,
        fields,
        estimate,
        bytes: fit.total,
        trimmedSnapshots,
        droppedEntries
      };
    }

    // Compatibility wrapper used by tests: prepare both halves of a state object.
    function prepareArchiveWrite(stateObj, metaExtras = {}) {
      const split = splitStateForWrite(stateObj);
      const main = prepareMainWrite(split.tree, metaExtras);
      const log = prepareLogWrite(split.log, metaExtras);
      return { ok: main.ok, main, log, estimate: main.estimate, bytes: main.bytes, trimmed: (log.trimmedSnapshots || 0) + (log.droppedEntries || 0), fields: main.fields, json: main.json, reason: main.reason };
    }




    function isDataImageUrl(url) {
      return /^data:image\//i.test(String(url || '').trim());
    }

    function classifyPhotoUrl(url) {
      const raw = String(url || '').trim();
      if (!raw || /^blob:/i.test(raw)) return null;
      if (isDataImageUrl(raw) || /^data:/i.test(raw)) return 'embedded';
      if (/^https:\/\//i.test(raw) && (/firebasestorage\.googleapis\.com/i.test(raw) || /\.firebasestorage\.app/i.test(raw))) return 'storage';
      if (/^https?:\/\//i.test(raw)) return 'external';
      return null;
    }

    function collectPhotoStorageStats(stateObj) {
      const state = stateObj || appState;
      let peopleWithPhotos = 0;
      let storageCount = 0;
      let embeddedCount = 0;
      let externalCount = 0;
      let embeddedBytes = 0;
      const people = Object.values((state && state.persons) || {});
      people.forEach((person) => {
        if (!person) return;
        const urls = [];
        if (person.photoUrl) urls.push(person.photoUrl);
        (person.media || []).forEach((item) => { if (item && item.url) urls.push(item.url); });
        let hasPhoto = false;
        urls.forEach((url) => {
          const kind = classifyPhotoUrl(url);
          if (!kind) return;
          hasPhoto = true;
          if (kind === 'storage') storageCount += 1;
          else if (kind === 'embedded') {
            embeddedCount += 1;
            embeddedBytes += utf8ByteLength(url);
          } else if (kind === 'external') externalCount += 1;
        });
        if (hasPhoto) peopleWithPhotos += 1;
      });
      return {
        peopleWithPhotos,
        peopleCount: people.length,
        storageCount,
        embeddedCount,
        externalCount,
        embeddedBytes,
        photoCount: storageCount + embeddedCount + externalCount
      };
    }

    function renderPhotoStorageStats(stats) {
      const card = document.getElementById('admin-photo-stats-card');
      if (!card) return stats;
      const data = stats || collectPhotoStorageStats(appState);
      const peopleEl = document.getElementById('admin-photo-stats-people');
      if (peopleEl) {
        peopleEl.textContent = data.peopleWithPhotos === 1
          ? `1 of ${data.peopleCount} people has a photo`
          : `${data.peopleWithPhotos} of ${data.peopleCount} people have photos`;
      }
      const setNum = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
      setNum('admin-photo-stats-storage', data.storageCount);
      setNum('admin-photo-stats-embedded', data.embeddedCount);
      setNum('admin-photo-stats-external', data.externalCount);
      const sizeEl = document.getElementById('admin-photo-stats-embedded-size');
      if (sizeEl) {
        sizeEl.textContent = data.embeddedCount
          ? `Embedded photos in the tree document: about ${formatStorageKb(data.embeddedBytes)} (${data.embeddedBytes.toLocaleString()} bytes)`
          : 'Embedded photos in the tree document: none';
      }
      return data;
    }

    function renderStorageMeter(estimates, opts = {}) {
      const card = document.getElementById('admin-storage-card');
      if (!card) return;
      try { renderPhotoStorageStats(collectPhotoStorageStats(appState)); } catch (e) {}
      const all = (estimates && estimates.main) ? estimates : estimateAllStorage(appState);
      const mainTone = paintStorageRow('main', all.main, { blocked: opts.blockedMain || opts.blocked });
      const logTone = paintStorageRow('log', all.log, { blocked: false });
      const counts = document.getElementById('admin-storage-counts');
      if (counts && all.main) {
        const people = all.main.personCount === 1 ? 'person' : 'people';
        const families = all.main.familyCount === 1 ? 'family' : 'families';
        counts.textContent = `${all.main.personCount} ${people} · ${all.main.familyCount} ${families}`;
      }
      const worst = (opts.blockedMain || opts.blocked || (all.main && all.main.percent >= 100) || (all.log && all.log.percent >= 100))
        ? 'rose'
        : ((all.main && all.main.percent >= 70) || (all.log && all.log.percent >= 70) ? (mainTone === 'rose' || logTone === 'rose' ? 'rose' : 'amber') : 'emerald');
      card.className = `bg-white border rounded-2xl p-4 sm:p-5 shadow-2xs ${
        worst === 'rose' ? 'border-rose-300' : worst === 'amber' ? 'border-amber-300' : 'border-parchment-300'
      }`;

      const projected = document.getElementById('admin-storage-projected');
      if (projected) {
        if (opts.projected && all.main && all.log) {
          if (opts.blockedMain || opts.blocked) {
            projected.textContent = `This save would use ${formatStorageKb(all.main.total)} for the tree document (${Math.round(all.main.percent)}%) and is over the safe limit, so it was not written. The change log was not changed.`;
            projected.className = 'mt-1.5 text-[11px] text-rose-800 font-medium';
          } else {
            projected.textContent = `This save would use ${formatStorageKb(all.main.total)} of 1 MB for the tree document (${Math.round(all.main.percent)}%) and ${formatStorageKb(all.log.total)} of 1 MB for the change log (${Math.round(all.log.percent)}%).`;
            projected.className = 'mt-1.5 text-[11px] text-slate-600';
          }
        } else {
          projected.className = 'hidden mt-1.5 text-[11px] text-slate-600';
          projected.textContent = '';
        }
      }

      const alert = document.getElementById('admin-storage-alert');
      if (alert) {
        const msgs = [];
        if (opts.blockedMain || opts.blocked) {
          msgs.push('The tree document is over Firestore\'s 1 MB per-document limit. Remove media or notes before saving again.');
        } else if (all.main && all.main.percent >= 90) {
          msgs.push('The tree document is above 90% of Firestore\'s 1 MB limit. Consider removing unused notes and media.');
        }
        if (all.log && all.log.percent >= 90) {
          msgs.push('The change log is above 90% of its own 1 MB limit. The oldest snapshots or entries will be trimmed automatically so tree saves can continue.');
        }
        if (msgs.length) {
          alert.classList.remove('hidden');
          alert.textContent = msgs.join(' ');
          const rose = opts.blockedMain || opts.blocked || (all.main && all.main.percent >= 100) || (all.log && all.log.percent >= 100);
          alert.className = `mt-2 text-[11px] font-medium rounded-lg px-2.5 py-1.5 ${
            rose ? 'bg-rose-50 text-rose-900 border border-rose-200' : 'bg-amber-50 text-amber-950 border border-amber-200'
          }`;
        } else {
          alert.classList.add('hidden');
          alert.textContent = '';
          alert.className = 'hidden mt-2 text-[11px] font-medium rounded-lg px-2.5 py-1.5';
        }
      }
    }
















    function setMigrationError(formatted) {
      const el = document.getElementById('admin-log-migration-error');
      if (!el) return;
      if (!formatted) {
        el.classList.add('hidden');
        el.textContent = '';
        el.removeAttribute('data-error-code');
        return;
      }
      el.classList.remove('hidden');
      el.setAttribute('data-error-code', formatted.code);
      el.textContent = formatted.text;
    }

    let forceLogWrite = false;

    function persistState(stateObj) {
      if (!firebaseUser || !firebaseUser.email || !(isAdminAuthorized())) {
        return Promise.resolve({
          ok: false,
          error: { code: 'not-authorized', message: 'You must be signed in with an authorized admin account to save.' }
        });
      }
      pendingSaveState = stateObj;
      saveChain = saveChain.then(runQueuedSave).catch(err => {
        console.error('Save queue error:', err);
        return { ok: false, error: err };
      });
      return saveChain;
    }





    async function runQueuedSave() {
      const hooks = adminSaveHooks();
      const stateObj = pendingSaveState;
      pendingSaveState = null;
      if (!stateObj) return { ok: true, skipped: true };
      if (typeof testWriteImpl !== 'function' && typeof navigator !== 'undefined' && navigator.onLine === false) {
        const err = { code: 'unavailable', offline: true, message: OFFLINE_SAVE_MESSAGE, userMessage: OFFLINE_SAVE_MESSAGE };
        if (typeof hooks.onOffline === 'function') hooks.onOffline(err);
        else hooks.onError(err);
        return { ok: false, offline: true, error: err };
      }
      if (stateObj !== appState) {
        hooks.onStale();
        return { ok: false, stale: true, error: { code: 'aborted', message: 'Another session saved first. The latest version is loaded — please repeat your last change.' } };
      }
      if (!firebaseUser || !firebaseUser.email) {
        return { ok: false, error: { code: 'unauthenticated', message: 'You are not signed in.' } };
      }

      syncTreeEmailsWithPermissions(stateObj);
      // Pages that cannot manage access never write access changes into
      // payloadJson: rebuild permissions from the protected lists first.
      if (!canManageAccess(stateObj) && latestMainData) {
        reconcilePermissionsWithMainDoc(stateObj, latestMainData, {
          superAdminEmail: getStoredSuperAdminEmail(stateObj),
          findPersonByEmail: (em) => findPersonByEmailInState(stateObj, em)
        });
      }
      // Server-side conflict guard: the rules accept only stored revision + 1.
      stateObj.tree = stateObj.tree || {};
      stateObj.tree.revision = nextArchiveRevision(archiveBaseRevision, stateObj.tree.revision);
      const stamp = new Date().toISOString();
      const meta = {
        updatedAt: stamp,
        updatedByEmail: getActiveAdminEmail(),
        updatedByUid: firebaseUser.uid
      };
      const deferMigration = shouldDeferLogMigration() && !forceLogWrite;
      const split = splitStateForWrite(stateObj, { keepEmbedded: deferMigration });
      const preparedMain = prepareMainWrite(split.tree, meta);
      const preparedLog = deferMigration
        ? { ok: true, fields: null, estimate: estimateAllStorage(stateObj).log, trimmedSnapshots: 0, droppedEntries: 0 }
        : prepareLogWrite(split.log, meta);
      renderStorageMeter({ main: preparedMain.estimate, log: preparedLog.estimate }, { projected: true, blockedMain: !preparedMain.ok });
      if (!preparedMain.ok) {
        hooks.onTooLarge(preparedMain.bytes);
        return { ok: false, blocked: true, error: { code: 'resource-exhausted', message: 'The tree document (~' + formatStorageKb(preparedMain.bytes) + ') exceeds Firestore\'s 1 MB single-document limit.' } };
      }
      if (preparedLog.trimmedSnapshots > 0 || preparedLog.droppedEntries > 0) {
        hooks.onLogTrimmed(preparedLog.trimmedSnapshots, preparedLog.droppedEntries);
      }
      if (preparedMain.estimate.percent >= 90) hooks.onNearLimit(preparedMain.estimate, 'tree');
      else if (preparedLog.estimate.percent >= 90) hooks.onNearLimit(preparedLog.estimate, 'log');

      const mainRef = getArchiveDocRef();
      const logRef = getLogDocRef();
      if (!db || !mainRef || !logRef) {
        return { ok: false, error: { code: 'failed-precondition', message: 'Firestore is not initialized.' } };
      }
      const baseMain = archiveBaseUpdatedAt;
      const baseLog = logBaseUpdatedAt;
      const baseMainRevision = archiveBaseRevision;
      rememberOwnStamp(stamp);
      hooks.onSaving();

      try {
        const conflict = await writeArchiveAndLog(mainRef, logRef, preparedMain.fields, deferMigration ? null : preparedLog.fields, baseMain, baseLog, baseMainRevision);
        if (conflict) {
          hooks.onConflict(conflict.main, conflict.log);
          return { ok: false, conflict: true, error: { code: 'aborted', message: 'Someone else saved first. Their latest version is shown — please repeat your last change.' } };
        }
        archiveBaseUpdatedAt = stamp;
        if (preparedMain.fields && preparedMain.fields.revision != null) {
          archiveBaseRevision = preparedMain.fields.revision;
        }
        if (!deferMigration) logBaseUpdatedAt = stamp;
        latestMainData = preparedMain.fields;
        if (!deferMigration) latestLogData = preparedLog.fields;
        if (forceLogWrite) pendingLogMigration = false;
        // pendingLogMigration stays true until migrate-log.html completes the one-time move,
        // unless a Super Admin reset (or similar forceWriteLog) has just written the log document.
        if (syncChannel) {
          try { syncChannel.postMessage({ type: 'FIRESTORE_COMMITTED' }); } catch (e) {}
        }
        hooks.onSaved();
        scheduleGuestViewRefresh();
        return { ok: true };
      } catch (err) {
        hooks.onError(err);
        return { ok: false, error: err };
      }
    }

    function setAdminBadge(text) {
      const badge = document.getElementById('admin-cloud-badge');
      if (badge) badge.textContent = text;
    }

    function describeLogTrim(snapshots, entries) {
      const parts = [];
      if (snapshots > 0) parts.push(`Before/After snapshots from the ${snapshots} oldest change-log entr${snapshots === 1 ? 'y' : 'ies'}`);
      if (entries > 0) parts.push(`${entries} oldest change-log entr${entries === 1 ? 'y' : 'ies'}`);
      return parts.join(' and ');
    }

    function adminSaveHooks() {
      return {
        onSaving: () => setAdminBadge('Saving to Firestore...'),
        onSaved: () => {
          setAdminBadge('Firestore Saved ✓');
          renderAdmin();
        },
        onLogTrimmed: (snapshots, entries) => {
          showToast(`Change log near its own 1 MB limit — trimmed ${describeLogTrim(snapshots, entries)} so the tree could still be saved.`);
          renderAdmin();
        },
        onTooLarge: (bytes) => {
          setAdminBadge('Archive Too Large');
          showToast(`Not saved: the tree document (~${formatStorageKb(bytes)}) exceeds Firestore's 1 MB single-document limit. Remove media or notes, then try again.`);
          renderStorageMeter(estimateAllStorage(appState), { projected: true, blockedMain: true });
        },
        onNearLimit: (estimate, which) => {
          const label = which === 'log' ? 'change log' : 'tree document';
          showToast(`Warning: the ${label} is at ${Math.round(estimate.percent)}% of Firestore's 1 MB document limit.`);
        },
        onStale: () => {
          setAdminBadge('Firestore Synced ✓');
          showToast('Another session saved first. The latest version is loaded — please repeat your last change.');
          renderAdmin();
        },
        onConflict: (remoteMain, remoteLog) => {
          try {
            applyLoadedDocuments(remoteMain || latestMainData, remoteLog || latestLogData);
          } catch (e) {
            console.error('Conflict reload parse error:', e);
          }
          setAdminBadge('Firestore Synced ✓');
          renderAdmin();
          showToast('Someone else saved first. Their latest version is shown — please repeat your last change.');
        },
        onOffline: (err) => {
          console.warn('Firestore admin save skipped because this device is offline:', err);
          setAdminBadge('Offline — save when you reconnect');
          showToast(OFFLINE_SAVE_MESSAGE);
        },
        onError: (err) => {
          console.error('Firestore admin save error:', err);
          const formatted = formatFirestoreError(err);
          setAdminBadge(formatted.offline ? 'Offline — save when you reconnect' : 'Firestore Write Blocked');
          showToast(formatted.text);
        }
      };
    }


    async function initAdminFirebase() {
      const config = await resolveFirebaseConfig();
      if (!config) {
        authStateResolved = true;
        document.getElementById('admin-cloud-badge').textContent = 'Firebase Config Missing';
        document.getElementById('admin-cloud-uid').textContent = 'Missing /__/firebase/init.json';
        renderAdmin();
        return;
      }

      try {
        firebaseApp = initializeApp(config);
        auth = getAuth(firebaseApp);
        db = await openFirestoreDatabase(firebaseApp);

        try {
          await setPersistence(auth, browserLocalPersistence);
        } catch (persistErr) {
          try {
            await setPersistence(auth, browserSessionPersistence);
          } catch (sessErr) {}
        }

        // Non-blocking redirect result check so iframes never stall
        getRedirectResult(auth).catch((redirErr) => {
          console.warn('Redirect sign-in note:', redirErr?.code || redirErr);
        });

        onAuthStateChanged(auth, async (user) => {
          const myGeneration = ++authGeneration;
          authStateResolved = true;
          firebaseUser = user;
          firestoreAccessDenied = false;
          archiveBaseUpdatedAt = null;
          archiveBaseRevision = null;
          logBaseUpdatedAt = null;
          pendingSaveState = null;
          pendingLogMigration = false;
          latestMainData = null;
          latestLogData = null;
          stopDocListeners();

          if (!user || !user.email) {
            appState = normalizeState(createBlankDataset());
            purgeLocalCachedRecords();
            document.getElementById('admin-cloud-uid').textContent = 'Not signed in';
            document.getElementById('admin-cloud-badge').textContent = 'Sign In Required';
            stopDocListeners();
            renderAdmin();
            return;
          }

          const signedEmail = user.email.trim().toLowerCase();
          document.getElementById('admin-cloud-uid').textContent = user.uid;
          document.getElementById('admin-cloud-badge').textContent = 'Loading Firestore...';

          const docRef = getArchiveDocRef();
          const logRef = getLogDocRef();
          try {
            const [snap, logSnap] = await Promise.all([getDoc(docRef), getDoc(logRef)]);
            if (myGeneration !== authGeneration) return; // account changed while loading
            if (!snap.exists()) {
              const expected = getConfiguredSuperAdminEmail();
              if (expected && signedEmail !== expected) {
                firestoreAccessDenied = true;
                appState = normalizeState(createBlankDataset());
                showToast('This archive has not been created yet. Sign in as the Super Admin to set it up.');
                renderAdmin();
                return;
              }
              const fresh = createBlankDataset();
              fresh.superAdminEmail = expected || signedEmail;
              syncTreeEmailsWithPermissions(fresh);
              appState = normalizeState(fresh);
              await persistState(appState);
              if (myGeneration !== authGeneration) return;
              showToast(`Initialized ${getSiteTitle()} in Firestore (Super Admin: ${fresh.superAdminEmail})`);
            } else {
              applyLoadedDocuments(snap.data(), logSnap.exists() ? logSnap.data() : null);
            }
          } catch (readErr) {
            if (myGeneration !== authGeneration) return;
            if (readErr?.code === 'permission-denied') {
              firestoreAccessDenied = true;
              appState = normalizeState(createBlankDataset());
              purgeLocalCachedRecords();
              document.getElementById('admin-cloud-badge').textContent = 'Access Restricted';
              renderAdmin();
              return;
            }
            console.error('Initial admin Firestore check error:', readErr);
          }

          stopDocListeners();
          const onDenied = (err, label) => {
            if (myGeneration !== authGeneration) return;
            if (err?.code === 'permission-denied') {
              firestoreAccessDenied = true;
              appState = normalizeState(createBlankDataset());
              purgeLocalCachedRecords();
              document.getElementById('admin-cloud-badge').textContent = 'Access Restricted';
              renderAdmin();
            } else {
              console.error(label, err);
              document.getElementById('admin-cloud-badge').textContent = 'Sync Interrupted';
            }
          };
          unsubscribeArchive = onSnapshot(
            docRef,
            (docSnap) => {
              if (myGeneration !== authGeneration) return;
              if (!firebaseUser || !firebaseUser.email) return;
              if (!docSnap.exists()) return;
              const wasDenied = firestoreAccessDenied;
              firestoreAccessDenied = false;
              const data = docSnap.data();
              if (!data) return;
              if (isOwnEchoSnapshot(data) && !wasDenied) {
                if (data.updatedAt) archiveBaseUpdatedAt = data.updatedAt;
                if (data.revision != null) archiveBaseRevision = data.revision;
                latestMainData = data;
                setAdminBadge('Firestore Synced ✓');
                return;
              }
              if (data.updatedAt && data.updatedAt === archiveBaseUpdatedAt && !wasDenied) {
                latestMainData = data;
                return;
              }
              try {
                applyLoadedDocuments(data, latestLogData);
                diffCache.clear();
                setAdminBadge('Firestore Synced ✓');
                renderAdmin();
              } catch (err) {
                console.error('Snapshot parse error:', err);
              }
            },
            (err) => onDenied(err, 'Admin onSnapshot error:')
          );
          unsubscribeLog = onSnapshot(
            logRef,
            (docSnap) => {
              if (myGeneration !== authGeneration) return;
              if (!firebaseUser || !firebaseUser.email) return;
              const data = docSnap.exists() ? (docSnap.data() || null) : null;
              if (data && isOwnEchoSnapshot(data)) {
                if (data.updatedAt) logBaseUpdatedAt = data.updatedAt;
                latestLogData = data;
                return;
              }
              if (data && data.updatedAt && data.updatedAt === logBaseUpdatedAt) {
                latestLogData = data;
                return;
              }
              try {
                applyLoadedDocuments(latestMainData, data);
                diffCache.clear();
                setAdminBadge('Firestore Synced ✓');
                renderAdmin();
              } catch (err) {
                console.error('Change log snapshot parse error:', err);
              }
            },
            (err) => onDenied(err, 'Admin change-log onSnapshot error:')
          );

          renderAdmin();
          if (isAdminAuthorized() && new URLSearchParams(window.location.search).get('import') === '1') {
            document.getElementById('btn-banner-open-gedcom')?.click();
          }
        });

        await Promise.race([
          auth.authStateReady(),
          new Promise(resolve => setTimeout(resolve, 2500))
        ]);
        authStateResolved = true;
        renderAdmin();
      } catch (err) {
        authStateResolved = true;
        console.error('Admin Firebase init failed:', err);
        document.getElementById('admin-cloud-badge').textContent = 'Firebase Init Error';
        renderAdmin();
      }
    }

    async function triggerAdminGoogleSignIn(forceSelectAccount = false) {
      if (!auth) {
        showToast('Firebase configuration not detected.');
        return;
      }
      try {
        const provider = new GoogleAuthProvider();
        if (forceSelectAccount) {
          provider.setCustomParameters({ prompt: 'select_account' });
        }
        await signInWithPopup(auth, provider);
        if (authChannel) {
          try { authChannel.postMessage({ type: 'AUTH_UPDATED' }); } catch (e) {}
        }
      } catch (err) {
        console.warn('Google popup sign-in error:', err?.code || err);
        if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
          showToast('Popup blocked — use the Full-Page Google Redirect Sign-In button below.');
        } else if (err?.code !== 'auth/popup-closed-by-user') {
          showToast(`Google Sign-In failed: ${err?.message || err?.code}`);
        }
      }
    }

    async function triggerAdminGoogleRedirect() {
      if (!auth) return;
      try {
        const provider = new GoogleAuthProvider();
        await signInWithRedirect(auth, provider);
      } catch (err) {
        showToast(`Redirect Sign-In failed: ${err?.message || err?.code}`);
      }
    }

    async function signOutAdminSession() {
      pendingSaveState = null;
      appState = normalizeState(createBlankDataset());
      purgeLocalCachedRecords();
      if (auth) {
        try {
          await signOut(auth);
        } catch (err) {}
      }
      if (authChannel) {
        try { authChannel.postMessage({ type: 'AUTH_UPDATED' }); } catch (e) {}
      }
      renderAdmin();
      showToast('Admin panel locked & signed out');
    }

    /* =====================================================================
     * PERMISSION, AUDIT, CHANGE DIFF, RESET CHANGE LOG & DELETE ALL HELPERS
     * ===================================================================== */
    function getPersonName(p) {
      if (!p) return 'Unknown';
      return `${p.given || ''} ${p.surname || ''}`.trim() || 'Unnamed Individual';
    }

    function findPersonByEmail(email) {
      return findPersonByEmailInState(appState, email);
    }

    function logAudit(summary) {
      appState.accessControl.auditLog = appState.accessControl.auditLog || [];
      const now = new Date();
      const stamp = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
      appState.accessControl.auditLog.unshift({
        id: generateId('log'),
        timestamp: stamp,
        summary
      });
      if (appState.accessControl.auditLog.length > 30) {
        appState.accessControl.auditLog.length = 30;
      }
    }

    function captureDomainSnapshot(stateObj) {
      return deepClone({
        tree: stateObj.tree,
        persons: stateObj.persons,
        families: stateObj.families,
        accessControl: {
          permissions: stateObj.accessControl?.permissions || []
        }
      });
    }

    function recordAdminChangeEvent(summary, category, beforeSnap, afterSnap, stateObj = appState) {
      const actorEmail = getActiveAdminEmail();
      const actorLabel = isSuperAdminEmail(actorEmail, stateObj)
        ? `Super Admin (${actorEmail})`
        : `Admin (${actorEmail || 'Admin'})`;
      appendChangeLogEntry(stateObj, summary, category, beforeSnap, afterSnap, actorLabel);
    }

    function buildChangeLogResetMarker(stateObj = appState) {
      const email = getActiveAdminEmail() || 'unknown';
      const now = new Date();
      const stamp = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
      const iso = now.toISOString();
      const nextSeq = (typeof stateObj.changeSequence === 'number' && stateObj.changeSequence > 0)
        ? stateObj.changeSequence + 1
        : 1;
      return {
        id: generateId('chg'),
        sequence: nextSeq,
        timestamp: stamp,
        actorRole: isSuperAdminEmail(email, stateObj) ? `Super Admin (${email})` : `Admin (${email})`,
        category: 'Access Control',
        summary: `Change log reset by ${email} on ${iso}`,
        reverted: false,
        resetMarker: true
      };
    }

    function downloadChangeLogBackup() {
      return downloadReadableBackup({
        filePrefix: getArchiveId() + '-changelog-backup',
        toast: 'Downloaded a JSON backup of the change log (and the tree).'
      });
    }

    let testWriteImpl = null;

    async function commitArchiveWrite(stateObj, opts = {}) {
      if (typeof testWriteImpl === 'function') {
        syncTreeEmailsWithPermissions(stateObj);
        const stamp = new Date().toISOString();
        const meta = {
          updatedAt: stamp,
          updatedByEmail: getActiveAdminEmail(),
          updatedByUid: (firebaseUser && firebaseUser.uid) || 'test'
        };
        const split = splitStateForWrite(stateObj, { keepEmbedded: false });
        const preparedMain = prepareMainWrite(split.tree, meta);
        const preparedLog = prepareLogWrite(split.log, meta);
        if (!preparedMain.ok) {
          return { ok: false, error: { code: 'resource-exhausted', message: 'The tree document exceeds Firestore\'s 1 MB single-document limit.' } };
        }
        const result = await testWriteImpl(preparedMain.fields, preparedLog.fields, { opts, split, preparedMain, preparedLog });
        if (result && result.ok === false) return result;
        rememberOwnStamp(stamp);
        archiveBaseUpdatedAt = stamp;
        if (preparedMain.fields && preparedMain.fields.revision != null) archiveBaseRevision = preparedMain.fields.revision;
        logBaseUpdatedAt = stamp;
        latestMainData = preparedMain.fields;
        latestLogData = preparedLog.fields;
        pendingLogMigration = false;
        return { ok: true, main: preparedMain.fields, log: preparedLog.fields, estimate: { main: preparedMain.estimate, log: preparedLog.estimate } };
      }
      const forcePrev = forceLogWrite;
      if (opts.forceWriteLog) forceLogWrite = true;
      try {
        const result = await persistState(stateObj);
        return result || { ok: false, error: { code: 'unknown', message: 'The save did not return a result.' } };
      } finally {
        forceLogWrite = forcePrev;
      }
    }

    async function executeResetChangeLog() {
      if (!isSuperAdminEmail(getActiveAdminEmail())) {
        const err = { code: 'permission-denied', message: 'Only the Super Admin can reset the change log.' };
        showToast(err.message);
        return { ok: false, error: err };
      }
      const previousEvents = Array.isArray(appState.changeEvents) ? appState.changeEvents.slice() : [];
      const previousSeq = appState.changeSequence;
      const marker = buildChangeLogResetMarker(appState);
      appState.changeEvents = [marker];
      appState.changeSequence = marker.sequence;
      logAudit(`Super Admin (${getActiveAdminEmail()}) reset the change log`);
      renderAdmin();
      try {
        const result = await commitArchiveWrite(appState, { forceWriteLog: true });
        if (!result || !result.ok) {
          appState.changeEvents = previousEvents;
          appState.changeSequence = previousSeq;
          renderAdmin();
          const formatted = formatFirestoreError((result && result.error) || { message: 'The change log was not reset.' });
          showToast(formatted.text);
          return { ok: false, error: (result && result.error) || formatted, formatted };
        }
        pendingLogMigration = false;
        renderAdmin();
        showToast('Change log reset. A marker entry records who reset it and when.');
        return { ok: true, marker, log: result.log || latestLogData };
      } catch (err) {
        appState.changeEvents = previousEvents;
        appState.changeSequence = previousSeq;
        renderAdmin();
        const formatted = formatFirestoreError(err);
        showToast(formatted.text);
        return { ok: false, error: err, formatted };
      }
    }


    async function executeCompactChangeLog() {
      if (!isSuperAdminEmail(getActiveAdminEmail())) {
        const err = { code: 'permission-denied', message: 'Only the Super Admin can compact the change log.' };
        showToast(err.message);
        return { ok: false, error: err };
      }
      const previousEvents = Array.isArray(appState.changeEvents) ? appState.changeEvents.map(ev => deepClone(ev)) : [];
      const snapshot = captureDomainSnapshot(appState);
      const result = compactChangeLogEvents(appState.changeEvents || [], snapshot, LOG_CHECKPOINT_LIMIT);
      logAudit(`Super Admin (${getActiveAdminEmail()}) compacted the change log (${result.converted} converted, ${result.checkpoints} checkpoints)`);
      renderAdmin();
      try {
        const write = await commitArchiveWrite(appState, { forceWriteLog: true });
        if (!write || !write.ok) {
          appState.changeEvents = previousEvents;
          renderAdmin();
          const formatted = formatFirestoreError((write && write.error) || { message: 'The change log was not compacted.' });
          showToast(formatted.text);
          return { ok: false, error: (write && write.error) || formatted, formatted, result };
        }
        const msg = result.converted
          ? `Change log compacted: ${result.converted} full snapshot ${result.converted === 1 ? 'entry' : 'entries'} converted to diffs, ${result.checkpoints} checkpoint${result.checkpoints === 1 ? '' : 's'} kept.`
          : (result.alreadyCompact
            ? `Change log already uses compact diffs. ${result.checkpoints} checkpoint${result.checkpoints === 1 ? '' : 's'} kept.`
            : 'No snapshot entries needed compacting.');
        if (result.unrecoverable) {
          showToast(msg + ` ${result.unrecoverable} older trimmed ${result.unrecoverable === 1 ? 'entry has' : 'entries have'} no diff and still cannot be reverted.`);
        } else {
          showToast(msg);
        }
        return { ok: true, ...result, log: write.log || latestLogData };
      } catch (err) {
        appState.changeEvents = previousEvents;
        renderAdmin();
        const formatted = formatFirestoreError(err);
        showToast(formatted.text);
        return { ok: false, error: err, formatted };
      }
    }

    function executeDeleteAllAndResetArchive(alsoClearCollaborators = false) {
      if (!isAdminAuthorized()) return;
      const storedSuper = getStoredSuperAdminEmail(appState);

      appState.persons = {};
      appState.families = {};
      appState.centralPersonId = null;
      appState.selectedPersonId = null;
      appState.changeEvents = [];
      appState.changeSequence = 0;
      appState.tree.revision = 1;

      if (alsoClearCollaborators) {
        appState.accessControl.permissions = storedSuper
          ? [{
              id: 'perm_super_admin',
              email: storedSuper,
              personId: null,
              role: 'super_admin',
              note: 'Super Admin & Archive Owner',
              updatedAt: new Date().toISOString().slice(0, 10)
            }]
          : [];
      } else {
        (appState.accessControl.permissions || []).forEach(pm => {
          pm.personId = null;
        });
      }

      syncTreeEmailsWithPermissions(appState);
      const marker = buildChangeLogResetMarker(appState);
      marker.summary = `Archive reset by ${getActiveAdminEmail() || 'unknown'} on ${new Date().toISOString()}`;
      appState.changeEvents = [marker];
      appState.changeSequence = marker.sequence;
      logAudit(`Super Admin (${getActiveAdminEmail()}) deleted all tree data and reset archive`);
      renderAdmin();
      commitArchiveWrite(appState, { forceWriteLog: true }).then((result) => {
        if (!result || !result.ok) {
          const formatted = formatFirestoreError((result && result.error) || { message: 'The archive was not fully reset.' });
          showToast(formatted.text);
          return;
        }
        showToast('All tree records were deleted and the change log was reset in Firestore.');
        renderAdmin();
      }).catch((err) => {
        showToast(formatFirestoreError(err).text);
      });
    }

    function openConfirmActionModal({ title, description, showDeleteAllOptions = false, confirmLabel = 'Confirm', offerLogBackup = false, onConfirm }) {
      const modal = document.getElementById('modal-admin-confirm');
      const titleEl = document.getElementById('confirm-modal-title');
      const descEl = document.getElementById('confirm-modal-desc');
      const extraEl = document.getElementById('confirm-modal-extra');
      const phraseInput = document.getElementById('confirm-delete-phrase-input');
      const clearCollabsCb = document.getElementById('confirm-also-clear-collabs');
      const execBtn = document.getElementById('btn-exec-confirm-modal');
      const backupWrap = document.getElementById('confirm-modal-backup-wrap');
      const backupBtn = document.getElementById('btn-confirm-download-log-backup');

      titleEl.textContent = title;
      descEl.textContent = description;
      execBtn.textContent = confirmLabel;
      phraseInput.value = '';
      clearCollabsCb.checked = false;
      if (backupWrap && backupBtn) {
        backupWrap.classList.toggle('hidden', !offerLogBackup);
        backupBtn.onclick = offerLogBackup ? (ev) => { ev.preventDefault(); downloadChangeLogBackup(); } : null;
      }

      if (showDeleteAllOptions) {
        extraEl.classList.remove('hidden');
        execBtn.disabled = true;
        execBtn.classList.add('opacity-45', 'pointer-events-none');
        phraseInput.oninput = () => {
          const valid = phraseInput.value.trim().toUpperCase() === 'DELETE';
          execBtn.disabled = !valid;
          execBtn.classList.toggle('opacity-45', !valid);
          execBtn.classList.toggle('pointer-events-none', !valid);
        };
      } else {
        extraEl.classList.add('hidden');
        execBtn.disabled = false;
        execBtn.classList.remove('opacity-45', 'pointer-events-none');
        phraseInput.oninput = null;
      }

      execBtn.onclick = () => {
        if (execBtn.disabled) return;
        modal.classList.add('hidden');
        onConfirm({ alsoClearCollaborators: clearCollabsCb.checked });
      };

      modal.classList.remove('hidden');
      if (showDeleteAllOptions) phraseInput.focus();
      phraseInput.onkeydown = (ev) => {
        if (ev.key === 'Enter' && !execBtn.disabled) execBtn.click();
      };
    }

    function grantOrUpdatePermission(email, personId, role, note = '') {
      if (!canManageAccess()) {
        showToast('Only the Super Admin can change who may sign in or whether they can edit.');
        return;
      }
      const cleanEmail = normEmail(email);
      if (!cleanEmail) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        showToast('Please enter a valid email address.');
        return;
      }

      if (isSuperAdminEmail(cleanEmail)) {
        showToast('Super Admin permissions are permanently protected');
        return;
      }

      const beforeSnap = captureDomainSnapshot(appState);
      const list = appState.accessControl.permissions || [];
      const today = new Date().toISOString().slice(0, 10);
      const matchedPerson = personId ? appState.persons[personId] : findPersonByEmail(cleanEmail);
      const resolvedPersonId = matchedPerson ? matchedPerson.id : null;

      if (matchedPerson) {
        matchedPerson.emails = matchedPerson.emails || [];
        if (!matchedPerson.emails.some(em => normEmail(em) === cleanEmail)) {
          matchedPerson.emails.push(cleanEmail);
        }
      }

      const normalizedRole = role === 'admin' ? 'admin' : role === 'edit' ? 'edit' : 'view';
      const existing = list.find(item => normEmail(item.email) === cleanEmail);
      let actionSummary = '';

      if (existing) {
        existing.role = normalizedRole;
        if (resolvedPersonId) existing.personId = resolvedPersonId;
        if (note) existing.note = note;
        existing.updatedAt = today;
        actionSummary = `Updated ${cleanEmail} to ${normalizedRole.toUpperCase()} access`;
      } else {
        list.unshift({
          id: generateId('perm'),
          email: cleanEmail,
          personId: resolvedPersonId,
          role: normalizedRole,
          note: note || (matchedPerson ? `Tree Member (${getPersonName(matchedPerson)})` : 'External Collaborator'),
          updatedAt: today
        });
        actionSummary = `Granted ${normalizedRole.toUpperCase()} access to ${cleanEmail}`;
      }

      logAudit(actionSummary);
      const afterSnap = captureDomainSnapshot(appState);
      recordAdminChangeEvent(actionSummary, 'Access Control', beforeSnap, afterSnap);

      persistState(appState);
      renderAdmin();
      showToast(actionSummary);
    }

    // Diffs are expensive on big trees (every person is compared); cache per change entry.
    const diffCache = new Map();
    function getCachedChangeDiffs(ev) {
      if (!ev) return [];
      const key = `${ev.id}|${ev.sequence}|${hasUsableDiff(ev) ? 'd' : 's'}`;
      if (diffCache.has(key)) return diffCache.get(key);
      let diffs = [];
      if (hasLegacySnapshots(ev)) {
        diffs = computeChangeDiffs(ev.beforeSnapshot, ev.afterSnapshot);
      } else {
        const d = getEntryDiff(ev);
        if (d) diffs = computeChangeDiffs(miniSnapFromDiff(d, 'before'), miniSnapFromDiff(d, 'after'));
      }
      diffCache.set(key, diffs);
      if (diffCache.size > 200) diffCache.delete(diffCache.keys().next().value);
      return diffs;
    }

    function computeChangeDiffs(beforeSnap, afterSnap) {
      if (!beforeSnap || !afterSnap) return [];
      const diffs = [];

      const bPersons = beforeSnap.persons || {};
      const aPersons = afterSnap.persons || {};
      const allPersonIds = new Set([...Object.keys(bPersons), ...Object.keys(aPersons)]);

      allPersonIds.forEach(pid => {
        const bp = bPersons[pid];
        const ap = aPersons[pid];
        if (!bp && ap) {
          diffs.push({
            entityType: 'Person',
            entityName: getPersonName(ap),
            action: 'Added',
            fields: [
              { field: 'Name', before: '—', after: getPersonName(ap) },
              { field: 'Status', before: '—', after: ap.livingStatus || 'unknown' }
            ]
          });
        } else if (bp && !ap) {
          diffs.push({
            entityType: 'Person',
            entityName: getPersonName(bp),
            action: 'Removed',
            fields: [
              { field: 'Name', before: getPersonName(bp), after: '(Removed)' }
            ]
          });
        } else if (bp && ap && JSON.stringify(bp) !== JSON.stringify(ap)) {
          const fieldChanges = [];
          if (getPersonName(bp) !== getPersonName(ap)) {
            fieldChanges.push({ field: 'Name', before: getPersonName(bp), after: getPersonName(ap) });
          }
          if ((bp.livingStatus || '') !== (ap.livingStatus || '')) {
            fieldChanges.push({ field: 'Status', before: bp.livingStatus || '—', after: ap.livingStatus || '—' });
          }
          if (JSON.stringify(bp.emails || []) !== JSON.stringify(ap.emails || [])) {
            fieldChanges.push({ field: 'Emails', before: (bp.emails || []).join(', ') || 'None', after: (ap.emails || []).join(', ') || 'None' });
          }
          if ((bp.bio || '') !== (ap.bio || '')) {
            fieldChanges.push({ field: 'Bio', before: bp.bio || '—', after: ap.bio || '—' });
          }
          if (fieldChanges.length === 0) {
            fieldChanges.push({ field: 'Events / Assertions', before: `${(bp.events || []).length} events, ${(bp.assertions || []).length} claims`, after: `${(ap.events || []).length} events, ${(ap.assertions || []).length} claims` });
          }
          diffs.push({
            entityType: 'Person',
            entityName: getPersonName(ap),
            action: 'Modified',
            fields: fieldChanges
          });
        }
      });

      const bFams = beforeSnap.families || {};
      const aFams = afterSnap.families || {};
      const allFamIds = new Set([...Object.keys(bFams), ...Object.keys(aFams)]);
      allFamIds.forEach(fid => {
        const bf = bFams[fid];
        const af = aFams[fid];
        if (!bf && af) {
          const p1 = af.partner1Id ? getPersonName(aPersons[af.partner1Id]) : 'Partner';
          const p2 = af.partner2Id ? getPersonName(aPersons[af.partner2Id]) : '';
          diffs.push({
            entityType: 'Family Union',
            entityName: p2 ? `${p1} & ${p2}` : p1,
            action: 'Added',
            fields: [{ field: 'Children', before: '0', after: String((af.children || []).length) }]
          });
        } else if (bf && af && JSON.stringify(bf) !== JSON.stringify(af)) {
          const p1 = af.partner1Id ? getPersonName(aPersons[af.partner1Id]) : 'Partner';
          const p2 = af.partner2Id ? getPersonName(aPersons[af.partner2Id]) : '';
          diffs.push({
            entityType: 'Family Union',
            entityName: p2 ? `${p1} & ${p2}` : p1,
            action: 'Modified',
            fields: [{
              field: 'Children / Status',
              before: `${(bf.children || []).length} children (${bf.status || 'married'})`,
              after: `${(af.children || []).length} children (${af.status || 'married'})`
            }]
          });
        }
      });

      const bPerms = beforeSnap.accessControl?.permissions || [];
      const aPerms = afterSnap.accessControl?.permissions || [];
      if (JSON.stringify(bPerms) !== JSON.stringify(aPerms)) {
        const bMap = new Map(bPerms.map(pm => [normEmail(pm.email), pm]));
        const aMap = new Map(aPerms.map(pm => [normEmail(pm.email), pm]));
        const fields = [];
        new Set([...bMap.keys(), ...aMap.keys()]).forEach(em => {
          const bp = bMap.get(em);
          const ap = aMap.get(em);
          const bRole = bp ? bp.role : '—';
          const aRole = ap ? ap.role : '(Revoked)';
          if (!bp || !ap || bp.role !== ap.role) {
            fields.push({ field: em || '(no email)', before: bp ? bRole : '(No access)', after: aRole });
          }
        });
        if (fields.length === 0) {
          fields.push({ field: 'Assigned Roles', before: 'Notes / links', after: 'Notes / links updated' });
        }
        diffs.push({
          entityType: 'Permissions',
          entityName: 'Collaborator Access List',
          action: 'Modified',
          fields
        });
      }

      return diffs;
    }

    // Entities touched by a change whose CURRENT value no longer matches the change's
    // "after" value were edited again later; reverting would overwrite those edits.
    function findRevertConflicts(entry) {
      const d = getEntryDiff(entry);
      if (!d) return [];
      const currentSnap = captureDomainSnapshot(appState);
      const raw = findRevertConflictsFromDiff(d, currentSnap);
      return raw.map(token => {
        if (token.startsWith('person:')) {
          const id = token.slice(7);
          const rec = appState.persons[id] || (d.persons[id] && (d.persons[id].after || d.persons[id].before));
          return getPersonName(rec) || ('person ' + id);
        }
        if (token.startsWith('family:')) return 'a family union';
        return token;
      }).filter((name, idx, arr) => arr.indexOf(name) === idx);
    }

    function requestRevert(changeId, fullRollback = false) {
      if (!isAdminAuthorized()) return;
      const entry = (appState.changeEvents || []).find(c => c.id === changeId);
      if (!entryIsRevertible(entry)) {
        const probe = reconstructStateBeforeEntry(appState.changeEvents || [], entry, captureDomainSnapshot(appState));
        showToast((probe && probe.error) || (entry && entry.snapshotsTrimmed ? "This entry's snapshots were trimmed; it cannot be reverted." : 'This entry cannot be reverted.'));
        return;
      }
      const later = (appState.changeEvents || []).filter(c => c.sequence > entry.sequence && !c.reverted).length;
      let description;
      if (fullRollback) {
        description = `Restore people, families and permissions to exactly how they were before change #${entry.sequence} ("${entry.summary}"). ${later > 0 ? `This also discards ${later} later change${later === 1 ? '' : 's'}.` : ''}`;
      } else {
        const conflicts = findRevertConflicts(entry);
        description = `Undo change #${entry.sequence}: "${entry.summary}".` + (conflicts.length > 0
          ? ` Warning: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''} ${conflicts.length === 1 ? 'was' : 'were'} edited again after this change — reverting will overwrite those later edits.`
          : '');
      }
      openConfirmActionModal({
        title: fullRollback ? `Rollback to before #${entry.sequence}?` : `Revert change #${entry.sequence}?`,
        description,
        confirmLabel: fullRollback ? 'Rollback Full State' : 'Revert Change',
        onConfirm: () => revertSpecificChange(changeId, fullRollback)
      });
    }

    function revertSpecificChange(changeId, fullRollback = false) {
      if (!isAdminAuthorized()) return { ok: false, error: 'Not authorized.' };
      const entry = (appState.changeEvents || []).find(c => c.id === changeId);
      if (!entryIsRevertible(entry)) {
        const msg = (entry && entry.snapshotsTrimmed)
          ? "This entry's snapshots were trimmed; it cannot be reverted."
          : 'This entry cannot be reverted.';
        showToast(msg);
        return { ok: false, error: msg };
      }

      const currentBeforeSnap = captureDomainSnapshot(appState);

      if (fullRollback) {
        const rebuilt = reconstructStateBeforeEntry(appState.changeEvents || [], entry, currentBeforeSnap);
        if (!rebuilt.ok) {
          showToast(rebuilt.error || 'This rollback could not be reconstructed.');
          return { ok: false, error: rebuilt.error };
        }
        appState.tree = deepClone(rebuilt.state.tree || appState.tree);
        appState.persons = deepClone(rebuilt.state.persons || {});
        appState.families = deepClone(rebuilt.state.families || {});
        if (rebuilt.state.accessControl) {
          appState.accessControl.permissions = deepClone(rebuilt.state.accessControl.permissions || []);
        }
        (appState.changeEvents || []).forEach(c => {
          if (c.sequence >= entry.sequence) c.reverted = true;
        });
      } else {
        const d = getEntryDiff(entry);
        if (!d) {
          const msg = 'This entry has no compact diff or snapshots to revert.';
          showToast(msg);
          return { ok: false, error: msg };
        }
        const step = applyDomainDiffToSnap(currentBeforeSnap, d, true);
        if (!step.ok) {
          showToast(step.error || 'This change cannot be reverted safely.');
          return { ok: false, error: step.error };
        }
        appState.tree = deepClone(step.state.tree || appState.tree);
        appState.persons = deepClone(step.state.persons || {});
        appState.families = deepClone(step.state.families || {});
        if (step.state.accessControl) {
          appState.accessControl.permissions = deepClone(step.state.accessControl.permissions || []);
        }

        Object.values(appState.families).forEach(f => {
          if (f.partner1Id && !appState.persons[f.partner1Id]) f.partner1Id = null;
          if (f.partner2Id && !appState.persons[f.partner2Id]) f.partner2Id = null;
          f.children = (f.children || []).filter(c => appState.persons[c.personId]);
        });
      }

      syncTreeEmailsWithPermissions(appState);
      entry.reverted = true;

      const actionDesc = fullRollback
        ? `Rolled back full state to before #${entry.sequence} (${entry.summary})`
        : `Reverted change #${entry.sequence}: ${entry.summary}`;

      logAudit(actionDesc);
      const currentAfterSnap = captureDomainSnapshot(appState);
      recordAdminChangeEvent(actionDesc, 'Revert', currentBeforeSnap, currentAfterSnap);

      persistState(appState);
      document.getElementById('modal-review-change').classList.add('hidden');
      renderAdmin();
      showToast(actionDesc);
      return { ok: true };
    }

    function openReviewChangeModal(changeId) {
      const entry = (appState.changeEvents || []).find(c => c.id === changeId);
      if (!entry) return;

      document.getElementById('review-change-seq').textContent = `#${entry.sequence}`;
      document.getElementById('review-change-title').textContent = entry.summary;
      document.getElementById('review-change-meta').textContent = `${entry.timestamp} · Actor: ${entry.actorRole || '—'} · Category: ${entry.category || '—'}`;

      const body = document.getElementById('review-change-body');
      const footer = document.getElementById('review-change-footer');
      const diffs = getCachedChangeDiffs(entry);

      if (!hasLegacySnapshots(entry) && !hasUsableDiff(entry)) {
        body.innerHTML = entry.snapshotsTrimmed
          ? `<div class="p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">The Before &amp; After snapshots for this older entry were trimmed to keep the archive under Firestore's 1 MB document limit, and it has no compact diff, so it can no longer be reviewed field-by-field or reverted.</div>`
          : `<div class="p-4 rounded-xl bg-parchment-50 border border-parchment-300 text-xs text-slate-600">This entry has no compact diff or snapshots to review (for example a reset marker or a baseline with no recorded changes).</div>`;
      } else if (diffs.length === 0) {
        body.innerHTML = `<div class="p-4 rounded-xl bg-parchment-50 border border-parchment-300 text-xs text-slate-600">No structural field differences detected.</div>`;
      } else {
        body.innerHTML = diffs.map(d => `
          <div class="border border-parchment-300 rounded-xl overflow-hidden">
            <div class="px-3 py-2 bg-parchment-50 border-b border-parchment-200 flex items-center justify-between gap-2">
              <span class="font-serif font-semibold text-sm text-slate-900">${escapeHtml(d.entityType)}: ${escapeHtml(d.entityName)}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-900">${escapeHtml(d.action)}</span>
            </div>
            <table class="w-full text-left text-xs border-collapse">
              <tbody class="divide-y divide-parchment-100">
                ${d.fields.map(f => `
                  <tr>
                    <td class="py-2 px-3 font-semibold text-slate-700 w-1/4">${escapeHtml(f.field)}</td>
                    <td class="py-2 px-3 text-rose-800 bg-rose-50/40 w-3/8 break-words">${escapeHtml(f.before)}</td>
                    <td class="py-2 px-3 text-emerald-900 bg-emerald-50/40 w-3/8 break-words">${escapeHtml(f.after)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `).join('');
      }

      const canRevert = entryIsRevertible(entry);
      footer.innerHTML = `
        <div class="flex flex-wrap items-center gap-2">
          ${canRevert ? `
            <button type="button" data-exec-revert-single="${escapeHtml(entry.id)}" class="px-3.5 py-1.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold shadow-2xs transition">↶ Revert Only This Change</button>
            <button type="button" data-exec-rollback-full="${escapeHtml(entry.id)}" class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 text-xs font-semibold transition">Rollback Full State Before #${entry.sequence}</button>
          ` : `<span class="text-xs text-slate-500 italic">${entry.reverted ? 'Already Reverted' : entry.snapshotsTrimmed ? 'Snapshots trimmed — not revertible' : 'Baseline entry'}</span>`}
        </div>
        <button type="button" id="btn-footer-close-review" class="px-3 py-1.5 rounded-xl text-xs font-medium text-slate-700 hover:bg-parchment-200 transition">Close</button>
      `;

      document.getElementById('modal-review-change').classList.remove('hidden');
    }

    /* =====================================================================
     * GEDCOM 5.5.1 / 7.0 SERIALIZER & ROBUST BIDIRECTIONAL PARSER
     * ===================================================================== */
    // GEDCOM values must be single-line; a leading '@' is escaped as '@@'.
    function gedValue(raw) {
      const v = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
      return v.startsWith('@') ? `@${v}` : v;
    }

    // Writes a possibly multi-line text value using CONT (new line) and, for 5.5.1,
    // CONC (continuation) so no physical line exceeds 255 characters.
    function pushGedText(lines, level, tag, text, version) {
      const maxChunk = version === '5.5.1' ? 200 : Infinity;
      const paragraphs = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
      paragraphs.forEach((para, idx) => {
        let rest = para.startsWith('@') ? `@${para}` : para;
        let first = rest.slice(0, maxChunk);
        rest = rest.slice(first.length);
        if (maxChunk !== Infinity) {
          // avoid splitting before a space (some readers trim CONC values)
          while (rest && first.length > 1 && (first.endsWith(' ') || rest.startsWith(' '))) {
            rest = first.slice(-1) + rest;
            first = first.slice(0, -1);
          }
        }
        if (idx === 0) {
          lines.push(`${level} ${tag}${first ? ' ' + first : ''}`);
        } else {
          lines.push(`${level + 1} CONT${first ? ' ' + first : ''}`);
        }
        while (rest) {
          let chunk = rest.slice(0, maxChunk);
          rest = rest.slice(chunk.length);
          while (rest && chunk.length > 1 && (chunk.endsWith(' ') || rest.startsWith(' '))) {
            rest = chunk.slice(-1) + rest;
            chunk = chunk.slice(0, -1);
          }
          lines.push(`${level + 1} CONC ${chunk}`);
        }
      });
    }

    function normalizeUnionStatus(status) {
      const st = String(status || '').trim().toLowerCase();
      if (st === 'divorced' || st === 'separated' || st === 'widowed') return st;
      return 'married';
    }

    function serializeArchiveToGedcom(version = '7.0', redactLiving = false) {
      const is7 = version !== '5.5.1';
      const lines = ['0 HEAD', '1 GEDC', `2 VERS ${is7 ? '7.0' : '5.5.1'}`];
      if (!is7) lines.push('2 FORM LINEAGE-LINKED');
      lines.push('1 SOUR FamilyTree', '2 NAME ' + getSiteTitle() + ' Admin Export', '2 VERS 1.0');
      if (!is7) lines.push('1 CHAR UTF-8');

      const personXref = {};
      Object.keys(appState.persons).forEach((id, idx) => { personXref[id] = `@I${idx + 1}@`; });
      const famXref = {};
      Object.keys(appState.families).forEach((id, idx) => { famXref[id] = `@F${idx + 1}@`; });

      // Index family links once (avoids scanning every family for every person)
      const famsByPerson = {};
      const famcByPerson = {};
      Object.values(appState.families).forEach(f => {
        [f.partner1Id, f.partner2Id].forEach(pid => {
          if (!pid) return;
          (famsByPerson[pid] = famsByPerson[pid] || []);
          if (!famsByPerson[pid].includes(f)) famsByPerson[pid].push(f);
        });
        (f.children || []).forEach(c => {
          if (!c || !c.personId) return;
          (famcByPerson[c.personId] = famcByPerson[c.personId] || []);
          if (!famcByPerson[c.personId].some(x => x.f === f)) famcByPerson[c.personId].push({ f, c });
        });
      });

      const pediValue = (linkage) => {
        if (linkage === 'adoptive') return is7 ? 'ADOPTED' : 'adopted';
        if (linkage === 'step') return is7 ? 'OTHER' : null;
        return null;
      };

      Object.values(appState.persons).forEach(p => {
        const xref = personXref[p.id];
        const shouldRedact = redactLiving && p.livingStatus === 'living';
        lines.push(`0 ${xref} INDI`);
        if (shouldRedact) {
          lines.push('1 NAME Living /Private/');
        } else {
          lines.push(`1 NAME ${gedValue(p.given || '')} /${String(p.surname || '').replace(/[\/\r\n]/g, ' ').trim()}/`);
          if (p.nickname) lines.push(`2 NICK ${gedValue(p.nickname)}`);
          if (p.altName) {
            lines.push(`1 NAME ${gedValue(p.altName)}`);
            lines.push(is7 ? '2 TYPE AKA' : '2 TYPE aka');
          }
        }
        if (p.sex && p.sex !== 'U') lines.push(`1 SEX ${p.sex}`);
        if (!shouldRedact) {
          (p.emails || []).forEach(em => { if (em) lines.push(`1 EMAIL ${gedValue(em)}`); });
          (p.events || []).forEach(ev => {
            const evTag = /^[A-Z_][A-Z0-9_]{0,30}$/.test(String(ev.type || '').toUpperCase()) ? String(ev.type).toUpperCase() : 'EVEN';
            lines.push(`1 ${evTag}`);
            if (ev.date) lines.push(`2 DATE ${gedValue(ev.date)}`);
            if (ev.place) lines.push(`2 PLAC ${gedValue(ev.place)}`);
          });
          // Keep "deceased" when there is no dated death event (standard "1 DEAT Y")
          if (p.livingStatus === 'deceased' && !(p.events || []).some(ev => String(ev.type || '').toUpperCase() === 'DEAT')) {
            lines.push('1 DEAT Y');
          }
          if (p.bio) pushGedText(lines, 1, 'NOTE', p.bio, version);
          (p.customTags || []).forEach(ct => {
            const tag = String(ct?.tag || '').toUpperCase();
            if (/^_[A-Z0-9_]+$/.test(tag)) lines.push(`1 ${tag}${ct.value ? ' ' + gedValue(ct.value) : ''}`);
          });
        }
        (famsByPerson[p.id] || []).forEach(f => lines.push(`1 FAMS ${famXref[f.id]}`));
        (famcByPerson[p.id] || []).forEach(({ f, c }) => {
          lines.push(`1 FAMC ${famXref[f.id]}`);
          const pedi = pediValue(c.linkage);
          if (pedi) {
            lines.push(`2 PEDI ${pedi}`);
            if (is7 && c.linkage === 'step') lines.push('3 PHRASE Step');
          }
        });
      });

      Object.values(appState.families).forEach(f => {
        lines.push(`0 ${famXref[f.id]} FAM`);
        if (f.partner1Id && personXref[f.partner1Id]) lines.push(`1 HUSB ${personXref[f.partner1Id]}`);
        if (f.partner2Id && personXref[f.partner2Id]) lines.push(`1 WIFE ${personXref[f.partner2Id]}`);
        if (f.marriageDate || f.marriagePlace) {
          lines.push('1 MARR');
          if (f.marriageDate) lines.push(`2 DATE ${gedValue(f.marriageDate)}`);
          if (f.marriagePlace) lines.push(`2 PLAC ${gedValue(f.marriagePlace)}`);
        }
        const ustatus = normalizeUnionStatus(f.status);
        if (ustatus === 'divorced') {
          lines.push('1 DIV Y');
          if (f.divorceDate) lines.push(`2 DATE ${gedValue(f.divorceDate)}`);
          if (f.divorcePlace) lines.push(`2 PLAC ${gedValue(f.divorcePlace)}`);
        } else if (ustatus === 'separated') {
          lines.push('1 _SEPR Y');
          if (f.divorceDate) lines.push(`2 DATE ${gedValue(f.divorceDate)}`);
          if (f.divorcePlace) lines.push(`2 PLAC ${gedValue(f.divorcePlace)}`);
        } else if (ustatus === 'widowed') {
          lines.push('1 _WIDO Y');
        }
        const seen = new Set();
        (f.children || []).forEach(ch => {
          if (!ch || !personXref[ch.personId] || seen.has(ch.personId)) return;
          seen.add(ch.personId);
          lines.push(`1 CHIL ${personXref[ch.personId]}`);
          if (ch.linkage === 'step') {
            lines.push('2 _FREL Step');
            lines.push('2 _MREL Step');
          }
        });
      });

      lines.push('0 TRLR');
      return lines.join('\n');
    }

    function normalizeXrefKey(rawXref) {
      if (!rawXref) return null;
      return String(rawXref).trim().toUpperCase();
    }

    function parseGedcomArchiveText(rawText) {
      const cleanedText = (rawText || '').replace(/^\uFEFF/, '');
      // Keep trailing spaces (they matter for CONC continuation); strip leading indentation only.
      const lines = cleanedText.split(/\r\n|\n|\r/).map(l => l.replace(/^\s+/, '')).filter(l => l.trim());
      const noteRecords = {};
      let currentNoteRec = null;

      let version = '5.5.1';
      const indiRecords = {};
      const famRecords = {};
      let currentRec = null;
      let currentSub = null;
      let customTagCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\d+)\s+(?:(@[^@]+@)\s+)?([A-Z0-9_]+)(?:\s+(.*))?$/i);
        if (!match) continue;
        const level = parseInt(match[1], 10);
        const xref = normalizeXrefKey(match[2]);
        const tag = match[3].toUpperCase();
        const rawVal = (match[4] || '').replace(/^@@/, '@');
        const val = (tag === 'CONC' || tag === 'CONT') ? rawVal : rawVal.trim();

        if (level === 0) {
          currentSub = null;
          currentNoteRec = null;
          if ((tag === 'NOTE' || tag === 'SNOTE') && xref) {
            currentNoteRec = { text: val };
            noteRecords[xref] = currentNoteRec;
            currentRec = { type: 'NOTE_RECORD' };
            continue;
          }
          if (tag === 'INDI' && xref) {
            currentRec = {
              type: 'INDI',
              xref,
              id: generateId('p'),
              given: '',
              surname: '',
              altName: '',
              nickname: '',
              emails: [],
              photoUrl: '',
              media: [],
              sex: 'U',
              livingStatus: typeof DEFAULT_LIVING_STATUS === 'string' ? DEFAULT_LIVING_STATUS : 'living',
              bio: '',
              events: [],
              assertions: [],
              customTags: [],
              _famcXrefs: [],
              _famsXrefs: [],
              _famcPedigree: {},
              _noteRefs: []
            };
            indiRecords[xref] = currentRec;
          } else if (tag === 'FAM' && xref) {
            currentRec = {
              type: 'FAM',
              xref,
              id: generateId('f'),
              husbXref: null,
              wifeXref: null,
              chilXrefs: [],
              chilPedigreeMap: {},
              marriageDate: '',
              marriagePlace: '',
              divorceDate: '',
              divorcePlace: '',
              status: 'married'
            };
            famRecords[xref] = currentRec;
          } else {
            currentRec = { type: tag };
          }
          continue;
        }
        if (!currentRec) continue;

        if (currentRec.type === 'NOTE_RECORD') {
          if (currentNoteRec && level === 1 && (tag === 'CONT' || tag === 'CONC')) {
            currentNoteRec.text += (tag === 'CONT' ? '\n' : '') + val;
          }
        } else if (currentRec.type === 'HEAD') {
          // Reset on every level-1 tag so e.g. "1 SOUR / 2 VERS" after GEDC can't overwrite the version
          if (level === 1) currentSub = tag === 'GEDC' ? 'GEDC' : tag;
          if (level === 2 && currentSub === 'GEDC' && tag === 'VERS') version = val;
        } else if (currentRec.type === 'INDI') {
          if (level === 1) {
            currentSub = tag;
            if (tag === 'NAME') {
              const nameParts = val.match(/^(.*?)\s*\/([^/]*)\/(.*)$/);
              let parsedGiven = '';
              let parsedSurname = '';
              if (nameParts) {
                parsedGiven = `${nameParts[1]} ${nameParts[3]}`.trim();
                parsedSurname = nameParts[2].trim();
              } else {
                parsedGiven = val;
              }
              if (!currentRec.given && !currentRec.surname) {
                currentRec.given = parsedGiven;
                currentRec.surname = parsedSurname;
              } else {
                const fullAlt = `${parsedGiven} ${parsedSurname}`.trim();
                if (fullAlt && !currentRec.altName) currentRec.altName = fullAlt;
              }
              currentSub = { kind: 'NAME', isPrimary: currentRec.altName === '' };
            } else if (tag === 'NICK' && val) {
              if (!currentRec.nickname) currentRec.nickname = val;
            } else if (tag === 'SEX') {
              currentRec.sex = ['M', 'F', 'X'].includes(val.toUpperCase()) ? val.toUpperCase() : 'U';
            } else if (tag === 'EMAIL' && val) {
              const cleanEm = val.toLowerCase();
              if (!currentRec.emails.includes(cleanEm)) currentRec.emails.push(cleanEm);
            } else if (['BIRT', 'DEAT', 'ADOP', 'BURI', 'RESI', 'OCCU', 'EDUC', 'CHR', 'BAPM', 'CREM', 'EMIG', 'IMMI', 'NATU', 'CENS', 'GRAD', 'RETI', 'EVEN'].includes(tag)) {
              const ev = { id: generateId('ev'), type: tag, date: '', place: '' };
              currentRec.events.push(ev);
              currentSub = ev;
              if (tag === 'DEAT') currentRec.livingStatus = 'deceased';
            } else if ((tag === 'NOTE' || tag === 'SNOTE') && /^@[^@]+@$/.test(val)) {
              // Pointer to a shared NOTE record; resolved after parsing
              currentRec._noteRefs.push(normalizeXrefKey(val));
              currentSub = null;
            } else if (tag === 'NOTE') {
              currentRec.bio = currentRec.bio ? `${currentRec.bio}\n${val}` : val;
              currentSub = 'NOTE';
            } else if (tag === 'FAMC') {
              const fx = normalizeXrefKey(val);
              if (fx && !currentRec._famcXrefs.includes(fx)) currentRec._famcXrefs.push(fx);
              currentSub = { famcXref: fx };
            } else if (tag === 'FAMS') {
              const fx = normalizeXrefKey(val);
              if (fx && !currentRec._famsXrefs.includes(fx)) currentRec._famsXrefs.push(fx);
              currentSub = { famsXref: fx };
            } else if (tag.startsWith('_')) {
              currentRec.customTags.push({ id: generateId('tag'), tag, value: val });
              customTagCount++;
            }
          } else if (level === 2 && currentSub) {
            if (typeof currentSub === 'object' && currentSub.kind === 'NAME') {
              if (currentSub.isPrimary) {
                if (tag === 'GIVN' && val) currentRec.given = val;
                if (tag === 'SURN' && val) currentRec.surname = val;
              }
              if (tag === 'NICK' && val && !currentRec.nickname) currentRec.nickname = val;
            } else if (typeof currentSub === 'object' && currentSub.type) {
              if (tag === 'DATE') currentSub.date = val;
              if (tag === 'PLAC') currentSub.place = val;
            } else if (typeof currentSub === 'object' && currentSub.famcXref && (tag === 'PEDI' || tag === '_FREL' || tag === '_MREL')) {
              const normPed = val.toLowerCase();
              const mapped =
                (normPed.includes('adopt') || normPed.includes('foster')) ? 'adoptive'
                : normPed.includes('step') ? 'step'
                : (normPed === 'birth' || normPed === 'natural' || normPed === 'biological') ? 'biological'
                : null; // OTHER / SEALED / unknown: decided by PHRASE or the FAM record
              if (mapped) currentRec._famcPedigree[currentSub.famcXref] = mapped;
              currentSub.pediLevel = true;
            } else if (currentSub === 'NOTE' && (tag === 'CONT' || tag === 'CONC')) {
              currentRec.bio += (tag === 'CONT' ? '\n' : '') + val;
            }
          }
          if (level === 3 && typeof currentSub === 'object' && currentSub && currentSub.famcXref && currentSub.pediLevel && tag === 'PHRASE') {
            const ph = val.toLowerCase();
            if (ph.includes('step')) currentRec._famcPedigree[currentSub.famcXref] = 'step';
            else if (ph.includes('adopt') || ph.includes('foster')) currentRec._famcPedigree[currentSub.famcXref] = 'adoptive';
          }
        } else if (currentRec.type === 'FAM') {
          if (level === 1) {
            currentSub = tag;
            if (tag === 'HUSB') {
              currentRec.husbXref = normalizeXrefKey(val);
            } else if (tag === 'WIFE') {
              currentRec.wifeXref = normalizeXrefKey(val);
            } else if (tag === 'CHIL') {
              const cx = normalizeXrefKey(val);
              if (cx && !currentRec.chilXrefs.includes(cx)) {
                currentRec.chilXrefs.push(cx);
              }
              currentSub = { chilXref: cx };
            } else if (tag === 'DIV') {
              currentRec.status = 'divorced';
              const rest = String(val || '').trim();
              if (rest && rest.toUpperCase() !== 'Y') currentRec.divorceDate = rest;
            } else if (tag === '_SEPR') {
              currentRec.status = 'separated';
            } else if (tag === '_WIDO') {
              currentRec.status = 'widowed';
            }
          } else if (level === 2 && currentSub) {
            if (currentSub === 'MARR') {
              if (tag === 'DATE') currentRec.marriageDate = val;
              if (tag === 'PLAC') currentRec.marriagePlace = val;
            } else if (currentSub === 'DIV' || currentSub === '_SEPR' || currentSub === '_WIDO') {
              if (tag === 'DATE') currentRec.divorceDate = val;
              if (tag === 'PLAC') currentRec.divorcePlace = val;
            } else if (typeof currentSub === 'object' && currentSub.chilXref) {
              if (tag === 'PEDI' || tag === '_FREL' || tag === '_MREL') {
                const normPed = val.toLowerCase();
                if (normPed.includes('adopt') || normPed.includes('foster')) {
                  currentRec.chilPedigreeMap[currentSub.chilXref] = 'adoptive';
                } else if (normPed.includes('step')) {
                  currentRec.chilPedigreeMap[currentSub.chilXref] = 'step';
                }
              }
            }
          }
        }
      }

      Object.values(indiRecords).forEach(ind => {
        (ind._famsXrefs || []).forEach(fx => {
          let fam = famRecords[fx];
          if (!fam) {
            fam = {
              type: 'FAM',
              xref: fx,
              id: generateId('f'),
              husbXref: null,
              wifeXref: null,
              chilXrefs: [],
              chilPedigreeMap: {},
              marriageDate: '',
              marriagePlace: '',
              divorceDate: '',
              divorcePlace: '',
              status: 'married'
            };
            famRecords[fx] = fam;
          }
          if (fam.husbXref !== ind.xref && fam.wifeXref !== ind.xref) {
            if (ind.sex === 'F' && !fam.wifeXref) {
              fam.wifeXref = ind.xref;
            } else if (!fam.husbXref) {
              fam.husbXref = ind.xref;
            } else if (!fam.wifeXref) {
              fam.wifeXref = ind.xref;
            }
          }
        });

        (ind._famcXrefs || []).forEach(fx => {
          let fam = famRecords[fx];
          if (!fam) {
            fam = {
              type: 'FAM',
              xref: fx,
              id: generateId('f'),
              husbXref: null,
              wifeXref: null,
              chilXrefs: [],
              chilPedigreeMap: {},
              marriageDate: '',
              marriagePlace: '',
              divorceDate: '',
              divorcePlace: '',
              status: 'married'
            };
            famRecords[fx] = fam;
          }
          if (!fam.chilXrefs.includes(ind.xref)) {
            fam.chilXrefs.push(ind.xref);
          }
        });
      });

      const persons = {};
      const families = {};

      Object.values(indiRecords).forEach(ind => {
        (ind._noteRefs || []).forEach(ref => {
          const txt = noteRecords[ref]?.text;
          if (txt) ind.bio = ind.bio ? `${ind.bio}\n${txt}` : txt;
        });
        delete ind._noteRefs;
        // "1 DEAT Y" with no date/place only marks the person deceased; don't keep an empty fact
        ind.events = (ind.events || []).filter(ev => !(ev.type === 'DEAT' && !ev.date && !ev.place));
        const pedMap = ind._famcPedigree;
        delete ind._famcPedigree;
        delete ind._famcXrefs;
        delete ind._famsXrefs;
        delete ind.type;
        delete ind.xref;
        ind._pedMap = pedMap;
        persons[ind.id] = ind;
      });

      let totalChildLinks = 0;
      const previewFamilies = [];
      const importedEmailCount = Object.values(persons).reduce((n, pr) => n + (pr.emails || []).length, 0);

      Object.values(famRecords).forEach(fam => {
        const p1Rec = fam.husbXref && indiRecords[fam.husbXref] ? indiRecords[fam.husbXref] : null;
        const p2Rec = fam.wifeXref && indiRecords[fam.wifeXref] ? indiRecords[fam.wifeXref] : null;
        const p1 = p1Rec ? p1Rec.id : null;
        const p2 = p2Rec ? p2Rec.id : null;

        const children = [];
        const seenChildIds = new Set();

        fam.chilXrefs.forEach(cx => {
          const childInd = indiRecords[cx];
          if (childInd && !seenChildIds.has(childInd.id)) {
            seenChildIds.add(childInd.id);
            const linkage =
              (childInd._pedMap && childInd._pedMap[fam.xref]) ||
              (fam.chilPedigreeMap && fam.chilPedigreeMap[cx]) ||
              'biological';
            children.push({ personId: childInd.id, linkage });
            totalChildLinks++;
          }
        });

        families[fam.id] = {
          id: fam.id,
          partner1Id: p1,
          partner2Id: p2,
          marriageDate: fam.marriageDate,
          marriagePlace: fam.marriagePlace,
          divorceDate: fam.divorceDate || '',
          divorcePlace: fam.divorcePlace || '',
          status: normalizeUnionStatus(fam.status),
          children
        };

        if (previewFamilies.length < 4 && (p1Rec || p2Rec || children.length > 0)) {
          const parentsLabel = [p1Rec ? getPersonName(p1Rec) : null, p2Rec ? getPersonName(p2Rec) : null].filter(Boolean).join(' & ') || 'Single Parent';
          const kidsLabel = children.map(c => getPersonName(persons[c.personId])).join(', ') || 'No children';
          previewFamilies.push(`${parentsLabel} → ${kidsLabel}`);
        }
      });

      Object.values(persons).forEach(p => { delete p._pedMap; });

      return {
        version,
        persons,
        families,
        customTagCount,
        totalChildLinks,
        importedEmailCount,
        previewFamilies,
        personCount: Object.keys(persons).length,
        familyCount: Object.keys(families).length
      };
    }

    /* =====================================================================
     * RENDER ADMIN INTERFACE (STRICT ZERO-RECORD RENDER WHEN NOT LOGGED IN)
     * ===================================================================== */
    function formatLastSaved(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    function paintLastSaved(iso) {
      const text = formatLastSaved(iso);
      const header = document.getElementById('admin-last-saved');
      const overview = document.getElementById('admin-overview-last-saved-value');
      if (header) header.textContent = text;
      if (overview) overview.textContent = text;
    }

    function levenshtein(a, b) {
      a = String(a || '');
      b = String(b || '');
      const rows = Array.from({ length: a.length + 1 }, (_, i) => {
        const row = new Array(b.length + 1);
        row[0] = i;
        return row;
      });
      for (let j = 0; j <= b.length; j++) rows[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
        }
      }
      return rows[a.length][b.length];
    }

    function emailsLookLikeTypo(a, b) {
      const left = String(a || '').trim().toLowerCase();
      const right = String(b || '').trim().toLowerCase();
      if (!left || !right || left === right) return false;
      const [lLocal, lDomain] = left.split('@');
      const [rLocal, rDomain] = right.split('@');
      if (lDomain && rDomain && lDomain === rDomain) {
        const d = levenshtein(lLocal || '', rLocal || '');
        if (d > 0 && d <= 2 && Math.min((lLocal || '').length, (rLocal || '').length) >= 5) return true;
      }
      const d = levenshtein(left, right);
      return d > 0 && d <= 2 && Math.min(left.length, right.length) >= 8;
    }

    function collectKnownEmails(stateObj = appState) {
      const known = new Set();
      const superEmail = getStoredSuperAdminEmail(stateObj);
      if (superEmail) known.add(superEmail);
      (stateObj.accessControl?.permissions || []).forEach(pm => {
        const em = (pm.email || '').trim().toLowerCase();
        if (em) known.add(em);
      });
      Object.values(stateObj.persons || {}).forEach(person => {
        (person.emails || []).forEach(raw => {
          const em = (raw || '').trim().toLowerCase();
          if (em) known.add(em);
        });
      });
      return [...known];
    }

    function findEmailWarnings(email, stateObj = appState) {
      const clean = (email || '').trim().toLowerCase();
      if (!clean || !clean.includes('@')) return [];
      const warnings = [];
      collectKnownEmails(stateObj).forEach(other => {
        if (other === clean) warnings.push({ type: 'duplicate', other });
        else if (emailsLookLikeTypo(clean, other)) warnings.push({ type: 'typo', other });
      });
      return warnings;
    }

    function describeEmailWarnings(email, stateObj = appState) {
      const warnings = findEmailWarnings(email, stateObj);
      if (!warnings.length) return '';
      return warnings.map(w => w.type === 'duplicate'
        ? `${w.other} is already in this archive.`
        : `${email.trim().toLowerCase()} looks very similar to ${w.other} — check for a typo.`
      ).join(' ');
    }

    function paintEmailWarning(email, el) {
      if (!el) return;
      const text = describeEmailWarnings(email);
      el.textContent = text;
      el.classList.toggle('hidden', !text);
    }

    function tabFromHash() {
      const raw = (location.hash || '').replace(/^#/, '').trim().toLowerCase();
      if (raw === 'people-access' || raw === 'access') return 'people';
      if (raw === 'log' || raw === 'change-log') return 'changelog';
      return ADMIN_TABS.includes(raw) ? raw : 'overview';
    }

    function setAdminTab(tab, { updateHash = true } = {}) {
      const next = ADMIN_TABS.includes(tab) ? tab : 'overview';
      activeAdminTab = next;
      if (next === 'sharing') setTimeout(() => { refreshSharingTab(); }, 0);
      document.querySelectorAll('[data-admin-tab]').forEach(panel => {
        panel.classList.toggle('hidden-tab', panel.getAttribute('data-admin-tab') !== next);
      });
      document.querySelectorAll('[data-admin-tab-btn]').forEach(btn => {
        const on = btn.getAttribute('data-admin-tab-btn') === next;
        if (on) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });
      if (updateHash) {
        const want = '#' + next;
        if (location.hash !== want) {
          history.replaceState(null, '', want);
        }
      }
    }

    function downloadReadableBackup(opts = {}) {
      const split = splitStateForWrite(appState, { keepEmbedded: false });
      const bundle = {
        exportedAt: new Date().toISOString(),
        note: 'Readable backup of ' + getSiteTitle() + '. The family tree is the JSON stored in the payloadJson string field of ' + getArchiveDocPath() + '. The change log is stored in changeLogJson on ' + getArchiveLogDocPath() + ' (or still embedded in payloadJson before the one-time move).',
        archive: getArchiveDocPath(),
        logArchive: getArchiveLogDocPath(),
        payloadJson_pretty: split.tree,
        changeLog: split.log
      };
      const pretty = JSON.stringify(bundle, null, 2);
      const blob = new Blob([pretty], { type: 'application/json' });
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(blob);
      a.download = `${opts.filePrefix || (getArchiveId() + '-backup')}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showToast(opts.toast || 'Downloaded a readable JSON backup of the tree and change log.');
      return { fileName: a.download, text: pretty, changeLog: split.log };
    }


    function renderAppErrorLog() {
      const listEl = document.getElementById('admin-error-log-list');
      const emptyEl = document.getElementById('admin-error-log-empty');
      if (!listEl || !emptyEl) return;
      const list = loadAppErrorLog();
      emptyEl.classList.toggle('hidden', list.length > 0);
      listEl.classList.toggle('hidden', list.length === 0);
      listEl.innerHTML = list.map(ev => {
        const when = ev.at ? ev.at.replace('T', ' ').replace(/\.\d+Z$/, ' Z') : '';
        const pid = ev.personId ? ` · person ${escapeHtml(String(ev.personId))}` : '';
        const count = ev.count && ev.count > 1 ? ` ×${ev.count}` : '';
        return `<li class="p-2.5 rounded-xl border border-parchment-200 bg-parchment-50">
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold uppercase tracking-wider text-[10px] text-slate-600">${escapeHtml(ev.context || 'error')}${count}</span>
            <span class="text-[10px] text-slate-500">${escapeHtml(when)}</span>
          </div>
          <div class="mt-1 text-slate-800 break-words">${escapeHtml(ev.code ? ev.code + ': ' : '')}${escapeHtml(ev.message || '')}${pid}</div>
        </li>`;
      }).join('');
    }

    function renderAdmin() {
      try { applyConfigToDom(); } catch (e) {}
      try {
        renderShareLinkCard();
        renderSuggestions();
        if (isAdminAuthorized() && activeAdminTab === 'sharing' && sharingLoadedFor !== getActiveAdminEmail()) {
          sharingLoadedFor = getActiveAdminEmail();
          setTimeout(() => { refreshSharingTab(); }, 0);
        }
      } catch (e) { console.warn('Sharing tab paint skipped:', e); }

      const authorized = isAdminAuthorized();
      const manageAccess = canManageAccess();
      if (typeof refreshLivingStatusCard === 'function') refreshLivingStatusCard();
      const accessNotice = document.getElementById('admin-access-only-sa-notice');
      if (accessNotice) accessNotice.classList.toggle('hidden', !authorized || manageAccess);
      const grantFieldset = document.getElementById('grant-access-fieldset');
      if (grantFieldset) grantFieldset.disabled = !manageAccess;
      const grantForm = document.getElementById('form-grant-access');
      if (grantForm) grantForm.querySelectorAll('input, select, button, textarea').forEach(el => { el.disabled = !manageAccess; });

      const activeEmail = getActiveAdminEmail();
      document.getElementById('admin-signed-in-email').textContent = activeEmail || 'Not Signed In';
      document.getElementById('admin-tree-name').textContent = authorized
        ? (appState.tree.title || getSiteTitle())
        : getSiteTitle();

      const lockScreen = document.getElementById('admin-lock-screen');
      const mainWorkspace = document.getElementById('admin-main-workspace');
      const rolePill = document.getElementById('admin-role-pill');
      const signoutBtn = document.getElementById('btn-admin-signout');
      const googleBtnLabel = document.getElementById('btn-admin-google-label');

      if (googleBtnLabel) {
        googleBtnLabel.textContent = activeEmail ? 'Switch Account' : 'Sign in with Google';
      }

      const compactBtnEarly = document.getElementById('btn-compact-changelog');
      const resetBtnEarly = document.getElementById('btn-reset-changelog');
      const dangerResetEarly = document.getElementById('btn-danger-reset-changelog');
      if (compactBtnEarly) compactBtnEarly.classList.add('hidden');
      if (resetBtnEarly) resetBtnEarly.classList.add('hidden');
      if (dangerResetEarly) dangerResetEarly.classList.add('hidden');

      if (!authorized) {
        lockScreen.classList.remove('hidden');
        mainWorkspace.classList.add('hidden');
        rolePill.classList.add('hidden');
        signoutBtn.classList.toggle('hidden', !activeEmail);

        // Clear all DOM tables/lists so zero records exist in DOM when signed out
        document.getElementById('changelog-table-body').innerHTML = '';
        document.getElementById('collaborators-list-container').innerHTML = '';
        document.getElementById('tree-members-email-list').innerHTML = '';
        document.getElementById('admin-audit-list').innerHTML = '';

        document.getElementById('admin-lock-reason').innerHTML = activeEmail
          ? `Signed in as <strong>${escapeHtml(activeEmail)}</strong>, which does not have Super Admin privileges in Cloud Firestore. Please sign in with an authorized Super Admin Google Account.`
          : `No genealogy records or user lists are loaded until an authorized Administrator signs in with Google.`;
        return;
      }

      lockScreen.classList.add('hidden');
      mainWorkspace.classList.remove('hidden');
      rolePill.classList.remove('hidden');
      signoutBtn.classList.remove('hidden');

      const storedSuper = getStoredSuperAdminEmail(appState);
      const myPerm = (appState.accessControl?.permissions || []).find(pm => (pm.email || '').toLowerCase() === activeEmail);
      const roleLabel = isSuperAdminEmail(activeEmail)
        ? 'Super Admin'
        : (myPerm && myPerm.role === 'admin')
          ? 'Admin'
          : (myPerm && myPerm.role === 'edit')
            ? 'Editor'
            : (myPerm && myPerm.role === 'view')
              ? 'Viewer'
              : 'Administrator';
      rolePill.textContent = roleLabel;
      rolePill.className = 'role-hint max-w-full truncate';
      rolePill.setAttribute('title', storedSuper && isSuperAdminEmail(activeEmail) ? `${roleLabel}: ${storedSuper}` : roleLabel);
      const superDisplayEl = document.getElementById('admin-super-admin-email-display');
      if (superDisplayEl) superDisplayEl.textContent = storedSuper || activeEmail;
      paintLastSaved(archiveBaseUpdatedAt || (latestMainData && latestMainData.updatedAt) || null);

      const permissions = appState.accessControl.permissions || [];
      const personsArr = Object.values(appState.persons);

      const emptyBanner = document.getElementById('admin-empty-archive-banner');
      if (emptyBanner) {
        emptyBanner.classList.toggle('hidden', personsArr.length > 0);
      }

      const editCount = permissions.filter(p => p.role === 'super_admin' || p.role === 'admin' || p.role === 'edit').length;
      const viewCount = permissions.filter(p => p.role === 'view').length;
      const changeCount = (appState.changeEvents || []).length;

      document.getElementById('kpi-total-assigned').textContent = permissions.length;
      document.getElementById('kpi-edit-count').textContent = editCount;
      document.getElementById('kpi-view-count').textContent = viewCount;
      document.getElementById('kpi-change-count').textContent = changeCount;
      renderStorageMeter(estimateAllStorage(appState));
      const migNotice = document.getElementById('admin-log-migration-notice');
      if (migNotice) {
        const showMig = Boolean(pendingLogMigration && isSuperAdminEmail(activeEmail));
        migNotice.classList.toggle('hidden', !showMig);
      }

      const canResetLog = isSuperAdminEmail(activeEmail);
      const resetBtn = document.getElementById('btn-reset-changelog');
      const compactBtn = document.getElementById('btn-compact-changelog');
      const dangerResetBtn = document.getElementById('btn-danger-reset-changelog');
      if (resetBtn) resetBtn.classList.toggle('hidden', !canResetLog);
      if (compactBtn) compactBtn.classList.toggle('hidden', !canResetLog);
      if (dangerResetBtn) dangerResetBtn.classList.toggle('hidden', !canResetLog);

      renderChangeLogTable();
      populateGrantPersonDropdown(personsArr);
      renderCollaboratorsList(permissions);
      renderTreeMembersEmailDirectory(personsArr, permissions);
      renderAuditTrail();
      renderAppErrorLog();
    }

    function renderChangeLogTable() {
      document.querySelectorAll('.change-filter-btn').forEach(btn => {
        const active = btn.dataset.changeFilter === changeLogFilter;
        btn.setAttribute('aria-pressed', String(active));
        if (active) {
          btn.classList.add('bg-white', 'text-archival-indigo', 'shadow-2xs');
          btn.classList.remove('text-slate-600');
        } else {
          btn.classList.remove('bg-white', 'text-archival-indigo', 'shadow-2xs');
          btn.classList.add('text-slate-600');
        }
      });

      const tbody = document.getElementById('changelog-table-body');
      const query = (document.getElementById('changelog-search-input').value || '').toLowerCase().trim();
      const events = appState.changeEvents || [];

      const filtered = events.filter(ev => {
        if (changeLogFilter === 'reverted' && !ev.reverted) return false;
        if (changeLogFilter === 'access' && ev.category !== 'Access Control') return false;
        if (changeLogFilter === 'tree' && (ev.category === 'Access Control' || ev.category === 'Revert')) return false;
        if (query) {
          const hay = `#${ev.sequence} ${ev.summary} ${ev.category} ${ev.actorRole} ${ev.timestamp}`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });

      const pageCount = Math.max(1, Math.ceil(filtered.length / CHANGE_LOG_PAGE_SIZE));
      if (changeLogPage > pageCount) changeLogPage = pageCount;
      if (changeLogPage < 1) changeLogPage = 1;
      const start = (changeLogPage - 1) * CHANGE_LOG_PAGE_SIZE;
      const pageRows = filtered.slice(start, start + CHANGE_LOG_PAGE_SIZE);
      const pager = document.getElementById('changelog-pagination');
      const pageLabel = document.getElementById('changelog-page-label');
      const prevBtn = document.getElementById('btn-changelog-prev');
      const nextBtn = document.getElementById('btn-changelog-next');
      if (pager) pager.classList.toggle('hidden', filtered.length <= CHANGE_LOG_PAGE_SIZE);
      if (pageLabel) {
        if (filtered.length === 0) pageLabel.textContent = 'Showing 0 of 0';
        else pageLabel.textContent = `Showing ${start + 1}–${start + pageRows.length} of ${filtered.length}`;
      }
      if (prevBtn) prevBtn.disabled = changeLogPage <= 1;
      if (nextBtn) nextBtn.disabled = changeLogPage >= pageCount;

      if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-6 px-4 text-center text-xs text-slate-500">No logged changes yet. Any edit on the Family Tree or Admin Panel appears here automatically.</td></tr>`;
        return;
      }

      tbody.innerHTML = pageRows.map(ev => {
        const diffs = getCachedChangeDiffs(ev);
        const hasSnapshot = entryIsRevertible(ev);
        return `
          <tr class="${ev.reverted ? 'bg-slate-50/80 text-slate-500' : 'hover:bg-parchment-50/70'} transition">
            <td class="py-2.5 px-3 align-top whitespace-nowrap">
              <div class="font-mono font-bold text-slate-800">#${ev.sequence}</div>
              <div class="text-[10px] text-slate-500">${escapeHtml(ev.timestamp)}</div>
            </td>
            <td class="py-2.5 px-3 align-top whitespace-nowrap">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-parchment-200 text-slate-800">${escapeHtml(ev.category)}</span>
            </td>
            <td class="py-2.5 px-3 align-top">
              <div class="font-medium ${ev.reverted ? 'line-through text-slate-500' : 'text-slate-900'}">${escapeHtml(ev.summary)}</div>
              ${diffs.length > 0 ? `<div class="flex flex-wrap gap-1 mt-1">${diffs.slice(0, 6).map(d => `<span class="px-1.5 py-0.2 rounded bg-parchment-100 border border-parchment-300 text-[10px] text-slate-700">${escapeHtml(d.action)}: ${escapeHtml(d.entityName)}</span>`).join('')}${diffs.length > 6 ? `<span class="text-[10px] text-slate-500">+${diffs.length - 6} more</span>` : ''}</div>` : ''}
            </td>
            <td class="py-2.5 px-3 align-top whitespace-nowrap text-[11px] font-medium text-slate-700">${escapeHtml(ev.actorRole || 'Super Admin')}</td>
            <td class="py-2.5 px-3 align-top whitespace-nowrap">
              ${ev.reverted
                ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-200 text-slate-700">Reverted</span>`
                : `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800">Persisted</span>`
              }
            </td>
            <td class="py-2.5 px-3 align-top text-right whitespace-nowrap">
              <div class="inline-flex items-center gap-1.5">
                <button type="button" data-review-change="${escapeHtml(ev.id)}" class="px-2.5 py-1 rounded-lg bg-parchment-100 hover:bg-parchment-200 border border-parchment-300 text-[11px] font-semibold text-slate-800 transition">Review</button>
                ${(hasSnapshot && !ev.reverted) ? `<button type="button" data-quick-revert-change="${escapeHtml(ev.id)}" class="px-2.5 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 border border-amber-300 text-[11px] font-semibold text-amber-900 transition">↶ Revert</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    function populateGrantPersonDropdown(personsArr) {
      const sel = document.getElementById('grant-person-select');
      const prevVal = sel.value;
      const sorted = [...personsArr].sort((a, b) => getPersonName(a).localeCompare(getPersonName(b)));
      sel.innerHTML = `<option value="">— External Collaborator (Not in Tree) —</option>` +
        sorted.map(p => {
          const firstEmail = (p.emails && p.emails[0]) ? ` (${p.emails[0]})` : '';
          return `<option value="${escapeHtml(p.id)}">${escapeHtml(getPersonName(p))}${escapeHtml(firstEmail)}</option>`;
        }).join('');
      if (prevVal && appState.persons[prevVal]) sel.value = prevVal;
    }

    function renderCollaboratorsList(permissions) {
      document.querySelectorAll('.role-filter-btn').forEach(btn => {
        const active = btn.dataset.filterRole === filterRole;
        btn.setAttribute('aria-pressed', String(active));
        if (active) {
          btn.classList.add('bg-white', 'text-archival-indigo', 'shadow-2xs');
          btn.classList.remove('text-slate-600');
        } else {
          btn.classList.remove('bg-white', 'text-archival-indigo', 'shadow-2xs');
          btn.classList.add('text-slate-600');
        }
      });

      const container = document.getElementById('collaborators-list-container');
      const q = (document.getElementById('collab-search-input').value || '').toLowerCase().trim();

      const filtered = permissions.filter(pm => {
        if (filterRole === 'edit' && pm.role === 'view') return false;
        if (filterRole === 'view' && pm.role !== 'view') return false;
        if (q) {
          const linkedPerson = pm.personId ? appState.persons[pm.personId] : null;
          const hay = `${pm.email || ''} ${pm.note || ''} ${linkedPerson ? getPersonName(linkedPerson) : ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        container.innerHTML = `<div class="p-4 text-center text-xs text-slate-500 border border-dashed border-parchment-300 rounded-xl">No collaborator permissions match the filter.</div>`;
        return;
      }

      container.innerHTML = filtered.map(pm => {
        const isSuper = isSuperAdminEmail(pm.email) || pm.role === 'super_admin';
        const linkedPerson = (pm.personId && appState.persons[pm.personId]) || findPersonByEmail(pm.email);
        const isEdit = pm.role === 'edit' || pm.role === 'admin' || isSuper;

        return `
          <div class="p-3 rounded-xl border ${isSuper ? 'border-amber-300 bg-amber-50/40' : 'border-parchment-300 bg-parchment-50/60'} flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-xs text-slate-900 truncate">${escapeHtml(pm.email)}</span>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${isSuper ? 'bg-amber-100 text-amber-900' : isEdit ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-archival-indigo'}">
                  ${isSuper ? 'Super Admin' : isEdit ? 'Edit Access' : 'View Access'}
                </span>
              </div>
              <div class="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                ${linkedPerson ? `<span>Tree Member: <strong class="text-slate-700">${escapeHtml(getPersonName(linkedPerson))}</strong></span>` : `<span>External Google Account</span>`}
                ${pm.note ? `<span>· ${escapeHtml(pm.note)}</span>` : ''}
              </div>
            </div>

            <div class="flex items-center gap-1.5 shrink-0 flex-wrap">
              ${isSuper ? `
                <span class="px-2.5 py-1 rounded-lg bg-amber-100/80 text-amber-900 text-[11px] font-semibold">Protected Owner</span>
              ` : canManageAccess() ? `
                <select data-change-perm-role="${escapeHtml(pm.id)}" aria-label="Change permission level" class="px-2 py-1 text-xs bg-white border border-parchment-300 rounded-lg font-medium text-slate-800 focus:border-archival-indigo">
                  <option value="view" ${pm.role === 'view' ? 'selected' : ''}>View Access</option>
                  <option value="edit" ${pm.role === 'edit' ? 'selected' : ''}>Edit Access</option>
                </select>
                <button type="button" data-revoke-perm="${escapeHtml(pm.id)}" aria-label="Revoke access for ${escapeHtml(pm.email)}" class="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-medium transition">Revoke</button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    function renderTreeMembersEmailDirectory(personsArr, permissions) {
      const container = document.getElementById('tree-members-email-list');
      const q = (document.getElementById('tree-member-search').value || '').toLowerCase().trim();

      const sorted = [...personsArr]
        .filter(p => {
          if (!q) return true;
          return `${getPersonName(p)} ${(p.emails || []).join(' ')}`.toLowerCase().includes(q);
        })
        .sort((a, b) => getPersonName(a).localeCompare(getPersonName(b)));

      if (sorted.length === 0) {
        container.innerHTML = `<div class="p-4 text-center text-xs text-slate-500 border border-dashed border-parchment-300 rounded-xl">No individuals in the tree yet. Import a GEDCOM file or add a person on the Family Tree canvas.</div>`;
        return;
      }

      const DIRECTORY_RENDER_CAP = 150;
      const capped = sorted.slice(0, DIRECTORY_RENDER_CAP);
      const overflowNote = sorted.length > DIRECTORY_RENDER_CAP
        ? `<div class="p-2.5 text-center text-[11px] text-slate-600 bg-parchment-50 border border-dashed border-parchment-300 rounded-xl">Showing ${DIRECTORY_RENDER_CAP} of ${sorted.length} people — type in the filter box to find someone.</div>`
        : '';

      container.innerHTML = capped.map(p => {
        const emails = p.emails || [];
        return `
          <div class="p-3 rounded-xl border border-parchment-200 bg-parchment-50/50 space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="font-serif font-semibold text-sm text-slate-900">${escapeHtml(getPersonName(p))}</div>
              <span class="text-[10px] font-mono text-slate-400">${escapeHtml(p.id)}</span>
            </div>

            ${emails.length > 0 ? `
              <div class="space-y-1.5">
                ${emails.map(em => {
                  const isSuper = isSuperAdminEmail(em);
                  const perm = permissions.find(pm => normEmail(pm.email) === normEmail(em));
                  return `
                    <div class="flex flex-wrap items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-parchment-200 text-xs">
                      <span class="font-medium text-slate-800 truncate">${escapeHtml(em)}</span>
                      <div class="flex items-center gap-1.5 shrink-0">
                        ${isSuper ? `<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">Super Admin</span>` : canManageAccess() ? `
                          <button type="button" data-quick-grant-email="${escapeHtml(em)}" data-quick-grant-person="${escapeHtml(p.id)}" data-quick-grant-role="view" class="px-2 py-0.5 rounded text-[10px] font-semibold transition ${perm?.role === 'view' ? 'bg-archival-indigo text-white' : 'bg-indigo-50 text-archival-indigo hover:bg-indigo-100'}">View</button>
                          <button type="button" data-quick-grant-email="${escapeHtml(em)}" data-quick-grant-person="${escapeHtml(p.id)}" data-quick-grant-role="edit" class="px-2 py-0.5 rounded text-[10px] font-semibold transition ${perm?.role === 'edit' ? 'bg-emerald-700 text-white' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}">Edit</button>
                          <button type="button" data-remove-tree-email="${escapeHtml(em)}" data-remove-tree-person="${escapeHtml(p.id)}" title="Remove Email & Access" aria-label="Remove ${escapeHtml(em)} and its access" class="text-slate-500 hover:text-rose-600 px-1">✕</button>
                        ` : `<span class="px-2 py-0.5 rounded text-[10px] font-semibold ${perm?.role === 'edit' || perm?.role === 'admin' ? 'bg-emerald-100 text-emerald-800' : perm?.role === 'view' ? 'bg-indigo-50 text-archival-indigo' : 'bg-slate-100 text-slate-600'}">${perm?.role === 'edit' || perm?.role === 'admin' ? 'Edit' : perm?.role === 'view' ? 'View' : 'Email only'}</span>`}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `<div class="text-[11px] text-slate-400 italic">No Google email linked</div>`}

            ${canManageAccess() ? `
            <form data-add-tree-email-form="${escapeHtml(p.id)}" class="flex items-center gap-1.5 pt-0.5">
              <input type="email" name="memberEmail" required autocomplete="off" spellcheck="false" aria-label="Add Google email for ${escapeHtml(getPersonName(p))}" placeholder="Add Google email for ${escapeHtml(p.given || 'member')}..." class="flex-1 px-2.5 py-1 text-xs bg-white border border-parchment-300 rounded-lg focus:border-archival-indigo" />
              <select name="memberRole" aria-label="Access level" class="px-2 py-1 text-xs bg-white border border-parchment-300 rounded-lg font-medium text-slate-700">
                <option value="view" selected>View</option>
                <option value="edit">Edit</option>
              </select>
              <button type="submit" class="px-2.5 py-1 rounded-lg bg-parchment-100 hover:bg-parchment-200 border border-parchment-300 text-[11px] font-semibold text-slate-800 transition shrink-0">+ Add</button>
            </form>
            ` : ''}
          </div>
        `;
      }).join('') + overflowNote;
    }

    function renderAuditTrail() {
      const container = document.getElementById('admin-audit-list');
      const logs = appState.accessControl.auditLog || [];
      if (logs.length === 0) {
        container.innerHTML = `<div class="text-xs text-slate-500 italic">No permission actions recorded yet.</div>`;
        return;
      }
      container.innerHTML = logs.map(item => `
        <div class="p-2 rounded-lg bg-parchment-50 border border-parchment-200 text-xs">
          <div class="text-slate-800 font-medium">${escapeHtml(item.summary)}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(item.timestamp)}</div>
        </div>
      `).join('');
    }

    function copyTextSafe(text, successMsg) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => showToast(successMsg)).catch(() => copyTextLegacy(text, successMsg));
        return;
      }
      copyTextLegacy(text, successMsg);
    }

    function copyTextLegacy(text, successMsg) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      showToast(successMsg);
    }

    /* =====================================================================
     * EVENT LISTENERS
     * ===================================================================== */
    function initAdminEvents() {
      document.getElementById('btn-admin-google-auth').addEventListener('click', () => {
        const alreadySignedIn = Boolean(getActiveAdminEmail());
        triggerAdminGoogleSignIn(alreadySignedIn);
      });
      document.getElementById('btn-gate-google-signin').addEventListener('click', () => triggerAdminGoogleSignIn(false));
      document.getElementById('btn-gate-google-redirect').addEventListener('click', triggerAdminGoogleRedirect);
      document.getElementById('btn-admin-signout').addEventListener('click', signOutAdminSession);

      // Reset Change Log Handlers
      const promptResetChangeLog = () => {
        if (!isSuperAdminEmail(getActiveAdminEmail())) {
          showToast('Only the Super Admin can reset the change log.');
          return;
        }
        openConfirmActionModal({
          title: 'Reset Firestore Change Log',
          description: 'This will clear the change-log document (' + getArchiveLogDocPath() + '), including revert snapshots, and write a single marker entry that records who reset it and when. Your family tree, relationships, and user permissions will not be changed. Download a backup first if you might need the history later.',
          showDeleteAllOptions: false,
          offerLogBackup: true,
          confirmLabel: 'Reset Change Log',
          onConfirm: () => { executeResetChangeLog(); }
        });
      };
      document.getElementById('btn-reset-changelog').addEventListener('click', promptResetChangeLog);
      document.getElementById('btn-danger-reset-changelog').addEventListener('click', promptResetChangeLog);
      const promptCompactChangeLog = () => {
        if (!isSuperAdminEmail(getActiveAdminEmail())) {
          showToast('Only the Super Admin can compact the change log.');
          return;
        }
        openConfirmActionModal({
          title: 'Compact the change log',
          description: 'This converts old full-tree revert snapshots into compact diffs of only the records that changed, and keeps at most the last three full snapshots as checkpoints. Revert still works from those diffs and checkpoints. Download a backup first if you might need the current log later.',
          showDeleteAllOptions: false,
          offerLogBackup: true,
          confirmLabel: 'Compact log',
          onConfirm: () => { executeCompactChangeLog(); }
        });
      };
      document.getElementById('btn-compact-changelog').addEventListener('click', promptCompactChangeLog);

      // Delete All & Reset Archive Handlers
      const promptDeleteAllArchive = () => {
        openConfirmActionModal({
          title: 'Delete All Tree Records & Reset Archive',
          description: 'This permanently deletes all individuals, family unions, citations, and change logs in Cloud Firestore so you can start completely fresh. Your Super Admin account remains protected.',
          showDeleteAllOptions: true,
          confirmLabel: 'Delete All & Reset',
          onConfirm: ({ alsoClearCollaborators }) => executeDeleteAllAndResetArchive(alsoClearCollaborators)
        });
      };
      document.getElementById('btn-danger-delete-all').addEventListener('click', promptDeleteAllArchive);
      const copyErrorLog = async () => {
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), errors: loadAppErrorLog() }, null, 2);
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(payload);
          else copyTextSafe(payload, 'Copied the error log.');
          showToast('Copied the error log.');
        } catch (e) { copyTextSafe(payload, 'Copied the error log.'); }
      };
      document.getElementById('btn-error-log-copy')?.addEventListener('click', copyErrorLog);
      document.getElementById('btn-error-log-download')?.addEventListener('click', () => { downloadAppErrorLog(); showToast('Downloaded the error log.'); });
      document.getElementById('btn-error-log-clear')?.addEventListener('click', () => { clearAppErrorLog(); renderAppErrorLog(); showToast('Cleared the error log on this device.'); });
      window.addEventListener('osr-app-error-log', () => renderAppErrorLog());


      document.getElementById('btn-close-confirm-modal').addEventListener('click', () => {
        document.getElementById('modal-admin-confirm').classList.add('hidden');
      });
      document.getElementById('btn-cancel-confirm-modal').addEventListener('click', () => {
        document.getElementById('modal-admin-confirm').classList.add('hidden');
      });

      if (authChannel) {
        authChannel.onmessage = () => {
          if (auth && auth.currentUser) {
            auth.currentUser.reload().then(() => renderAdmin()).catch(() => renderAdmin());
          } else {
            renderAdmin();
          }
        };
      }

      document.getElementById('grant-person-select').addEventListener('change', e => {
        const pid = e.target.value;
        const emailInput = document.getElementById('grant-email-input');
        if (pid && appState.persons[pid] && appState.persons[pid].emails?.length > 0) {
          emailInput.value = appState.persons[pid].emails[0];
        }
      });

      document.getElementById('grant-email-input')?.addEventListener('input', () => {
        paintEmailWarning(document.getElementById('grant-email-input').value, document.getElementById('grant-email-warning'));
      });
      document.getElementById('form-grant-access').addEventListener('submit', e => {
        e.preventDefault();
        const personId = document.getElementById('grant-person-select').value || null;
        const email = document.getElementById('grant-email-input').value.trim();
        const role = (document.querySelector('input[name="accessRole"]:checked')?.value === 'edit') ? 'edit' : 'view';
        const note = document.getElementById('grant-note-input').value.trim();
        if (!canManageAccess()) {
          showToast('Only the Super Admin can change who may sign in or whether they can edit.');
          return;
        }
        if (!email) return;
        paintEmailWarning(email, document.getElementById('grant-email-warning'));
        grantOrUpdatePermission(email, personId, role, note);
        e.target.reset();
        paintEmailWarning('', document.getElementById('grant-email-warning'));
      });

      document.querySelectorAll('.change-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          changeLogFilter = btn.dataset.changeFilter;
          changeLogPage = 1;
          renderChangeLogTable();
        });
      });
      document.getElementById('changelog-search-input').addEventListener('input', () => {
        changeLogPage = 1;
        renderChangeLogTable();
      });
      document.getElementById('btn-changelog-prev')?.addEventListener('click', () => {
        changeLogPage -= 1;
        renderChangeLogTable();
      });
      document.getElementById('btn-changelog-next')?.addEventListener('click', () => {
        changeLogPage += 1;
        renderChangeLogTable();
      });
      document.querySelectorAll('[data-admin-tab-btn]').forEach(btn => {
        btn.addEventListener('click', () => setAdminTab(btn.getAttribute('data-admin-tab-btn')));
      });
      window.addEventListener('hashchange', () => setAdminTab(tabFromHash(), { updateHash: false }));
      setAdminTab(tabFromHash(), { updateHash: false });
      document.getElementById('btn-download-readable-backup')?.addEventListener('click', () => {
        if (!isAdminAuthorized()) return;
        downloadReadableBackup();
      });
      document.getElementById('btn-data-open-gedcom')?.addEventListener('click', () => {
        openAdminGedcomModal(false);
      });

      document.querySelectorAll('.role-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          filterRole = btn.dataset.filterRole;
          renderCollaboratorsList(appState.accessControl.permissions || []);
        });
      });
      document.getElementById('collab-search-input').addEventListener('input', () => {
        renderCollaboratorsList(appState.accessControl.permissions || []);
      });
      let treeMemberSearchTimer = null;
      document.getElementById('tree-member-search').addEventListener('input', () => {
        clearTimeout(treeMemberSearchTimer);
        treeMemberSearchTimer = setTimeout(() => {
          renderTreeMembersEmailDirectory(Object.values(appState.persons), appState.accessControl.permissions || []);
        }, 120);
      });

      function refreshAdminGedcomExport() {
        const ver = document.getElementById('admin-ged-version').value;
        const redact = document.getElementById('admin-ged-redact-living').checked;
        const gedText = serializeArchiveToGedcom(ver, redact);
        document.getElementById('admin-gedcom-textarea').value = gedText;
        const pCount = Object.keys(appState.persons).length;
        const fCount = Object.keys(appState.families).length;
        document.getElementById('admin-ged-roundtrip-status').textContent = `✓ Verified GEDCOM ${ver} export ready (${pCount} individuals, ${fCount} families).`;
      }

      function openAdminGedcomModal(importFocus = false) {
        if (!isAdminAuthorized()) return;
        pendingAdminGedcomParsed = null;
        document.getElementById('admin-ged-reconcile-box').classList.add('hidden');
        if (importFocus && Object.keys(appState.persons).length === 0) {
          document.getElementById('admin-gedcom-textarea').value = '';
          document.getElementById('admin-ged-roundtrip-status').textContent = 'Firestore archive is currently empty. Upload a .ged file or paste GEDCOM text below to import.';
        } else {
          refreshAdminGedcomExport();
        }
        document.getElementById('modal-admin-gedcom').classList.remove('hidden');
      }

      document.getElementById('btn-banner-open-gedcom')?.addEventListener('click', () => openAdminGedcomModal(true));

      document.getElementById('btn-close-gedcom-admin').addEventListener('click', () => {
        document.getElementById('modal-admin-gedcom').classList.add('hidden');
      });

      document.getElementById('btn-admin-gen-gedcom').addEventListener('click', refreshAdminGedcomExport);
      document.getElementById('admin-ged-version').addEventListener('change', refreshAdminGedcomExport);
      document.getElementById('admin-ged-redact-living').addEventListener('change', refreshAdminGedcomExport);
      document.getElementById('admin-ged-import-emails').addEventListener('change', () => {
        if (pendingAdminGedcomParsed && !document.getElementById('admin-ged-reconcile-box').classList.contains('hidden')) {
          document.getElementById('btn-admin-preview-ged').click();
        }
      });

      document.getElementById('btn-admin-copy-gedcom').addEventListener('click', () => {
        copyTextSafe(document.getElementById('admin-gedcom-textarea').value, 'GEDCOM copied to clipboard');
      });

      document.getElementById('btn-admin-download-gedcom').addEventListener('click', () => {
        const text = document.getElementById('admin-gedcom-textarea').value;
        if (!text.trim()) {
          showToast('Nothing to download yet — click Generate first.');
          return;
        }
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${((appState.tree.title || getSiteTitle() || getArchiveId()).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || getArchiveId())}.ged`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        showToast('Downloaded .ged archive');
      });

      document.getElementById('input-admin-ged-file').addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          document.getElementById('admin-gedcom-textarea').value = String(ev.target?.result || '');
          document.getElementById('btn-admin-preview-ged').click();
        };
        reader.onerror = () => showToast('Could not read that file.');
        reader.readAsText(file);
        e.target.value = ''; // allow re-selecting the same file later
      });

      document.getElementById('btn-admin-preview-ged').addEventListener('click', () => {
        const raw = document.getElementById('admin-gedcom-textarea').value.trim();
        const box = document.getElementById('admin-ged-reconcile-box');
        if (!raw) {
          showToast('Upload a .ged file or paste GEDCOM text first');
          return;
        }
        let parsed;
        try {
          parsed = parseGedcomArchiveText(raw);
        } catch (parseErr) {
          console.error('GEDCOM parse error:', parseErr);
          box.classList.remove('hidden');
          box.innerHTML = `<div class="text-rose-800 font-semibold">This file could not be read as GEDCOM: ${escapeHtml(parseErr?.message || 'unknown error')}</div>`;
          pendingAdminGedcomParsed = null;
          return;
        }
        parsed._rawSource = raw;
        pendingAdminGedcomParsed = parsed;
        box.classList.remove('hidden');
        box.innerHTML = `
          <div class="flex flex-wrap items-center justify-between gap-2 font-bold text-slate-900">
            <span>GEDCOM ${escapeHtml(parsed.version)} Reconciliation Report</span>
            <span class="text-emerald-700">${parsed.personCount} Individuals · ${parsed.familyCount} Families · ${parsed.totalChildLinks} Parent-Child Links</span>
          </div>
          ${parsed.previewFamilies.length > 0 ? `
            <div class="pt-1 border-t border-indigo-100 space-y-1 text-[11px] text-slate-700">
              <div class="font-semibold text-archival-indigo">Sample Family Link Verification:</div>
              ${parsed.previewFamilies.map(line => `<div class="truncate">• ${escapeHtml(line)}</div>`).join('')}
            </div>
          ` : ''}
          <div class="text-slate-500 text-[11px]">Preserved custom extension tags: <strong>${parsed.customTagCount}</strong></div>
          ${parsed.personCount === 0 ? `<div class="text-rose-800 font-semibold">No INDI (individual) records were found — check that this is a GEDCOM file.</div>` : ''}
          ${parsed.importedEmailCount > 0 ? `<div class="p-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-950">⚠ This file contains <strong>${parsed.importedEmailCount}</strong> email address${parsed.importedEmailCount === 1 ? '' : 'es'}. ${document.getElementById('admin-ged-import-emails').checked ? 'They will be saved as contact details on each person. Importing does <strong>not</strong> give anyone sign-in access; only the Super Admin can grant View or Edit access.' : 'They will be skipped (Import EMAIL addresses is off).'}</div>` : ''}
        `;
      });

      document.getElementById('btn-admin-commit-gedcom').addEventListener('click', () => {
        if (!isAdminAuthorized()) return;
        const raw = document.getElementById('admin-gedcom-textarea').value.trim();
        if (!raw) {
          showToast('No GEDCOM content to import');
          return;
        }
        // Re-parse if the textarea changed after "Validate & Preview" (prevents importing a stale preview)
        const parsed = (pendingAdminGedcomParsed && pendingAdminGedcomParsed._rawSource === raw)
          ? pendingAdminGedcomParsed
          : parseGedcomArchiveText(raw);
        delete parsed._rawSource;
        if (!document.getElementById('admin-ged-import-emails').checked) {
          Object.values(parsed.persons).forEach(pr => { pr.emails = []; });
        }
        if (parsed.personCount === 0) {
          showToast('No INDI records found in GEDCOM text');
          return;
        }

        const mode = document.getElementById('admin-ged-import-mode').value;
        const candidate = deepClone(appState);
        const beforeSnap = captureDomainSnapshot(candidate);

        if (mode === 'replace') {
          candidate.persons = parsed.persons;
          candidate.families = parsed.families;
          const matchedSuperPerson = findPersonByEmailInState(candidate, getStoredSuperAdminEmail(candidate));
          const defaultId = matchedSuperPerson ? matchedSuperPerson.id : (Object.keys(parsed.persons)[0] || null);
          candidate.centralPersonId = defaultId;
          candidate.selectedPersonId = defaultId;
        } else {
          Object.assign(candidate.persons, parsed.persons);
          Object.assign(candidate.families, parsed.families);
          if (!candidate.centralPersonId || !candidate.persons[candidate.centralPersonId]) {
            const matchedSuperPerson = findPersonByEmailInState(candidate, getStoredSuperAdminEmail(candidate));
            const defaultId = matchedSuperPerson ? matchedSuperPerson.id : (Object.keys(candidate.persons)[0] || null);
            candidate.centralPersonId = defaultId;
            candidate.selectedPersonId = defaultId;
          }
        }

        syncTreeEmailsWithPermissions(candidate);
        const summary = `${isSuperAdminEmail(getActiveAdminEmail(), candidate) ? 'Super Admin' : 'Admin'} imported ${parsed.personCount} people & ${parsed.familyCount} families (GEDCOM ${parsed.version}, ${mode})`;
        const afterSnap = captureDomainSnapshot(candidate);
        recordAdminChangeEvent(summary, 'GEDCOM', beforeSnap, afterSnap, candidate);

        const split = splitStateForWrite(candidate);
        const preparedMain = prepareMainWrite(split.tree);
        const preparedLog = prepareLogWrite(deepClone(split.log));
        renderStorageMeter({ main: preparedMain.estimate, log: preparedLog.estimate }, { projected: true, blockedMain: !preparedMain.ok });
        if (!preparedMain.ok) {
          showToast(`Import not applied: the tree document would use about ${formatStorageKb(preparedMain.bytes)} and exceed Firestore's 1 MB single-document limit. Import a smaller file or remove media/notes.`);
          return;
        }

        appState = normalizeState(candidate);
        logAudit(summary);
        pendingAdminGedcomParsed = null;
        diffCache.clear();
        persistState(appState);
        document.getElementById('modal-admin-gedcom').classList.add('hidden');
        renderAdmin();
        showToast(summary);
      });

      document.getElementById('btn-close-review-modal').addEventListener('click', () => {
        document.getElementById('modal-review-change').classList.add('hidden');
      });

      document.addEventListener('click', e => {
        const reviewBtn = e.target.closest('[data-review-change]');
        if (reviewBtn) {
          openReviewChangeModal(reviewBtn.dataset.reviewChange);
          return;
        }

        const quickRevBtn = e.target.closest('[data-quick-revert-change]');
        if (quickRevBtn) {
          requestRevert(quickRevBtn.dataset.quickRevertChange, false);
          return;
        }

        const execSingleRev = e.target.closest('[data-exec-revert-single]');
        if (execSingleRev) {
          requestRevert(execSingleRev.dataset.execRevertSingle, false);
          return;
        }

        const execFullRollback = e.target.closest('[data-exec-rollback-full]');
        if (execFullRollback) {
          requestRevert(execFullRollback.dataset.execRollbackFull, true);
          return;
        }

        if (e.target.id === 'btn-footer-close-review') {
          document.getElementById('modal-review-change').classList.add('hidden');
          return;
        }

        const revokeBtn = e.target.closest('[data-revoke-perm]');
        if (revokeBtn) {
          if (!canManageAccess()) {
            showToast('Only the Super Admin can change who may sign in or whether they can edit.');
            return;
          }
          const permId = revokeBtn.dataset.revokePerm;
          const list = appState.accessControl.permissions || [];
          const target = list.find(p => p.id === permId);
          if (!target) return;
          if (isSuperAdminEmail(target.email)) {
            showToast('Super Admin cannot be revoked');
            return;
          }

          const beforeSnap = captureDomainSnapshot(appState);
          appState.accessControl.permissions = list.filter(p => p.id !== permId);
          Object.values(appState.persons).forEach(p => {
            if (Array.isArray(p.emails)) {
              p.emails = p.emails.filter(em => normEmail(em) !== normEmail(target.email));
            }
          });
          const summary = `Revoked access for ${target.email}`;
          logAudit(summary);
          const afterSnap = captureDomainSnapshot(appState);
          recordAdminChangeEvent(summary, 'Access Control', beforeSnap, afterSnap);

          persistState(appState);
          renderAdmin();
          showToast(summary);
          return;
        }

        const quickGrantBtn = e.target.closest('[data-quick-grant-email]');
        if (quickGrantBtn) {
          grantOrUpdatePermission(
            quickGrantBtn.dataset.quickGrantEmail,
            quickGrantBtn.dataset.quickGrantPerson,
            quickGrantBtn.dataset.quickGrantRole
          );
          return;
        }

        const remTreeEmail = e.target.closest('[data-remove-tree-email]');
        if (remTreeEmail) {
          if (!canManageAccess()) {
            showToast('Only the Super Admin can change who may sign in or whether they can edit.');
            return;
          }
          const email = remTreeEmail.dataset.removeTreeEmail;
          if (isSuperAdminEmail(email)) {
            showToast('Super Admin email cannot be removed');
            return;
          }
          const pid = remTreeEmail.dataset.removeTreePerson;
          const person = appState.persons[pid];
          if (!person) return;

          const beforeSnap = captureDomainSnapshot(appState);
          person.emails = (person.emails || []).filter(em => normEmail(em) !== normEmail(email));
          appState.accessControl.permissions = (appState.accessControl.permissions || []).filter(
            pm => normEmail(pm.email) !== normEmail(email)
          );
          const summary = `Removed email ${email} from ${getPersonName(person)}`;
          logAudit(summary);
          const afterSnap = captureDomainSnapshot(appState);
          recordAdminChangeEvent(summary, 'Access Control', beforeSnap, afterSnap);

          persistState(appState);
          renderAdmin();
          showToast(summary);
          return;
        }
      });

      document.addEventListener('change', e => {
        const roleSel = e.target.closest('[data-change-perm-role]');
        if (roleSel) {
          if (!canManageAccess()) {
            showToast('Only the Super Admin can change who may sign in or whether they can edit.');
            return;
          }
          const permId = roleSel.dataset.changePermRole;
          const newRole = roleSel.value === 'edit' ? 'edit' : 'view';
          const target = (appState.accessControl.permissions || []).find(p => p.id === permId);
          if (!target || target.role === newRole) return;
          if (isSuperAdminEmail(target.email)) return;

          const summary = `Changed ${target.email} to ${newRole === 'edit' ? 'Edit Access' : 'View Access'}`;
          const prevRole = target.role;
          openConfirmActionModal({
            title: 'Change access role',
            description: `Change ${target.email} from ${prevRole === 'edit' ? 'Edit Access' : 'View Access'} to ${newRole === 'edit' ? 'Edit Access' : 'View Access'}?`,
            confirmLabel: 'Change role',
            onConfirm: () => {
              const current = (appState.accessControl.permissions || []).find(p => p.id === permId);
              if (!current || isSuperAdminEmail(current.email)) return;
              const beforeSnap = captureDomainSnapshot(appState);
              current.role = newRole;
              current.updatedAt = new Date().toISOString().slice(0, 10);
              logAudit(summary);
              const afterSnap = captureDomainSnapshot(appState);
              recordAdminChangeEvent(summary, 'Access Control', beforeSnap, afterSnap);
              persistState(appState);
              renderAdmin();
              showToast(summary);
            }
          });
          roleSel.value = target.role === 'edit' ? 'edit' : 'view';
        }
      });

      document.addEventListener('submit', e => {
        const addForm = e.target.closest('[data-add-tree-email-form]');
        if (addForm) {
          e.preventDefault();
          const pid = addForm.dataset.addTreeEmailForm;
          const person = appState.persons[pid];
          if (!person) return;
          const input = addForm.querySelector('input[name="memberEmail"]');
          const roleSelect = addForm.querySelector('select[name="memberRole"]');
          const email = (input.value || '').trim().toLowerCase();
          const role = (roleSelect?.value === 'edit') ? 'edit' : 'view';
          if (!canManageAccess()) {
            showToast('Only the Super Admin can change who may sign in or whether they can edit.');
            return;
          }
          if (!email) return;

          grantOrUpdatePermission(email, pid, role, `Tree Member (${getPersonName(person)})`);
          input.value = '';
        }
      });
    }


    /* =====================================================================
     * ACCESSIBLE MODAL HELPER (shared by Admin Panel & Family Tree)
     * Escape closes the top-most dialog, Tab is trapped inside it, focus is
     * moved into the dialog on open and restored to the opener on close.
     * ===================================================================== */
    const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function initAccessibleModals(modalIds, onEscapeWithoutModal) {
      const lastFocus = new Map();
      const getVisibleFocusables = (root) => Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(n => n.offsetParent !== null || n === document.activeElement);

      modalIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        const heading = el.querySelector('h2, h3');
        if (heading) {
          if (!heading.id) heading.id = `${id}-heading`;
          el.setAttribute('aria-labelledby', heading.id);
        }
        let wasHidden = el.classList.contains('hidden');
        new MutationObserver(() => {
          const hidden = el.classList.contains('hidden');
          if (hidden === wasHidden) return;
          wasHidden = hidden;
          if (!hidden) {
            lastFocus.set(id, document.activeElement);
            requestAnimationFrame(() => {
              if (el.contains(document.activeElement)) return;
              const first = getVisibleFocusables(el)[0];
              if (first) first.focus();
            });
          } else {
            const prev = lastFocus.get(id);
            if (prev && document.contains(prev) && typeof prev.focus === 'function') prev.focus();
          }
        }).observe(el, { attributes: true, attributeFilter: ['class'] });

        // Click on the dimmed backdrop (not inside the card) closes the dialog
        let downOnBackdrop = false;
        el.addEventListener('mousedown', e => { downOnBackdrop = e.target === el; });
        el.addEventListener('click', e => {
          if (downOnBackdrop && e.target === el) el.classList.add('hidden');
          downOnBackdrop = false;
        });
      });

      document.addEventListener('keydown', e => {
        const openModals = modalIds
          .map(mid => document.getElementById(mid))
          .filter(m => m && !m.classList.contains('hidden'));
        const top = openModals[openModals.length - 1];
        if (!top) {
          if (e.key === 'Escape' && typeof onEscapeWithoutModal === 'function') onEscapeWithoutModal(e);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          top.classList.add('hidden');
          return;
        }
        if (e.key === 'Tab') {
          const items = getVisibleFocusables(top);
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (!top.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      });
    }

    initAdminEvents();

    /* =====================================================================
     * HEADER OVERFLOW ("More") MENU: narrow screens only
     * Items proxy the real header buttons, so every action keeps its handler.
     * ===================================================================== */
    function isStateHidden(el, stopAt) {
      for (let n = el; n && n !== stopAt; n = n.parentElement) {
        if (n.classList.contains('auth-hidden')) return true;
        if (n.classList.contains('hidden') && !n.hasAttribute('data-responsive')) return true;
      }
      return false;
    }

    function initHeaderOverflowMenu(btnId, menuId, rootId) {
      const btn = document.getElementById(btnId);
      const menu = document.getElementById(menuId);
      const root = document.getElementById(rootId) || document.body;
      if (!btn || !menu) return;
      const items = () => Array.from(menu.querySelectorAll('[data-proxy-for]'));
      const visibleItems = () => items().filter(it => !it.hidden && it.offsetParent !== null && !it.disabled);
      const sync = () => {
        items().forEach(it => {
          const target = document.getElementById(it.dataset.proxyFor);
          const unavailable = !target || isStateHidden(target, root.parentElement);
          it.hidden = unavailable;
          it.disabled = Boolean(target && target.disabled);
          if (target && it.hasAttribute('aria-checked')) {
            it.setAttribute('aria-checked', String(target.getAttribute('aria-pressed') === 'true'));
          }
          const labelSrc = it.dataset.labelFrom && document.getElementById(it.dataset.labelFrom);
          const labelDst = it.querySelector('[data-label-slot]');
          if (labelSrc && labelDst) labelDst.textContent = labelSrc.textContent.trim();
        });
        // Hide group separators that have nothing visible after them
        menu.querySelectorAll('[data-menu-sep]').forEach(sep => {
          let n = sep.nextElementSibling;
          let any = false;
          while (n && !n.hasAttribute('data-menu-sep')) {
            if (n.hasAttribute('data-proxy-for') && !n.hidden && getComputedStyle(n).display !== 'none') any = true;
            n = n.nextElementSibling;
          }
          sep.hidden = !any;
        });
      };
      const close = (returnFocus) => {
        if (menu.classList.contains('hidden')) return;
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
        if (returnFocus) btn.focus();
      };
      const open = () => {
        sync();
        menu.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        const first = visibleItems()[0];
        if (first) first.focus();
      };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.classList.contains('hidden')) open(); else close(false);
      });
      menu.addEventListener('click', (e) => {
        const it = e.target.closest('[data-proxy-for]');
        if (!it || it.disabled) return;
        e.stopPropagation();
        close(false);
        const target = document.getElementById(it.dataset.proxyFor);
        if (target) target.click();
      });
      menu.addEventListener('keydown', (e) => {
        const list = visibleItems();
        const idx = list.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (list[(idx + 1) % list.length] || list[0])?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (list[(idx - 1 + list.length) % list.length] || list[0])?.focus(); }
        else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
        else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
        else if (e.key === 'Tab') { close(false); }
      });
      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== btn) close(false);
      });
      window.addEventListener('resize', () => close(false));
    }

    initHeaderOverflowMenu('btn-admin-header-more', 'admin-header-more-menu', 'admin-header');
    initAccessibleModals(['modal-review-change', 'modal-admin-gedcom', 'modal-admin-confirm']);
    renderAdmin();
    // Named (not only on the test hook) so runMarkLivingMutation works in production builds.
    /* Share link (Super Admin) and suggestions review (Admins) — src/share-core.js */
    let shareStore = createShareStore(() => db, { doc, getDoc, setDoc, deleteDoc, updateDoc, writeBatch, collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp }, { treeId: getArchiveId });
    let shareConfigCache;            // undefined = not loaded, null = no link yet
    let suggestionsCache = [];
    let sharingLoadedFor = '';
    let sharingBusy = false;

    function canManageShareLink() {
      return isAdminAuthorized() && canManageAccess();
    }
    function currentShareUrl() {
      return shareConfigCache && shareConfigCache.token ? buildShareUrl(location.href, shareConfigCache.token) : '';
    }
    function setShareStatus(text) {
      const el = document.getElementById('share-link-status');
      if (el) el.textContent = text || '';
    }
    function renderShareLinkCard() {
      const card = document.getElementById('share-link-card');
      if (!card) return;
      const allowed = canManageShareLink();
      card.classList.toggle('hidden', !allowed);
      if (!allowed) return;
      const cfg = shareConfigCache;
      const has = Boolean(cfg && cfg.token);
      document.getElementById('share-link-empty').classList.toggle('hidden', has || cfg === undefined);
      document.getElementById('share-link-present').classList.toggle('hidden', !has);
      const toggle = document.getElementById('share-link-active');
      toggle.disabled = !has || sharingBusy;
      toggle.checked = Boolean(has && cfg.active);
      document.getElementById('share-link-active-label').textContent = has && cfg.active ? 'On' : 'Off';
      document.getElementById('share-link-url').value = has ? currentShareUrl() : '';
      ['btn-share-copy', 'btn-share-regenerate', 'btn-share-refresh', 'btn-share-create'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = sharingBusy;
      });
      if (has && !document.getElementById('share-link-status').textContent) {
        setShareStatus(cfg.active ? 'The link is on. Visitors see the guest view.' : 'The link is off. Visitors see “This share link is not available”.');
      }
    }
    async function refreshSharingTab() {
      const email = getActiveAdminEmail();
      if (canManageShareLink()) {
        try { shareConfigCache = await shareStore.loadConfig(); }
        catch (err) { shareConfigCache = undefined; setShareStatus('Could not load the share link: ' + (formatFirestoreError(err).text || err?.code)); }
      }
      renderShareLinkCard();
      if (isAdminAuthorized()) {
        try { suggestionsCache = await shareStore.listSuggestions(); }
        catch (err) { suggestionsCache = []; showToast('Could not load suggestions: ' + (formatFirestoreError(err).text || err?.code)); }
      }
      sharingLoadedFor = email;
      renderSuggestions();
    }
    function guestMeta() {
      return { updatedAt: new Date().toISOString(), updatedByEmail: getActiveAdminEmail(), updatedByUid: (firebaseUser && firebaseUser.uid) || '' };
    }
    async function publishGuestViewNow() {
      const fields = buildGuestDocFields(appState, guestMeta());
      await shareStore.publishGuestView(fields);
      return fields;
    }
    let guestRefreshTimer = null;
    function scheduleGuestViewRefresh(delayMs = 3000) {
      if (!isAdminAuthorized()) return;
      clearTimeout(guestRefreshTimer);
      guestRefreshTimer = setTimeout(async () => {
        try { if (await shareStore.guestViewExists()) await publishGuestViewNow(); }
        catch (err) { console.warn('Guest view refresh skipped:', err?.code || err); }
      }, delayMs);
    }
    async function withSharingBusy(fn) {
      if (sharingBusy) return null;
      sharingBusy = true; renderShareLinkCard();
      try { return await fn(); }
      catch (err) { setShareStatus('That did not work: ' + (formatFirestoreError(err).text || err?.message || err?.code)); showToast('Share link change failed.'); return null; }
      finally { sharingBusy = false; renderShareLinkCard(); }
    }
    function createShareLink() {
      if (!canManageShareLink()) return null;
      return withSharingBusy(async () => {
        const token = generateShareToken();
        await shareStore.rotate({ newToken: token, oldToken: null, active: true, uid: firebaseUser.uid });
        shareConfigCache = { token, active: true };
        await publishGuestViewNow();
        setShareStatus('Share link created and turned on. The guest view was published.');
        showToast('Share link created.');
        return token;
      });
    }
    function regenerateShareLink() {
      if (!canManageShareLink() || !shareConfigCache?.token) return null;
      return withSharingBusy(async () => {
        const oldToken = shareConfigCache.token;
        const token = generateShareToken();
        await shareStore.rotate({ newToken: token, oldToken, active: Boolean(shareConfigCache.active), uid: firebaseUser.uid });
        shareConfigCache = { token, active: Boolean(shareConfigCache.active) };
        setShareStatus('New link created. The old link stopped working immediately; send the new one to the family.');
        showToast('Share link regenerated. The old link no longer works.');
        return token;
      });
    }
    function promptRegenerateShareLink() {
      openConfirmActionModal({
        title: 'Regenerate the share link?',
        description: 'The current link stops working immediately for everyone who has it, including anyone viewing it right now. You will need to send the new link again.',
        confirmLabel: 'Regenerate link',
        onConfirm: () => { regenerateShareLink(); }
      });
    }
    function setShareLinkActive(active) {
      if (!canManageShareLink() || !shareConfigCache?.token) return null;
      return withSharingBusy(async () => {
        await shareStore.setActive({ token: shareConfigCache.token, active, uid: firebaseUser.uid });
        shareConfigCache = { ...shareConfigCache, active: Boolean(active) };
        if (active) await publishGuestViewNow();
        setShareStatus(active ? 'The link is on. Visitors see the guest view.' : 'The link is off. Nobody can open the guest view with it until you turn it back on.');
        showToast(active ? 'Share link turned on.' : 'Share link turned off.');
        return true;
      });
    }
    function refreshGuestViewFromButton() {
      if (!canManageShareLink()) return null;
      return withSharingBusy(async () => {
        await publishGuestViewNow();
        setShareStatus('Guest view refreshed from the current tree (' + new Date().toLocaleString() + ').');
        showToast('Guest view refreshed.');
        return true;
      });
    }

    function formatSuggestionDate(ts) {
      try {
        const d = ts && typeof ts.toDate === 'function' ? ts.toDate() : (ts ? new Date(ts) : null);
        return d && !isNaN(d) ? d.toLocaleString() : '';
      } catch (e) { return ''; }
    }
    function renderSuggestions() {
      const card = document.getElementById('suggestions-card');
      if (!card) return;
      const allowed = isAdminAuthorized();
      card.classList.toggle('hidden', !allowed);
      if (!allowed) return;
      const filter = document.getElementById('suggestions-filter')?.value || 'pending';
      const items = suggestionsCache.filter(sug => filter === 'all' || sug.status === 'pending');
      document.getElementById('suggestions-pending-count').textContent = String(suggestionsCache.filter(sug => sug.status === 'pending').length);
      document.getElementById('suggestions-empty').classList.toggle('hidden', items.length > 0);
      const list = document.getElementById('suggestions-list');
      list.innerHTML = items.map(sug => {
        const person = appState.persons[sug.personId];
        const name = person ? getPersonName(person) : '(no longer in the tree)';
        const nowVal = person ? currentValueForField(person, sug.field) : '';
        const pill = sug.status === 'approved' ? 'bg-emerald-100 text-emerald-900' : sug.status === 'rejected' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-900';
        const reviewed = sug.status !== 'pending' && sug.reviewedByEmail ? `<p class="text-[11px] text-slate-500">${escapeHtml(sug.status === 'approved' ? 'Approved' : 'Rejected')} by ${escapeHtml(sug.reviewedByEmail)}${sug.reviewedAt ? ' · ' + escapeHtml(formatSuggestionDate(sug.reviewedAt)) : ''}</p>` : '';
        const actions = sug.status === 'pending' ? `<div class="flex gap-2 pt-1">
            <button type="button" data-suggestion-approve="${escapeHtml(sug.id)}" class="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold" ${person ? '' : 'disabled'}>${sug.field === 'other' ? 'Mark done' : 'Approve'}</button>
            <button type="button" data-suggestion-reject="${escapeHtml(sug.id)}" class="px-3 py-1.5 rounded-lg border border-parchment-300 text-slate-700 hover:bg-parchment-100 text-xs font-semibold">Reject</button>
          </div>` : '';
        return `<article class="suggestion-item p-3 rounded-xl border border-parchment-200 bg-parchment-50/60 space-y-1 text-xs" data-suggestion-id="${escapeHtml(sug.id)}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="font-semibold text-slate-900">${escapeHtml(name)} · <span class="font-medium text-slate-700">${escapeHtml(suggestionFieldLabel(sug.field))}</span></p>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${pill}">${escapeHtml(sug.status || 'pending')}</span>
          </div>
          ${sug.field === 'other' ? '' : `<p class="text-slate-700">In the tree now: <span class="font-medium">${escapeHtml(nowVal || '—')}</span></p>`}
          <p class="text-slate-900">${sug.field === 'other' ? 'Request' : 'Suggested'}: <strong>${escapeHtml(sug.newValue || '')}</strong></p>
          ${sug.note ? `<p class="text-slate-600 italic">“${escapeHtml(sug.note)}”</p>` : ''}
          <p class="text-[11px] text-slate-500">From ${escapeHtml(sug.email || '')}${sug.createdAt ? ' · ' + escapeHtml(formatSuggestionDate(sug.createdAt)) : ''}</p>
          ${reviewed}
          ${actions}
        </article>`;
      }).join('');
    }
    async function approveSuggestion(id) {
      const sug = suggestionsCache.find(x => x.id === id);
      if (!sug || sug.status !== 'pending' || !isAdminAuthorized()) return { ok: false };
      const person = appState.persons[sug.personId];
      if (!person) { showToast('That person is no longer in the tree.'); return { ok: false }; }
      if (sug.field !== 'other') {
        const label = suggestionFieldLabel(sug.field);
        const write = commitMutation(
          `Approved suggestion from ${sug.email}: ${label} of ${getPersonName(person)} → ${sug.newValue}`,
          (st) => {
            const r = applySuggestionToState(st, sug, { idFactory: generateId });
            if (!r.ok) throw new Error(r.error || 'not applied');
          },
          'Suggestions'
        );
        if (!write) return { ok: false };
        const result = await write;
        if (!result || result.ok === false) { showToast('The tree was not saved, so the suggestion is still pending.'); return { ok: false, result }; }
      }
      try {
        await shareStore.reviewSuggestion(id, { status: 'approved', email: getActiveAdminEmail(), uid: firebaseUser.uid, reviewNote: sug.field === 'other' ? 'Marked done; no automatic change.' : '' });
      } catch (err) {
        showToast('The change was applied, but marking the suggestion approved failed: ' + (formatFirestoreError(err).text || err?.code));
        return { ok: false, error: err };
      }
      Object.assign(sug, { status: 'approved', reviewedByEmail: getActiveAdminEmail(), reviewedAt: new Date() });
      renderSuggestions();
      showToast(sug.field === 'other' ? 'Suggestion marked done.' : 'Suggestion approved and applied to the tree.');
      return { ok: true };
    }
    async function rejectSuggestion(id) {
      const sug = suggestionsCache.find(x => x.id === id);
      if (!sug || sug.status !== 'pending' || !isAdminAuthorized()) return { ok: false };
      try {
        await shareStore.reviewSuggestion(id, { status: 'rejected', email: getActiveAdminEmail(), uid: firebaseUser.uid });
      } catch (err) {
        showToast('Could not reject: ' + (formatFirestoreError(err).text || err?.code));
        return { ok: false, error: err };
      }
      Object.assign(sug, { status: 'rejected', reviewedByEmail: getActiveAdminEmail(), reviewedAt: new Date() });
      renderSuggestions();
      showToast('Suggestion rejected. The tree was not changed.');
      return { ok: true };
    }
    function bindSharingUi() {
      document.getElementById('btn-share-create')?.addEventListener('click', () => createShareLink());
      document.getElementById('btn-share-copy')?.addEventListener('click', () => { const u = currentShareUrl(); if (u) copyTextSafe(u, 'Share link copied.'); });
      document.getElementById('btn-share-regenerate')?.addEventListener('click', () => promptRegenerateShareLink());
      document.getElementById('btn-share-refresh')?.addEventListener('click', () => refreshGuestViewFromButton());
      document.getElementById('share-link-active')?.addEventListener('change', (e) => { setShareLinkActive(Boolean(e.target.checked)); });
      document.getElementById('btn-suggestions-reload')?.addEventListener('click', () => refreshSharingTab());
      document.getElementById('suggestions-filter')?.addEventListener('change', () => renderSuggestions());
      document.getElementById('suggestions-list')?.addEventListener('click', (e) => {
        const a = e.target.closest('[data-suggestion-approve]');
        if (a && !a.disabled) { approveSuggestion(a.getAttribute('data-suggestion-approve')); return; }
        const r = e.target.closest('[data-suggestion-reject]');
        if (r) rejectSuggestion(r.getAttribute('data-suggestion-reject'));
      });
    }
    bindSharingUi();

    function commitMutation(summary, mutatorFn, category = 'Tree Data') {
      const beforeSnap = captureDomainSnapshot(appState);
      mutatorFn(appState);
      syncTreeEmailsWithPermissions(appState);
      appState.tree.revision = (appState.tree.revision || 1) + 1;
      const afterSnap = captureDomainSnapshot(appState);
      recordAdminChangeEvent(summary, category, beforeSnap, afterSnap);
      return commitArchiveWrite(appState);
    }

    // Test-only hook: compiled in only for `vite build --mode test` (dist-test/).
    // Production builds define __OSR_TEST_HOOKS__ as false, so this block is dropped.
    if (__OSR_TEST_HOOKS__) {
      window.__ADMIN = {
        setAdminTab,
        getState: () => appState,
        getLatestLog: () => latestLogData,
        getLatestMain: () => latestMainData,
        toastText: () => (document.getElementById('admin-toast')?.textContent || ''),
        countsText: () => (document.getElementById('kpi-change-count')?.textContent || ''),
        logSummary: () => (document.getElementById('admin-storage-log-summary')?.textContent || ''),
        logTableText: () => (document.getElementById('changelog-table-body')?.innerText || ''),
        confirmOpen: () => !document.getElementById('modal-admin-confirm')?.classList.contains('hidden'),
        confirmDesc: () => (document.getElementById('confirm-modal-desc')?.textContent || ''),
        backupOfferVisible: () => !document.getElementById('confirm-modal-backup-wrap')?.classList.contains('hidden'),
        resetButtonVisible: () => !document.getElementById('btn-reset-changelog')?.classList.contains('hidden'),
        dangerResetVisible: () => !document.getElementById('btn-danger-reset-changelog')?.classList.contains('hidden'),
        estimateAll: () => estimateAllStorage(appState),
        classifyPhotoUrl,
        collectPhotoStorageStats,
        renderPhotoStorageStats,
        downloadChangeLogBackup,
        executeResetChangeLog,
        executeCompactChangeLog,
        compactChangeLogEvents,
        reconstructStateBeforeEntry,
        getEntryDiff,
        entryIsRevertible,
        computeDomainDiff,
        applyDomainDiffToSnap,
        captureDomainSnapshot,
        commitMutation,
        revertSpecificChange,
        LOG_CHECKPOINT_LIMIT,
        promptReset: () => document.getElementById('btn-reset-changelog')?.click(),
        promptCompact: () => document.getElementById('btn-compact-changelog')?.click(),
        compactButtonVisible: () => !document.getElementById('btn-compact-changelog')?.classList.contains('hidden'),
        confirmReset: () => document.getElementById('btn-exec-confirm-modal')?.click(),
        clickBackupOffer: () => document.getElementById('btn-confirm-download-log-backup')?.click(),
        installTestSession({ email, uid = 'test-uid', state, main, log }) {
          firebaseUser = email ? { email, uid, emailVerified: true } : null;
          firestoreAccessDenied = false;
          authStateResolved = true;
          if (main || log) {
            applyLoadedDocuments(main || latestMainData, log || latestLogData);
          } else if (state) {
            appState = normalizeState(state);
            const split = splitStateForWrite(appState, { keepEmbedded: false });
            const meta = { updatedAt: new Date().toISOString(), updatedByEmail: email || '', updatedByUid: uid };
            latestMainData = prepareMainWrite(split.tree, meta).fields;
            latestLogData = prepareLogWrite(split.log, meta).fields;
            archiveBaseUpdatedAt = latestMainData.updatedAt;
            archiveBaseRevision = latestMainData.revision;
            logBaseUpdatedAt = latestLogData.updatedAt;
            pendingLogMigration = false;
          }
          renderAdmin();
          return { events: (appState.changeEvents || []).length, pending: pendingLogMigration };
        },
        setTestWrite(fn) { testWriteImpl = fn; },
        setShareStore(store) { shareStore = store; },
        refreshSharingTab,
        createShareLink,
        regenerateShareLink,
        promptRegenerateShareLink,
        setShareLinkActive,
        refreshGuestViewFromButton,
        approveSuggestion,
        rejectSuggestion,
        shareConfig: () => shareConfigCache,
        suggestions: () => suggestionsCache,
        planMarkLivingForNonDeceased,
        applyMarkLivingForNonDeceased,
        formatMarkLivingConfirmation,
        openMarkLivingDialog,
        closeMarkLivingDialog,
        confirmMarkLiving,
        refreshLivingStatusCard,
        canRunMarkLivingTool,
        personHasDeathEvent,
        DEFAULT_LIVING_STATUS,
        parseGedcomArchiveText,
        serializeArchiveToGedcom,
        normalizeUnionStatus,
        applyLoadedDocuments,
        formatError: formatFirestoreError,
        recordAppError,
        loadAppErrorLog,
        clearAppErrorLog,
        renderAppErrorLog
      };
    }

    function registerPwa() {
      try {
        if (!('serviceWorker' in navigator)) return;
        const host = location.hostname;
        const ok = location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
        if (!ok) return;
        const swUrl = new URL('/sw.js', location.origin).href;
        navigator.serviceWorker.register(swUrl, { scope: '/' }).catch(() => {});
      } catch (e) {}
    }
    registerPwa();


    document.getElementById('btn-mark-living')?.addEventListener('click', () => openMarkLivingDialog());
    document.getElementById('btn-living-confirm')?.addEventListener('click', () => confirmMarkLiving());
    document.getElementById('btn-living-cancel')?.addEventListener('click', () => closeMarkLivingDialog());
    document.getElementById('living-confirm-close')?.addEventListener('click', () => closeMarkLivingDialog());
    document.getElementById('living-confirm-backdrop')?.addEventListener('click', () => closeMarkLivingDialog());
    document.querySelectorAll('[data-admin-tab-btn="data"]').forEach(btn => btn.addEventListener('click', () => setTimeout(refreshLivingStatusCard, 0)));

    const params = new URLSearchParams(location.search);
    if (__OSR_TEST_HOOKS__ && params.get('test') === '1') {
      authStateResolved = true;
      renderAdmin();
    } else {
      initAdminFirebase();
    }
  