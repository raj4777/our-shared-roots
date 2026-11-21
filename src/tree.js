window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

import { applyHostingAuthDomain } from './firebase-config.js';
import { computeAccessListsFromPermissions, frozenAccessListsFromMainDoc, reconcilePermissionsWithMainDoc, describeAclReport, nextArchiveRevision } from './acl-core.js';

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
    } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

    function getOsConfig() {
      return (window.OSR_CONFIG && typeof window.OSR_CONFIG === 'object') ? window.OSR_CONFIG : {};
    }
    function getSiteTitle() {
      const t = String(getOsConfig().siteTitle || 'Family Tree').trim();
      return t || 'Family Tree';
    }
    function getConfiguredSuperAdminEmail() {
      return String(getOsConfig().superAdminEmail || '').trim().toLowerCase();
    }
    function getArchiveId() {
      const id = String(getOsConfig().archiveId || 'familytree').trim();
      return id || 'familytree';
    }
    function getArchiveLogId() {
      const raw = getOsConfig().archiveLogId;
      if (raw && String(raw).trim()) return String(raw).trim();
      return getArchiveId() + '_log';
    }
    function getArchiveDocPath() { return 'archives/' + getArchiveId(); }
    function getArchiveLogDocPath() { return 'archives/' + getArchiveLogId(); }
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

    // Immediately ensure no unauthenticated records linger in localStorage
    purgeLocalCachedRecords();

    let firebaseApp = null;
    let auth = null;
    let db = null;
    let firebaseUser = null;
    let unsubscribeArchive = null;
    let unsubscribeLog = null;
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

    /* =====================================================================
     * 1. CORE UTILITY, DATE & AGE CALCULATION HELPERS
     * ===================================================================== */
    function generateId(prefix = 'id') {
      return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
    }

    function deepClone(obj) {
      return JSON.parse(JSON.stringify(obj));
    }

    function escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function escapeAttr(str) {
      return escapeHtml(str);
    }

    // Only https:// image links are shown. data:, http:, blob: and relative
    // addresses are rejected so an embedded data URL cannot run script or
    // bloat the archive. Existing non-https values stay in the record but
    // do not render; isBlockedImageUrl flags them in the profile.
    function safeImageUrl(url) {
      const s = String(url || '').trim();
      if (!s) return '';
      if (/^https:\/\//i.test(s)) return s;
      return '';
    }

    function isBlockedImageUrl(url) {
      const s = String(url || '').trim();
      return Boolean(s && !safeImageUrl(s));
    }

    function describeBlockedImageUrl(url) {
      const s = String(url || '').trim();
      if (!s) return '';
      if (/^data:/i.test(s)) return 'This image is stored as an embedded data URL and is no longer displayed. Replace it with an https:// link.';
      return 'Only https:// image links are displayed. This address was skipped.';
    }

    function normEmail(email) {
      return String(email || '').trim().toLowerCase();
    }

    function toRomanNumeral(num) {
      const lookup = [['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]];
      let n = Math.max(1, Math.floor(num));
      let out = '';
      for (const [sym, val] of lookup) {
        while (n >= val) { out += sym; n -= val; }
      }
      return out;
    }

    const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTH_NAMES_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const MONTH_LOOKUP = {
      JAN: 0, JANUARY: 0,
      FEB: 1, FEBRUARY: 1,
      MAR: 2, MARCH: 2,
      APR: 3, APRIL: 3,
      MAY: 4,
      JUN: 5, JUNE: 5,
      JUL: 6, JULY: 6,
      AUG: 7, AUGUST: 7,
      SEP: 8, SEPT: 8, SEPTEMBER: 8,
      OCT: 9, OCTOBER: 9,
      NOV: 10, NOVEMBER: 10,
      DEC: 11, DECEMBER: 11
    };

    function normalizeDateQualifier(token) {
      if (!token) return null;
      const q = String(token).trim().toUpperCase();
      if (q === 'ABT' || q === 'ABOUT' || q === 'CIRCA' || q === 'EST' || q === 'CAL' || q === 'C' || q === 'CA') return 'ABT';
      if (q === 'BEF' || q === 'BEFORE') return 'BEF';
      if (q === 'AFT' || q === 'AFTER') return 'AFT';
      if (q === 'BET' || q === 'BETWEEN') return 'BET';
      return null;
    }

    function splitDateQualifier(raw) {
      const text = String(raw || '').trim();
      const m = text.match(/^(ABT|ABOUT|CIRCA|BEF|BEFORE|AFT|AFTER|EST|CAL|BET|BETWEEN|C\.|CA\.|C|CA)\b\.?\s*/i);
      if (!m) return { qualifier: null, body: text, raw: text };
      return { qualifier: normalizeDateQualifier(m[1].replace(/\.$/, '')), body: text.slice(m[0].length).trim(), raw: text };
    }

    function parseNumericDayMonthYear(body) {
      const num = String(body || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if (!num) return null;
      let day = parseInt(num[1], 10);
      let month = parseInt(num[2], 10);
      const year = parseInt(num[3], 10);
      // Indian default is DD/MM/YYYY. If the second number cannot be a month
      // (e.g. 05/25/2007), treat it as MM/DD/YYYY instead.
      if (month > 12 && day >= 1 && day <= 12) {
        const swap = day; day = month; month = swap;
      }
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return { year, month: month - 1, day };
    }

    function parseOneDateBody(body, raw, qualifier) {
      const text = String(body || '').trim();
      if (!text) return null;

      const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (iso) {
        return { year: parseInt(iso[1], 10), month: parseInt(iso[2], 10) - 1, day: parseInt(iso[3], 10), raw, qualifier };
      }

      const numeric = parseNumericDayMonthYear(text);
      if (numeric) return { ...numeric, raw, qualifier };

      const ged = text.match(/^(\d{1,2})\s+([A-Z]+)\s+(\d{4})$/i);
      if (ged && MONTH_LOOKUP[ged[2].toUpperCase()] !== undefined) {
        return { year: parseInt(ged[3], 10), month: MONTH_LOOKUP[ged[2].toUpperCase()], day: parseInt(ged[1], 10), raw, qualifier };
      }

      const nat = text.match(/^([A-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
      if (nat && MONTH_LOOKUP[nat[1].toUpperCase()] !== undefined) {
        return { year: parseInt(nat[3], 10), month: MONTH_LOOKUP[nat[1].toUpperCase()], day: parseInt(nat[2], 10), raw, qualifier };
      }

      const my = text.match(/^([A-Z]+)\s+(\d{4})$/i);
      if (my && MONTH_LOOKUP[my[1].toUpperCase()] !== undefined) {
        return { year: parseInt(my[2], 10), month: MONTH_LOOKUP[my[1].toUpperCase()], day: null, raw, qualifier };
      }

      const yr = text.match(/^(\d{4})$/) || text.match(/\b(\d{4})\b/);
      if (yr) {
        return { year: parseInt(yr[1], 10), month: null, day: null, raw, qualifier };
      }
      return null;
    }

    function parseFlexibleDateParts(dateStr) {
      if (!dateStr) return null;
      const raw = typeof dateStr === 'object' ? (dateStr.original || dateStr.start || '') : String(dateStr).trim();
      if (!raw) return null;

      const split = splitDateQualifier(raw);
      if (split.qualifier === 'BET') {
        const range = split.body.match(/^(.*?)\s+AND\s+(.*)$/i);
        if (range) {
          const start = parseOneDateBody(range[1], raw, 'BET');
          const end = parseOneDateBody(range[2], raw, 'BET');
          if (start || end) {
            return { ...(start || end), qualifier: 'BET', rangeStart: start, rangeEnd: end, raw };
          }
        }
      }

      const parsed = parseOneDateBody(split.body, raw, split.qualifier);
      if (parsed) return parsed;
      // Last resort: keep a qualifier even if only a year can be pulled from the original string.
      const yr = raw.match(/\b(\d{4})\b/);
      if (yr) return { year: parseInt(yr[1], 10), month: null, day: null, raw, qualifier: split.qualifier };
      return null;
    }

    function qualifierPrefix(qualifier) {
      if (qualifier === 'ABT') return 'c. ';
      if (qualifier === 'BEF') return 'before ';
      if (qualifier === 'AFT') return 'after ';
      return '';
    }

    function formatParsedDate(parts, style = 'short') {
      if (!parts || !parts.year) return '';
      if (parts.month !== null && parts.month !== undefined && parts.day !== null && parts.day !== undefined) {
        const mName = style === 'long' ? MONTH_NAMES_LONG[parts.month] : MONTH_NAMES_SHORT[parts.month];
        return `${mName} ${parts.day} ${parts.year}`;
      }
      if (parts.month !== null && parts.month !== undefined) {
        const mName = style === 'long' ? MONTH_NAMES_LONG[parts.month] : MONTH_NAMES_SHORT[parts.month];
        return `${mName} ${parts.year}`;
      }
      return String(parts.year);
    }

    function formatDisplayDate(dateStr, style = 'short') {
      const parts = parseFlexibleDateParts(dateStr);
      if (!parts) return String(dateStr || '');
      if (parts.qualifier === 'BET' && (parts.rangeStart || parts.rangeEnd)) {
        const a = formatParsedDate(parts.rangeStart, style) || '…';
        const b = formatParsedDate(parts.rangeEnd, style) || '…';
        return `${a}–${b}`;
      }
      const core = formatParsedDate(parts, style);
      if (!core) return String(dateStr || '');
      return qualifierPrefix(parts.qualifier) + core;
    }

    function computeAgeYears(birthDateStr, targetDateStr = null) {
      const b = parseFlexibleDateParts(birthDateStr);
      if (!b || !b.year) return null;

      let t = targetDateStr ? parseFlexibleDateParts(targetDateStr) : null;
      if (!t) {
        const now = new Date();
        t = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
      }
      if (!t || !t.year || t.year < b.year) return null;

      let age = t.year - b.year;
      if (b.month !== null && t.month !== null) {
        if (t.month < b.month || (t.month === b.month && b.day !== null && t.day !== null && t.day < b.day)) {
          age -= 1;
        }
      }
      return age >= 0 ? age : null;
    }

    function extractYearLabel(dateStr) {
      if (!dateStr) return '';
      const parts = parseFlexibleDateParts(dateStr);
      if (!parts) {
        const raw = typeof dateStr === 'object' ? (dateStr.original || dateStr.start || '') : String(dateStr);
        return raw;
      }
      if (parts.qualifier === 'BET' && parts.rangeStart && parts.rangeEnd && parts.rangeStart.year && parts.rangeEnd.year) {
        return `${parts.rangeStart.year}–${parts.rangeEnd.year}`;
      }
      if (!parts.year) {
        const raw = typeof dateStr === 'object' ? (dateStr.original || dateStr.start || '') : String(dateStr);
        return raw;
      }
      if (parts.qualifier === 'ABT') return `c. ${parts.year}`;
      if (parts.qualifier === 'BEF') return `<${parts.year}`;
      if (parts.qualifier === 'AFT') return `>${parts.year}`;
      return String(parts.year);
    }

    function showToast(msg) {
      const banner = document.getElementById('toast-banner');
      if (!banner) return;
      banner.textContent = msg;
      banner.classList.remove('hidden');
      clearTimeout(banner._timer);
      banner._timer = setTimeout(() => banner.classList.add('hidden'), 3200);
    }

    function setCloudSyncIndicator(status, label) {
      const pill = document.getElementById('cloud-sync-pill');
      const dot = document.getElementById('cloud-sync-dot');
      const text = document.getElementById('cloud-sync-text');
      if (!pill || !dot || !text) return;
      text.textContent = label;
      if (status === 'syncing') {
        pill.className = 'hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[10.5px] font-semibold text-amber-800 shrink-0';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse';
      } else if (status === 'offline') {
        pill.className = 'hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-100 border border-slate-300 text-[10.5px] font-semibold text-slate-700 shrink-0';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
      } else {
        pill.className = 'hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-[10.5px] font-semibold text-emerald-800 shrink-0';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
      }
    }

    /* =====================================================================
     * 2. BLANK INITIAL ARCHIVE STATE (ZERO HARDCODED DATA OR EMAILS)
     * ===================================================================== */
    function createBlankDataset() {
      return {
        tree: {
          id: getDefaultTreeId(),
          title: getSiteTitle(),
          revision: 1
        },
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

    /* =====================================================================
     * 3. STATE NORMALIZATION, AUTO-SYNC TREE EMAILS & ROLE RESOLUTION
     * ===================================================================== */
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
        const existingIdx = perms.findIndex(pm => (pm.email || '').toLowerCase() === storedSuper);
        if (existingIdx === -1) {
          perms.unshift({
            id: 'perm_super_admin',
            email: storedSuper,
            personId: findPersonByEmailInState(s, storedSuper)?.id || null,
            role: 'super_admin',
            note: 'Super Admin & Archive Owner',
            updatedAt: new Date().toISOString().slice(0, 10)
          });
        } else {
          perms[existingIdx].role = 'super_admin';
          perms[existingIdx].email = storedSuper;
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

    function normalizeAppState(rawState) {
      const s = rawState || createBlankDataset();
      s.tree = s.tree || { id: getDefaultTreeId(), title: getSiteTitle(), revision: 1 };
      s.persons = s.persons || {};
      s.families = s.families || {};

      Object.values(s.persons).forEach(p => {
        if (!Array.isArray(p.emails)) p.emails = p.email ? [p.email] : [];
        if (!Array.isArray(p.events)) p.events = [];
        if (!Array.isArray(p.assertions)) p.assertions = [];
        if (!Array.isArray(p.customTags)) p.customTags = [];
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

    let appState = normalizeAppState(createBlankDataset());
    let undoStack = [];
    let redoStack = [];
    let firestoreAccessDenied = false;

    let sessionAuth = {
      email: '',
      displayName: '',
      photoURL: '',
      isAuthenticated: false
    };

    let uiState = {
      viewMode: 'canvas',
      inspectorOpen: false,
      inspectorTab: 'profile', // 'profile' | 'edit' | 'add' | 'evidence'
      accordions: {
        photos: false,
        bio: false,
        family: false,
        facts: true
      },
      showPhotoAddForm: false,
      showFactAddForm: false,
      showAssertionAddForm: false,
      editingFactItem: null,
      generationDepth: 5,
      collapsedAncestorIds: new Set(),
      panX: 36,
      panY: 36,
      zoom: 1,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0,
      highlightedKinship: null,
      // Focus (accordion) view: only the focused person's line is expanded.
      focusMode: true,
      focusPersonId: null
    };
    // Screenshot mode was removed. Drop leftover flags so a restored uiState
    // object can never keep the tree in a redacted state.
    delete uiState.privacyMode;
    delete uiState.revealLivingInInspector;

    const VIEW_MODE_STORAGE_KEY = 'osr_tree_view_mode';      // 'focus' | 'full'
    const FOCUS_PERSON_STORAGE_KEY = 'osr_tree_focus_person';
    try {
      const savedMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (savedMode === 'full') uiState.focusMode = false;
      uiState.focusPersonId = localStorage.getItem(FOCUS_PERSON_STORAGE_KEY) || null;
    } catch (e) { /* storage unavailable (private mode): defaults apply */ }

    function saveViewPrefs() {
      try {
        localStorage.setItem(VIEW_MODE_STORAGE_KEY, uiState.focusMode ? 'focus' : 'full');
        if (uiState.focusPersonId) localStorage.setItem(FOCUS_PERSON_STORAGE_KEY, uiState.focusPersonId);
      } catch (e) {}
    }

    function getActiveUserEmail() {
      if (firebaseUser && firebaseUser.email) {
        return firebaseUser.email.trim().toLowerCase();
      }
      if (sessionAuth.isAuthenticated && sessionAuth.email) {
        return sessionAuth.email.trim().toLowerCase();
      }
      return '';
    }

    function getEffectiveSessionRole() {
      const email = getActiveUserEmail();
      if (!email || !firebaseUser) return 'signed_out';
      if (firestoreAccessDenied) return 'unauthorized';
      if (isSuperAdminEmail(email)) return 'super_admin';

      const perm = (appState.accessControl?.permissions || []).find(
        pm => (pm.email || '').toLowerCase() === email
      );
      if (perm) {
        if (perm.role === 'super_admin' || perm.role === 'admin') return 'admin';
        if (perm.role === 'edit') return 'edit';
        return 'view';
      }

      // A person email on the tree is not enough for Edit or even View:
      // only the Super Admin can put an address on the access lists.
      return 'unauthorized';
    }

    function isAuthorizedViewer() {
      if (!firebaseUser || !firebaseUser.email) return false;
      const role = getEffectiveSessionRole();
      return role === 'super_admin' || role === 'admin' || role === 'edit' || role === 'view';
    }

    function canEditTree() {
      if (!firebaseUser || !firebaseUser.email) return false;
      const role = getEffectiveSessionRole();
      return role === 'super_admin' || role === 'admin' || role === 'edit';
    }

    function canAccessAdminPanel() {
      if (!firebaseUser || !firebaseUser.email) return false;
      const role = getEffectiveSessionRole();
      return role === 'super_admin' || role === 'admin';
    }

    function resolveCentralPersonIdForUser() {
      const email = getActiveUserEmail();
      if (email) {
        const matched = findPersonByEmailInState(appState, email);
        if (matched) return matched.id;
        const perm = (appState.accessControl?.permissions || []).find(
          pm => (pm.email || '').toLowerCase() === email
        );
        if (perm && perm.personId && appState.persons[perm.personId]) {
          return perm.personId;
        }
      }
      if (appState.centralPersonId && appState.persons[appState.centralPersonId]) {
        return appState.centralPersonId;
      }
      return Object.keys(appState.persons)[0] || null;
    }

    /* =====================================================================
     * 4. FIREBASE HOSTING AUTO-CONFIG & NON-BLOCKING PERSISTENT GOOGLE SSO
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

    // Pull a legacy in-payload change log out of a parsed main document, if one is still there.
    function extractEmbeddedLog(parsed) {
      if (!parsed || typeof parsed !== 'object') {
        return { tree: parsed, embeddedLog: null, hadEmbeddedLog: false };
      }
      const hadEmbeddedLog = Object.prototype.hasOwnProperty.call(parsed, 'changeEvents')
        || Object.prototype.hasOwnProperty.call(parsed, 'changeSequence');
      const events = Array.isArray(parsed.changeEvents) ? parsed.changeEvents : [];
      const sequence = typeof parsed.changeSequence === 'number' ? parsed.changeSequence : events.length;
      const tree = { ...parsed };
      delete tree.changeEvents;
      delete tree.changeSequence;
      const embeddedLog = hadEmbeddedLog
        ? { changeEvents: events, changeSequence: sequence }
        : null;
      return { tree, embeddedLog, hadEmbeddedLog };
    }

    function logStateFromLogDoc(data) {
      if (!data || !data.changeLogJson) return null;
      try {
        const parsed = JSON.parse(data.changeLogJson);
        const events = Array.isArray(parsed.changeEvents) ? parsed.changeEvents : [];
        const sequence = typeof parsed.changeSequence === 'number' ? parsed.changeSequence : events.length;
        return { changeEvents: events, changeSequence: sequence };
      } catch (e) {
        console.error('Change log document parse error:', e);
        return null;
      }
    }

    // Prefer the dedicated log document, but keep any embedded entries the log doc does not have,
    // and prefer a copy that still has Before/After snapshots. History is never dropped here.
    function mergeLogStates(embeddedLog, docLog) {
      if (!embeddedLog && !docLog) return { changeEvents: [], changeSequence: 0 };
      if (!embeddedLog) return { changeEvents: docLog.changeEvents || [], changeSequence: docLog.changeSequence || 0 };
      if (!docLog || !(docLog.changeEvents || []).length) {
        return { changeEvents: embeddedLog.changeEvents || [], changeSequence: embeddedLog.changeSequence || 0 };
      }
      const byId = new Map();
      (docLog.changeEvents || []).forEach(ev => { if (ev && ev.id) byId.set(ev.id, ev); });
      (embeddedLog.changeEvents || []).forEach(ev => {
        if (!ev || !ev.id) return;
        const cur = byId.get(ev.id);
        if (!cur) {
          byId.set(ev.id, ev);
        } else if (cur.snapshotsTrimmed && (ev.beforeSnapshot || ev.afterSnapshot)) {
          byId.set(ev.id, ev);
        }
      });
      const changeEvents = Array.from(byId.values()).sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
      const maxSeq = changeEvents.reduce((m, ev) => Math.max(m, ev.sequence || 0), 0);
      return {
        changeEvents,
        changeSequence: Math.max(docLog.changeSequence || 0, embeddedLog.changeSequence || 0, maxSeq)
      };
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
      const state = normalizeAppState({
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

    function canManageAccess(stateObj = appState) {
      return isSuperAdminEmail(getActiveUserEmail(), stateObj);
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
     * - The family tree is written to the configured tree document. The change log
     *   (history and revert snapshots) is written to the configured log document
     *   in the same transaction or batch, so each document has its own 1 MB budget.
     * - If the log document would overflow, the oldest snapshots (then oldest
     *   entries) are trimmed; the tree save is not blocked by the log size.
     * ===================================================================== */
    const FIRESTORE_DOC_LIMIT_BYTES = 1048576; // official 1 MiB cap
    const FIRESTORE_SAFE_DOC_BYTES = 1040000;  // block writes a little under the cap
    const PAYLOAD_JSON_RULES_MAX = 1000000;    // firestore.rules: payloadJson / changeLogJson size
        let archiveBaseUpdatedAt = null;  // updatedAt of the remote main doc appState derives from
    let archiveBaseRevision = null;   // revision of that same remote main doc
    let logBaseUpdatedAt = null;      // updatedAt of the remote log doc
    const ownWriteStamps = new Set(); // updatedAt values written by THIS tab
    function rememberOwnStamp(stamp) {
      if (!stamp) return;
      ownWriteStamps.add(stamp);
    }
    function isOwnEchoSnapshot(data) {
      return Boolean(data && data.updatedAt && ownWriteStamps.has(data.updatedAt));
    }
    let pendingSaveState = null;
    let saveChain = Promise.resolve();
    let pendingLogMigration = false;
    let latestMainData = null;
    let latestLogData = null;

    function utf8ByteLength(str) {
      try { return new TextEncoder().encode(String(str ?? '')).length; } catch (e) { return String(str ?? '').length * 3; }
    }

    // Firestore string size = UTF-8 bytes + 1. Used for collection IDs, document IDs, field names and string values.
    // See https://firebase.google.com/docs/firestore/storage-size
    function firestoreStringSize(str) {
      return utf8ByteLength(str) + 1;
    }

    function firestoreDocumentNameSize(path) {
      return String(path || '').split('/').filter(Boolean).reduce((sum, part) => sum + firestoreStringSize(part), 0) + 16;
    }

    function isFirestoreTimestamp(value) {
      if (!value || typeof value !== 'object') return false;
      if (value instanceof Date) return true;
      if (typeof value.toMillis === 'function' && (typeof value.seconds === 'number' || typeof value._seconds === 'number')) return true;
      const seconds = value.seconds ?? value._seconds;
      const nanos = value.nanoseconds ?? value._nanoseconds;
      const keys = Object.keys(value);
      return keys.length <= 2 && typeof seconds === 'number' && typeof nanos === 'number';
    }

    function firestoreValueSize(value) {
      if (value === null || value === undefined) return 1;
      const t = typeof value;
      if (t === 'boolean') return 1;
      if (t === 'number') return 8;
      if (t === 'string') return firestoreStringSize(value);
      if (t === 'bigint') return 8;
      if (value instanceof Date) return 8;
      if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) return value.byteLength;
      if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength;
      if (isFirestoreTimestamp(value)) return 8;
      if (value && t === 'object' && value.constructor && value.constructor.name === 'GeoPoint') return 16;
      if (value && t === 'object' && typeof value.latitude === 'number' && typeof value.longitude === 'number' && typeof value.isEqual === 'function') return 16;
      if (Array.isArray(value)) {
        let sum = 0;
        for (let i = 0; i < value.length; i++) sum += firestoreValueSize(value[i]);
        return sum;
      }
      if (t === 'object') return firestoreMapSize(value);
      return firestoreStringSize(String(value));
    }

    function firestoreMapSize(map) {
      let size = 32;
      if (!map) return size;
      for (const key of Object.keys(map)) {
        size += firestoreStringSize(key) + firestoreValueSize(map[key]);
      }
      return size;
    }

    function firestoreDocumentSize(fields, path) {
      return firestoreDocumentNameSize(path) + firestoreMapSize(fields);
    }

    function formatStorageKb(bytes) {
      const n = Math.max(0, Number(bytes) || 0);
      const kb = n / 1024;
      if (kb < 10) {
        const rounded = Math.round(kb * 10) / 10;
        return `${String(rounded.toFixed(1)).replace(/\.0$/, '')} KB`;
      }
      return `${Math.round(kb)} KB`;
    }

    function shouldDeferLogMigration() {
      return Boolean(pendingLogMigration);
    }

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

    function reservedSizeForFields(fieldsWithoutPayload, payloadFieldName, path) {
      return firestoreDocumentNameSize(path) + 32
        + Object.keys(fieldsWithoutPayload).reduce((s, k) => s + firestoreStringSize(k) + firestoreValueSize(fieldsWithoutPayload[k]), 0)
        + firestoreStringSize(payloadFieldName);
    }

    function jsonFitsInDoc(json, reserved, maxJsonChars = PAYLOAD_JSON_RULES_MAX) {
      const total = reserved + firestoreStringSize(json);
      const rulesOk = json.length < maxJsonChars && utf8ByteLength(json) < maxJsonChars;
      return { total, rulesOk, ok: rulesOk && total <= FIRESTORE_SAFE_DOC_BYTES };
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
        updatedByEmail: metaExtras.updatedByEmail != null ? metaExtras.updatedByEmail : (getActiveUserEmail() || ''),
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
        updatedByEmail: metaExtras.updatedByEmail != null ? metaExtras.updatedByEmail : (getActiveUserEmail() || ''),
        updatedByUid: metaExtras.updatedByUid != null ? metaExtras.updatedByUid : ((firebaseUser && firebaseUser.uid) || '')
      };
    }

    function describeMainStorage(fields, treeState) {
      const total = firestoreDocumentSize(fields, getArchiveDocPath());
      const payloadBytes = firestoreValueSize(fields.payloadJson || '');
      const accessBytes =
        firestoreStringSize('authorizedEmails') + firestoreValueSize(fields.authorizedEmails || []) +
        firestoreStringSize('editorEmails') + firestoreValueSize(fields.editorEmails || []) +
        (Array.isArray(fields.adminEmails) ? firestoreStringSize('adminEmails') + firestoreValueSize(fields.adminEmails) : 0) +
        firestoreStringSize('superAdminEmail') + firestoreValueSize(fields.superAdminEmail || '');
      return {
        kind: 'main',
        path: getArchiveDocPath(),
        total,
        payloadBytes,
        accessBytes,
        otherBytes: Math.max(0, total - payloadBytes - accessBytes),
        percent: (total / FIRESTORE_DOC_LIMIT_BYTES) * 100,
        personCount: Object.keys((treeState && treeState.persons) || {}).length,
        familyCount: Object.keys((treeState && treeState.families) || {}).length,
        fields
      };
    }

    /* =====================================================================
     * COMPACT CHANGE LOG (osr-diff-v1)
     * Each entry stores a diff of only the touched people, families, title
     * and permissions. At most LOG_CHECKPOINT_LIMIT full snapshots are kept
     * as checkpoints so a revert can be rebuilt and checked.
     * ===================================================================== */
    const LOG_CHECKPOINT_LIMIT = 3;
    const LOG_EVENT_CAP = 60;
    const CHANGE_DIFF_VERSION = 1;

    function stableStringify(value) {
      if (value === undefined) return 'null';
      if (value === null) return 'null';
      const t = typeof value;
      if (t !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
      const keys = Object.keys(value).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
    }

    function recordsEqual(a, b) {
      return stableStringify(a ?? null) === stableStringify(b ?? null);
    }

    function emptyChangeDiff() {
      return { v: CHANGE_DIFF_VERSION, persons: {}, families: {} };
    }

    function computeDomainDiff(beforeSnap, afterSnap) {
      const before = beforeSnap || {};
      const after = afterSnap || {};
      const diff = emptyChangeDiff();
      const bPersons = before.persons || {};
      const aPersons = after.persons || {};
      Object.keys({ ...bPersons, ...aPersons }).forEach(id => {
        const bp = Object.prototype.hasOwnProperty.call(bPersons, id) ? bPersons[id] : null;
        const ap = Object.prototype.hasOwnProperty.call(aPersons, id) ? aPersons[id] : null;
        if (!recordsEqual(bp, ap)) {
          diff.persons[id] = { before: bp == null ? null : deepClone(bp), after: ap == null ? null : deepClone(ap) };
        }
      });
      const bFams = before.families || {};
      const aFams = after.families || {};
      Object.keys({ ...bFams, ...aFams }).forEach(id => {
        const bf = Object.prototype.hasOwnProperty.call(bFams, id) ? bFams[id] : null;
        const af = Object.prototype.hasOwnProperty.call(aFams, id) ? aFams[id] : null;
        if (!recordsEqual(bf, af)) {
          diff.families[id] = { before: bf == null ? null : deepClone(bf), after: af == null ? null : deepClone(af) };
        }
      });
      const bTree = before.tree || {};
      const aTree = after.tree || {};
      if ((bTree.title || '') !== (aTree.title || '') || (bTree.id || '') !== (aTree.id || '')) {
        diff.tree = {
          before: { id: bTree.id || '', title: bTree.title || '' },
          after: { id: aTree.id || '', title: aTree.title || '' }
        };
      }
      const bPerms = (before.accessControl && before.accessControl.permissions) || [];
      const aPerms = (after.accessControl && after.accessControl.permissions) || [];
      if (!recordsEqual(bPerms, aPerms)) {
        diff.permissions = { before: deepClone(bPerms), after: deepClone(aPerms) };
      }
      return diff;
    }

    function changeDiffIsEmpty(diff) {
      if (!diff) return true;
      return Object.keys(diff.persons || {}).length === 0
        && Object.keys(diff.families || {}).length === 0
        && !diff.tree
        && !diff.permissions;
    }

    function countDiffTouches(diff) {
      if (!diff) return 0;
      return Object.keys(diff.persons || {}).length
        + Object.keys(diff.families || {}).length
        + (diff.tree ? 1 : 0)
        + (diff.permissions ? 1 : 0);
    }

    function hasLegacySnapshots(ev) {
      return Boolean(ev && ev.beforeSnapshot && ev.afterSnapshot);
    }

    function hasUsableDiff(ev) {
      return Boolean(ev && ev.changeDiff && ev.changeDiff.v && !changeDiffIsEmpty(ev.changeDiff));
    }

    function getEntryDiff(ev) {
      if (hasUsableDiff(ev)) return ev.changeDiff;
      if (hasLegacySnapshots(ev)) return computeDomainDiff(ev.beforeSnapshot, ev.afterSnapshot);
      return null;
    }

    function entryIsRevertible(ev) {
      return Boolean(ev && !ev.reverted && !ev.resetMarker && (hasUsableDiff(ev) || hasLegacySnapshots(ev)));
    }

    function miniSnapFromDiff(diff, side) {
      const persons = {};
      const families = {};
      Object.keys(diff.persons || {}).forEach(id => {
        const rec = diff.persons[id] && diff.persons[id][side];
        if (rec != null) persons[id] = rec;
      });
      Object.keys(diff.families || {}).forEach(id => {
        const rec = diff.families[id] && diff.families[id][side];
        if (rec != null) families[id] = rec;
      });
      const snap = { persons, families };
      if (diff.tree) snap.tree = diff.tree[side];
      if (diff.permissions) snap.accessControl = { permissions: diff.permissions[side] || [] };
      return snap;
    }

    function cloneDomainSnap(snap) {
      return deepClone({
        tree: (snap && snap.tree) || {},
        persons: (snap && snap.persons) || {},
        families: (snap && snap.families) || {},
        accessControl: { permissions: (snap && snap.accessControl && snap.accessControl.permissions) || [] }
      });
    }

    function applyDomainDiffToSnap(snap, diff, inverse) {
      if (!diff) return { ok: false, error: 'This entry has no compact diff to apply.', state: null };
      const state = cloneDomainSnap(snap);
      const from = inverse ? 'after' : 'before';
      const to = inverse ? 'before' : 'after';
      const mismatches = [];

      Object.keys(diff.persons || {}).forEach(id => {
        const ch = diff.persons[id] || {};
        const expected = Object.prototype.hasOwnProperty.call(ch, from) ? ch[from] : null;
        const next = Object.prototype.hasOwnProperty.call(ch, to) ? ch[to] : null;
        const cur = Object.prototype.hasOwnProperty.call(state.persons, id) ? state.persons[id] : null;
        if (!recordsEqual(cur, expected)) mismatches.push('person:' + id);
        else if (next == null) delete state.persons[id];
        else state.persons[id] = deepClone(next);
      });

      Object.keys(diff.families || {}).forEach(id => {
        const ch = diff.families[id] || {};
        const expected = Object.prototype.hasOwnProperty.call(ch, from) ? ch[from] : null;
        const next = Object.prototype.hasOwnProperty.call(ch, to) ? ch[to] : null;
        const cur = Object.prototype.hasOwnProperty.call(state.families, id) ? state.families[id] : null;
        if (!recordsEqual(cur, expected)) mismatches.push('family:' + id);
        else if (next == null) delete state.families[id];
        else state.families[id] = deepClone(next);
      });

      if (diff.tree) {
        const expectedTitle = (diff.tree[from] && diff.tree[from].title) || '';
        const expectedId = (diff.tree[from] && diff.tree[from].id) || '';
        if ((state.tree.title || '') !== expectedTitle || (state.tree.id || '') !== expectedId) {
          mismatches.push('tree');
        } else {
          if (diff.tree[to]) {
            if (diff.tree[to].title != null) state.tree.title = diff.tree[to].title;
            if (diff.tree[to].id) state.tree.id = diff.tree[to].id;
          }
        }
      }

      if (diff.permissions) {
        const expected = diff.permissions[from] || [];
        if (!recordsEqual(state.accessControl.permissions || [], expected)) mismatches.push('permissions');
        else state.accessControl.permissions = deepClone(diff.permissions[to] || []);
      }

      if (mismatches.length) {
        return {
          ok: false,
          error: 'The tree no longer matches this change, so a revert cannot be reconstructed safely (' + mismatches.length + ' mismatch' + (mismatches.length === 1 ? '' : 'es') + ').',
          mismatches,
          state: null
        };
      }
      return { ok: true, state, error: null };
    }

    function findRevertConflictsFromDiff(diff, currentSnap) {
      if (!diff) return [];
      const conflicts = [];
      Object.keys(diff.persons || {}).forEach(id => {
        const ch = diff.persons[id] || {};
        const cur = (currentSnap.persons || {})[id] || null;
        if (!recordsEqual(cur, ch.after ?? null)) conflicts.push('person:' + id);
      });
      Object.keys(diff.families || {}).forEach(id => {
        const ch = diff.families[id] || {};
        const cur = (currentSnap.families || {})[id] || null;
        if (!recordsEqual(cur, ch.after ?? null)) conflicts.push('family:' + id);
      });
      return conflicts;
    }

    function reconstructStateBeforeEntry(events, target, currentSnap) {
      if (!target) return { ok: false, error: 'That change log entry was not found.', state: null };
      if (target.beforeSnapshot && target.beforeSnapshot.persons) {
        return { ok: true, state: cloneDomainSnap(target.beforeSnapshot), error: null, method: 'legacy-snapshot' };
      }
      const diff = getEntryDiff(target);
      if (!diff && !target.beforeSnapshot) {
        return {
          ok: false,
          error: target.snapshotsTrimmed
            ? 'This entry’s snapshots were trimmed and it has no compact diff, so it cannot be reverted.'
            : 'This entry has no snapshot or compact diff, so it cannot be reverted.',
          state: null
        };
      }

      const ordered = (events || []).slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
      const targetSeq = target.sequence || 0;

      // Prefer a checkpoint at or after the target: walk backward to the before-state.
      const laterCheck = ordered.filter(ev => ev && ev.checkpointSnapshot && (ev.sequence || 0) >= targetSeq)
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))[0];
      if (laterCheck) {
        let cursor = cloneDomainSnap(laterCheck.checkpointSnapshot);
        const toUndo = ordered.filter(ev => (ev.sequence || 0) <= (laterCheck.sequence || 0) && (ev.sequence || 0) >= targetSeq && !ev.resetMarker);
        toUndo.sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
        for (const ev of toUndo) {
          const d = getEntryDiff(ev);
          if (!d) {
            if (ev.id === target.id && ev.beforeSnapshot) {
              return { ok: true, state: cloneDomainSnap(ev.beforeSnapshot), error: null, method: 'legacy-snapshot' };
            }
            return { ok: false, error: 'A later change (#' + ev.sequence + ') has no diff, so this revert cannot be reconstructed.', state: null };
          }
          const step = applyDomainDiffToSnap(cursor, d, true);
          if (!step.ok) {
            return { ok: false, error: 'Could not walk back from a checkpoint through change #' + ev.sequence + ': ' + step.error, state: null };
          }
          cursor = step.state;
        }
        return { ok: true, state: cursor, error: null, method: 'checkpoint-back' };
      }

      // Checkpoint strictly before the target: walk forward from after that checkpoint.
      const earlierCheck = ordered.filter(ev => ev && ev.checkpointSnapshot && (ev.sequence || 0) < targetSeq)
        .sort((a, b) => (b.sequence || 0) - (a.sequence || 0))[0];
      if (earlierCheck) {
        let cursor = cloneDomainSnap(earlierCheck.checkpointSnapshot);
        const toApply = ordered.filter(ev => (ev.sequence || 0) > (earlierCheck.sequence || 0) && (ev.sequence || 0) < targetSeq && !ev.resetMarker && !ev.reverted);
        for (const ev of toApply) {
          const d = getEntryDiff(ev);
          if (!d) return { ok: false, error: 'Change #' + ev.sequence + ' has no diff, so this revert cannot be reconstructed.', state: null };
          const step = applyDomainDiffToSnap(cursor, d, false);
          if (!step.ok) {
            return { ok: false, error: 'Could not walk forward from a checkpoint through change #' + ev.sequence + ': ' + step.error, state: null };
          }
          cursor = step.state;
        }
        return { ok: true, state: cursor, error: null, method: 'checkpoint-forward' };
      }

      // Fall back to the live tree: undo this change and every later non-reverted change.
      if (!currentSnap) {
        return { ok: false, error: 'There is no checkpoint and no current tree to rebuild from.', state: null };
      }
      let cursor = cloneDomainSnap(currentSnap);
      const toUndo = (events || []).filter(ev => ev && !ev.resetMarker && !ev.reverted && (ev.sequence || 0) >= targetSeq)
        .sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
      for (const ev of toUndo) {
        const d = getEntryDiff(ev);
        if (!d) {
          return { ok: false, error: 'Change #' + ev.sequence + ' has no diff, so this revert cannot be reconstructed.', state: null };
        }
        const step = applyDomainDiffToSnap(cursor, d, true);
        if (!step.ok) {
          return { ok: false, error: 'Could not walk back from the current tree through change #' + ev.sequence + ': ' + step.error, state: null };
        }
        cursor = step.state;
      }
      return { ok: true, state: cursor, error: null, method: 'from-current' };
    }

    function isCheckpointCandidate(ev) {
      return Boolean(ev && !ev.resetMarker);
    }

    function assignLogCheckpoints(events, latestAfterSnap, limit) {
      const cap = (typeof limit === 'number' && limit >= 0) ? limit : LOG_CHECKPOINT_LIMIT;
      const list = Array.isArray(events) ? events : [];
      const candidates = list.filter(isCheckpointCandidate);
      const keepIds = new Set(candidates.slice(0, cap).map(ev => ev.id));
      if (!latestAfterSnap) {
        list.forEach(ev => { if (ev && !keepIds.has(ev.id)) delete ev.checkpointSnapshot; });
        return { assigned: 0 };
      }
      let cursor = cloneDomainSnap(latestAfterSnap);
      let assigned = 0;
      for (let i = 0; i < candidates.length; i++) {
        const ev = candidates[i];
        if (keepIds.has(ev.id)) {
          ev.checkpointSnapshot = cloneDomainSnap(cursor);
          assigned++;
        } else {
          delete ev.checkpointSnapshot;
        }
        if (i === candidates.length - 1) break;
        const olderStillKept = candidates.slice(i + 1).some(x => keepIds.has(x.id));
        if (!olderStillKept) {
          for (let j = i + 1; j < candidates.length; j++) delete candidates[j].checkpointSnapshot;
          break;
        }
        const d = getEntryDiff(ev);
        if (d) {
          const step = applyDomainDiffToSnap(cursor, d, true);
          if (!step.ok) {
            // Cannot rebuild older checkpoints from here; keep any they already have if still in window.
            break;
          }
          cursor = step.state;
        } else if (ev.beforeSnapshot) {
          cursor = cloneDomainSnap(ev.beforeSnapshot);
        } else {
          break;
        }
      }
      return { assigned };
    }

    function compactChangeLogEvents(events, currentSnap, limit) {
      const list = Array.isArray(events) ? events : [];
      let converted = 0;
      let alreadyCompact = 0;
      let unrecoverable = 0;
      list.forEach(ev => {
        if (!ev || ev.resetMarker) return;
        if (!hasUsableDiff(ev) && hasLegacySnapshots(ev)) {
          ev.changeDiff = computeDomainDiff(ev.beforeSnapshot, ev.afterSnapshot);
          converted++;
        } else if (hasUsableDiff(ev)) {
          alreadyCompact++;
        } else if (ev.beforeSnapshot || ev.afterSnapshot) {
          // Partial leftover; try a diff anyway
          ev.changeDiff = computeDomainDiff(ev.beforeSnapshot || {}, ev.afterSnapshot || {});
          if (hasUsableDiff(ev)) converted++;
          else unrecoverable++;
        } else if (ev.snapshotsTrimmed) {
          unrecoverable++;
        }
        if (ev.beforeSnapshot) delete ev.beforeSnapshot;
        if (ev.afterSnapshot) delete ev.afterSnapshot;
        if (hasUsableDiff(ev) && ev.snapshotsTrimmed) delete ev.snapshotsTrimmed;
      });
      assignLogCheckpoints(list, currentSnap, limit);
      return { converted, alreadyCompact, unrecoverable, checkpoints: list.filter(ev => ev && ev.checkpointSnapshot).length };
    }

    function countLogCheckpoints(events) {
      return (events || []).filter(ev => ev && ev.checkpointSnapshot).length;
    }

    function countLegacySnapshots(events) {
      return (events || []).filter(ev => ev && (ev.beforeSnapshot || ev.afterSnapshot)).length;
    }

    function appendChangeLogEntry(stateObj, summary, category, beforeSnap, afterSnap, actorStr) {
      stateObj.changeEvents = stateObj.changeEvents || [];
      stateObj.changeSequence = (stateObj.changeSequence || stateObj.changeEvents.length) + 1;
      const now = new Date();
      const stamp = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
      const diff = computeDomainDiff(beforeSnap, afterSnap);
      const entry = {
        id: generateId('chg'),
        sequence: stateObj.changeSequence,
        timestamp: stamp,
        actorRole: actorStr,
        category: category || 'Tree Data',
        summary,
        reverted: false,
        changeDiff: diff
      };
      stateObj.changeEvents.unshift(entry);
      if (stateObj.changeEvents.length > LOG_EVENT_CAP) {
        stateObj.changeEvents.length = LOG_EVENT_CAP;
      }
      assignLogCheckpoints(stateObj.changeEvents, afterSnap, LOG_CHECKPOINT_LIMIT);
      return entry;
    }

    function trimChangeLogToFit(logState, pack, jsonFitsInDoc, reserved) {
      let json = pack();
      let fit = jsonFitsInDoc(json, reserved);
      let trimmedSnapshots = 0;
      let compactedLegacy = 0;
      let droppedEntries = 0;
      const events = Array.isArray(logState.changeEvents) ? logState.changeEvents : [];

      if (!fit.ok) {
        // Convert leftover full before/after snapshots into diffs first.
        const newestAfter = (() => {
          const withCheck = events.find(ev => ev && ev.checkpointSnapshot);
          if (withCheck) return withCheck.checkpointSnapshot;
          const legacy = events.find(ev => ev && ev.afterSnapshot);
          return legacy ? legacy.afterSnapshot : null;
        })();
        const result = compactChangeLogEvents(events, newestAfter, LOG_CHECKPOINT_LIMIT);
        compactedLegacy = result.converted;
        trimmedSnapshots += countLegacySnapshots(events);
        // compactChangeLogEvents already deleted before/after
        json = pack();
        fit = jsonFitsInDoc(json, reserved);
      }

      if (!fit.ok) {
        // Drop oldest checkpoints first (keep diffs).
        const holders = events.map((ev, idx) => ({ ev, idx, seq: ev && ev.sequence || 0 }))
          .filter(x => x.ev && x.ev.checkpointSnapshot)
          .sort((a, b) => a.seq - b.seq);
        for (let i = 0; i < holders.length && !fit.ok; i++) {
          delete holders[i].ev.checkpointSnapshot;
          trimmedSnapshots++;
          json = pack();
          fit = jsonFitsInDoc(json, reserved);
        }
      }

      if (!fit.ok) {
        // Last resort: drop oldest entries (newest are at the front).
        while (events.length > 0 && !fit.ok) {
          events.pop();
          droppedEntries++;
          json = pack();
          fit = jsonFitsInDoc(json, reserved);
        }
      }

      return { json, fit, trimmedSnapshots, droppedEntries, compactedLegacy };
    }

    function describeLogStorage(fields, logState) {
      const total = firestoreDocumentSize(fields, getArchiveLogDocPath());
      const payloadBytes = firestoreValueSize(fields.changeLogJson || '');
      const events = (logState && logState.changeEvents) || [];
      const withLegacy = countLegacySnapshots(events);
      const checkpoints = countLogCheckpoints(events);
      const withDiffs = events.filter(ev => hasUsableDiff(ev)).length;
      const trimmed = events.filter(ev => ev && ev.snapshotsTrimmed && !hasUsableDiff(ev)).length;
      return {
        kind: 'log',
        path: getArchiveLogDocPath(),
        total,
        payloadBytes,
        otherBytes: Math.max(0, total - payloadBytes),
        percent: (total / FIRESTORE_DOC_LIMIT_BYTES) * 100,
        changeCount: events.length,
        snapshotCount: withLegacy,
        checkpointCount: checkpoints,
        diffCount: withDiffs,
        trimmedCount: trimmed,
        fields
      };
    }

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
        updatedByEmail: metaExtras.updatedByEmail != null ? metaExtras.updatedByEmail : (getActiveUserEmail() || ''),
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

    function storageTone(percent) {
      if (percent >= 90) return 'rose';
      if (percent >= 70) return 'amber';
      return 'emerald';
    }

    function paintStorageRow(prefix, estimate, opts = {}) {
      const summary = document.getElementById(`admin-storage-${prefix}-summary`);
      const bar = document.getElementById(`admin-storage-${prefix}-bar`);
      const fill = document.getElementById(`admin-storage-${prefix}-bar-fill`);
      const breakdown = document.getElementById(`admin-storage-${prefix}-breakdown`);
      if (!estimate) return 'emerald';
      const percent = Math.max(0, Number(estimate.percent) || 0);
      const shownPct = Math.min(100, Math.round(percent));
      const tone = (opts.blocked || percent >= 100) ? 'rose' : storageTone(percent);
      const label = `${formatStorageKb(estimate.total)} of 1 MB used (${Math.round(percent)}%)`;
      const toneText = tone === 'rose' ? 'text-rose-800' : tone === 'amber' ? 'text-amber-900' : 'text-slate-800';
      const toneBar = tone === 'rose' ? 'bg-rose-600' : tone === 'amber' ? 'bg-amber-500' : 'bg-emerald-600';
      if (summary) {
        summary.textContent = label;
        summary.className = `text-xs sm:text-sm font-semibold ${toneText}`;
      }
      if (bar) {
        bar.setAttribute('aria-valuenow', String(shownPct));
        bar.setAttribute('aria-valuetext', label);
      }
      if (fill) {
        const width = estimate.total > 0 ? Math.max(shownPct, 1) : 0;
        fill.style.width = `${Math.min(100, width)}%`;
        fill.className = `h-full rounded-full transition-all ${toneBar}`;
      }
      if (breakdown && estimate.kind === 'main') {
        breakdown.innerHTML = `
          <span>Tree data (payloadJson): <strong class="text-slate-800">${escapeHtml(formatStorageKb(estimate.payloadBytes))}</strong></span>
          <span class="text-slate-300 hidden sm:inline">·</span>
          <span>Access lists: <strong class="text-slate-800">${escapeHtml(formatStorageKb(estimate.accessBytes))}</strong></span>
          <span class="text-slate-300 hidden sm:inline">·</span>
          <span>Other fields: <strong class="text-slate-800">${escapeHtml(formatStorageKb(estimate.otherBytes))}</strong></span>
        `;
      }
      if (breakdown && estimate.kind === 'log') {
        const entries = estimate.changeCount === 1 ? 'entry' : 'entries';
        const checks = (estimate.checkpointCount || 0) === 1 ? 'checkpoint' : 'checkpoints';
        const legacy = estimate.snapshotCount || 0;
        const extra = [];
        extra.push(`<span><strong class="text-slate-800">${estimate.checkpointCount || 0}</strong> ${checks}</span>`);
        if ((estimate.diffCount || 0) > 0) extra.push(`<span><strong class="text-slate-800">${estimate.diffCount}</strong> compact diffs</span>`);
        if (legacy > 0) extra.push(`<span><strong class="text-slate-800">${legacy}</strong> full snapshots</span>`);
        if (estimate.trimmedCount) extra.push(`<span>${estimate.trimmedCount} unrecoverable</span>`);
        breakdown.innerHTML = `
          <span>Log data (changeLogJson): <strong class="text-slate-800">${escapeHtml(formatStorageKb(estimate.payloadBytes))}</strong></span>
          <span class="text-slate-300 hidden sm:inline">·</span>
          <span><strong class="text-slate-800">${estimate.changeCount}</strong> ${entries}</span>
          <span class="text-slate-300 hidden sm:inline">·</span>
          ${extra.join('\n          <span class="text-slate-300 hidden sm:inline">·</span>\n          ')}
        `;
      }
      return tone;
    }

    function renderStorageMeter(estimates, opts = {}) {
      const card = document.getElementById('admin-storage-card');
      if (!card) return;
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


    const APP_ERROR_LOG_KEY = 'osr_app_error_log_v1';
    const APP_ERROR_LOG_CAP = 50;

    function redactPii(text) {
      return String(text ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    }

    function classifyAppError(err, context) {
      if (context) return context;
      const code = String((err && err.code) || '');
      const msg = String((err && (err.message || err.userMessage)) || '');
      if (code === 'permission-denied' || /security rules|insufficient permissions/i.test(msg)) return 'rules';
      if (code === 'unauthenticated' || /not signed in|auth/i.test(code + ' ' + msg)) return 'auth';
      if (code === 'resource-exhausted') return 'save';
      if (/parse|GEDCOM|JSON syntax/i.test(msg) || (err && err.name === 'SyntaxError')) return 'parse';
      return 'save';
    }

    function loadAppErrorLog() {
      try {
        const raw = localStorage.getItem(APP_ERROR_LOG_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    }

    function recordAppError(err, context, extra) {
      try {
        const entry = {
          id: 'err_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          at: new Date().toISOString(),
          context: classifyAppError(err, context),
          code: redactPii((err && err.code) || ''),
          message: redactPii((err && (err.message || err.userMessage || err.text)) || String(err || 'Unknown error')),
          personId: extra && extra.personId ? String(extra.personId) : null,
          count: 1
        };
        const list = loadAppErrorLog();
        const prev = list[0];
        if (prev && prev.code === entry.code && prev.message === entry.message && prev.context === entry.context && prev.personId === entry.personId) {
          prev.count = (prev.count || 1) + 1;
          prev.at = entry.at;
        } else {
          list.unshift(entry);
        }
        if (list.length > APP_ERROR_LOG_CAP) list.length = APP_ERROR_LOG_CAP;
        localStorage.setItem(APP_ERROR_LOG_KEY, JSON.stringify(list));
        try { window.dispatchEvent(new CustomEvent('osr-app-error-log')); } catch (e2) {}
        return list[0];
      } catch (e) { return null; }
    }

    function clearAppErrorLog() {
      try { localStorage.removeItem(APP_ERROR_LOG_KEY); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('osr-app-error-log')); } catch (e2) {}
    }

    function downloadAppErrorLog() {
      const list = loadAppErrorLog();
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), errors: list }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = getArchiveId() + '-error-log.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }


    async function canUseIndexedDbCache() {
      if (typeof indexedDB === 'undefined' || !indexedDB) return false;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          const req = indexedDB.open('osr-idb-probe');
          req.onsuccess = () => {
            try { req.result.close(); indexedDB.deleteDatabase('osr-idb-probe'); } catch (e) {}
            finish(true);
          };
          req.onerror = () => finish(false);
          req.onblocked = () => finish(true);
          setTimeout(() => finish(false), 1500);
        } catch (err) {
          finish(false);
        }
      });
    }

    async function openFirestoreDatabase(app) {
      if (!app) return null;
      const tryInit = (localCache) => initializeFirestore(app, { localCache });
      if (await canUseIndexedDbCache()) {
        try {
          return tryInit(persistentLocalCache({ tabManager: persistentMultipleTabManager() }));
        } catch (err) {
          console.warn('Persistent Firestore cache unavailable, falling back to memory cache:', err);
        }
      } else {
        console.warn('IndexedDB is not available; using in-memory Firestore cache.');
      }
      try {
        return tryInit(memoryLocalCache());
      } catch (err) {
        console.warn('Memory Firestore cache could not be started, using default Firestore:', err);
        try { return getFirestore(app); } catch (err2) { throw err2; }
      }
    }

    const OFFLINE_SAVE_MESSAGE = 'You appear to be offline. Saves need a network connection because they check that nobody else has edited the tree. Your change is still on this page — reconnect and try again.';

    function isOfflineWriteError(err) {
      if (err && err.offline) return true;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
      const code = String((err && (err.code || err.name)) || '');
      const msg = String((err && (err.message || err.userMessage)) || '');
      if (/Someone else saved first|Another session saved first/i.test(msg)) return false;
      if (/client is offline|Failed to get document because the client is offline|network error|ERR_INTERNET_DISCONNECTED|Failed to fetch|the connection dropped/i.test(msg)) return true;
      if ((code === 'unavailable' || code === 'internal' || code === 'unknown') && /offline|network|internet|backend/i.test(msg)) return true;
      return false;
    }

    function formatFirestoreError(err) {
      const code = (err && (err.code || err.name)) || 'unknown';
      const message = (err && err.message) ? String(err.message) : (err ? String(err) : 'Unknown error');
      const hints = [];
      if (code === 'permission-denied') hints.push('the deployed security rules refused this write');
      if (typeof firebaseUser !== 'undefined' && firebaseUser && firebaseUser.emailVerified === false) {
        hints.push('this Google account is not marked email-verified');
      }
      if (err && err.userMessage) {
        return { code, message: String(err.userMessage), text: String(err.userMessage) };
      }
      if (isOfflineWriteError(err) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        return { code, message, text: OFFLINE_SAVE_MESSAGE, offline: true };
      }
      if (code === 'aborted' || code === 'unavailable' || code === 'deadline-exceeded') {
        const text = 'Someone else saved first, or the save could not be completed safely. Reload the page to see the latest version, then repeat your last change.';
        return { code, message, text };
      }
      const hint = hints.length ? ' (' + hints.join('; ') + ')' : '';
      try { recordAppError(err, classifyAppError(err)); } catch (eLog) {}
      return { code, message, text: 'Firestore error (' + code + '): ' + message + hint };
    }

    let testWriteImpl = null;

    function persistState(stateObj) {
      if (!firebaseUser || !firebaseUser.email || !(canEditTree())) {
        return Promise.resolve({
          ok: false,
          error: { code: 'not-authorized', message: 'You must be signed in with an account that can edit the tree to save.' }
        });
      }
      pendingSaveState = stateObj;
      saveChain = saveChain.then(runQueuedSave).catch(err => {
        console.error('Save queue error:', err);
        return { ok: false, error: err };
      });
      return saveChain;
    }

    function remoteStampIsForeign(remoteStamp, baseStamp) {
      return Boolean(baseStamp && remoteStamp && remoteStamp !== baseStamp && !ownWriteStamps.has(remoteStamp));
    }

    function remoteRevisionIsForeign(remoteRevision, baseRevision) {
      if (baseRevision == null || remoteRevision == null || remoteRevision === '') return false;
      return Number(remoteRevision) !== Number(baseRevision);
    }

    function remoteMainIsForeign(remoteMain, baseStamp, baseRevision) {
      if (!remoteMain) return false;
      return remoteStampIsForeign(remoteMain.updatedAt, baseStamp)
        || remoteRevisionIsForeign(remoteMain.revision, baseRevision);
    }

    async function writeArchiveAndLog(mainRef, logRef, mainPayload, logPayload, baseMain, baseLog, baseMainRevision) {
      // Never fall back to a blind batch write: that could overwrite someone
      // else's save. Re-read updatedAt and revision inside a transaction and
      // retry a few times if the transaction itself fails.
      const maxAttempts = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let conflict = null;
        try {
          await runTransaction(db, async (tx) => {
            conflict = null;
            const mainSnap = await tx.get(mainRef);
            const logSnap = await tx.get(logRef);
            const remoteMain = mainSnap.exists() ? (mainSnap.data() || {}) : null;
            const remoteLog = logSnap.exists() ? (logSnap.data() || {}) : null;
            if (remoteMainIsForeign(remoteMain, baseMain, baseMainRevision) ||
                (logPayload && remoteStampIsForeign(remoteLog && remoteLog.updatedAt, baseLog))) {
              conflict = { main: remoteMain, log: remoteLog };
              return;
            }
            // Same check the rules make: we must be writing stored revision + 1.
            if (remoteMain && typeof remoteMain.revision === 'number'
                && Number(mainPayload.revision) !== remoteMain.revision + 1) {
              conflict = { main: remoteMain, log: remoteLog };
              return;
            }
            tx.set(mainRef, mainPayload, { merge: true });
            if (logPayload) tx.set(logRef, logPayload, { merge: true });
          });
          return conflict;
        } catch (txErr) {
          lastErr = txErr;
          if (txErr?.code === 'permission-denied' || txErr?.code === 'unauthenticated') throw txErr;
          if (isOfflineWriteError(txErr) || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw txErr;
          if (attempt < maxAttempts) continue;
        }
      }
      const err = new Error('The save could not be completed safely. Someone else may have saved first, or the connection dropped. Reload the page and try again — your last change was not written.');
      err.code = (lastErr && lastErr.code) || 'aborted';
      err.cause = lastErr;
      err.userMessage = err.message;
      throw err;
    }

    async function runQueuedSave() {
      const hooks = treeSaveHooks();
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
        return { ok: false, stale: true, error: { code: 'aborted', message: 'Someone else saved first. Their latest version is shown — please repeat your last change.' } };
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
        updatedByEmail: getActiveUserEmail(),
        updatedByUid: firebaseUser.uid
      };
      const deferMigration = shouldDeferLogMigration();
      const split = splitStateForWrite(stateObj, { keepEmbedded: deferMigration });
      const preparedMain = prepareMainWrite(split.tree, meta);
      const preparedLog = deferMigration
        ? { ok: true, fields: null, estimate: estimateAllStorage(stateObj).log, trimmedSnapshots: 0, droppedEntries: 0 }
        : prepareLogWrite(split.log, meta);
      renderStorageMeter({ main: preparedMain.estimate, log: preparedLog.estimate }, { projected: true, blockedMain: !preparedMain.ok });
      if (!preparedMain.ok) {
        hooks.onTooLarge(preparedMain.bytes);
        return { ok: false, blocked: true, error: { code: 'resource-exhausted', message: 'The tree document (~' + formatStorageKb(preparedMain.bytes) + ') exceeds Firestore\'s 1 MB document limit.' } };
      }
      if (preparedLog.trimmedSnapshots > 0 || preparedLog.droppedEntries > 0) {
        hooks.onLogTrimmed(preparedLog.trimmedSnapshots, preparedLog.droppedEntries);
      }
      if (preparedMain.estimate.percent >= 90) hooks.onNearLimit(preparedMain.estimate, 'tree');
      else if (preparedLog.estimate.percent >= 90) hooks.onNearLimit(preparedLog.estimate, 'log');

      if (typeof testWriteImpl === 'function') {
        rememberOwnStamp(stamp);
        hooks.onSaving && hooks.onSaving();
        try {
          const result = await testWriteImpl(preparedMain.fields, deferMigration ? null : preparedLog.fields, { split, preparedMain, preparedLog, deferMigration });
          if (result && result.ok === false) return result;
          archiveBaseUpdatedAt = stamp;
          if (preparedMain.fields && preparedMain.fields.revision != null) archiveBaseRevision = preparedMain.fields.revision;
          if (!deferMigration) logBaseUpdatedAt = stamp;
          latestMainData = preparedMain.fields;
          if (!deferMigration) latestLogData = preparedLog.fields;
          hooks.onSaved && hooks.onSaved();
          return { ok: true, main: preparedMain.fields, log: deferMigration ? null : preparedLog.fields, estimate: { main: preparedMain.estimate, log: preparedLog.estimate } };
        } catch (err) {
          hooks.onError && hooks.onError(err);
          return { ok: false, error: err };
        }
      }

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
        if (syncChannel) {
          try { syncChannel.postMessage({ type: 'FIRESTORE_COMMITTED' }); } catch (e) {}
        }
        hooks.onSaved();
        return { ok: true };
      } catch (err) {
        hooks.onError(err);
        return { ok: false, error: err };
      }
    }

    function setCloudSyncIndicatorBadge(text) {
      const busy = /saving|syncing|loading/i.test(text);
      const bad = /blocked|error|restricted|too large|missing|interrupted|offline|required|init/i.test(text);
      const kind = bad ? 'offline' : busy ? 'syncing' : 'saved';
      setCloudSyncIndicator(kind, text);
    }

    function describeLogTrim(snapshots, entries) {
      const parts = [];
      if (snapshots > 0) parts.push(`snapshots from the ${snapshots} oldest change-log entr${snapshots === 1 ? 'y' : 'ies'}`);
      if (entries > 0) parts.push(`${entries} oldest change-log entr${entries === 1 ? 'y' : 'ies'}`);
      return parts.join(' and ');
    }

    function adoptRemoteState(mainData, logData) {
      const prevSelected = appState.selectedPersonId;
      applyLoadedDocuments(mainData, logData);
      if (prevSelected && appState.persons[prevSelected]) appState.selectedPersonId = prevSelected;
      undoStack = [];
      redoStack = [];
    }

    function treeSaveHooks() {
      return {
        onSaving: () => setCloudSyncIndicator('syncing', 'Saving to Firestore...'),
        onSaved: () => setCloudSyncIndicator('saved', 'Firestore Saved ✓'),
        onLogTrimmed: (snapshots, entries) => {
          showToast(`Change log near its own 1 MB limit — trimmed ${describeLogTrim(snapshots, entries)} so the tree could still be saved.`);
        },
        onTooLarge: (bytes) => {
          setCloudSyncIndicator('offline', 'Archive Too Large');
          showToast(`Not saved: the tree document (~${formatStorageKb(bytes)}) exceeds Firestore's 1 MB document limit. Remove media or notes, or ask an admin for help.`);
        },
        onNearLimit: (estimate, which) => {
          const label = which === 'log' ? 'change log' : 'tree document';
          showToast(`Warning: the ${label} is at ${Math.round(estimate.percent)}% of Firestore's 1 MB document limit.`);
        },
        onStale: () => {
          setCloudSyncIndicator('saved', 'Firestore Synced ✓');
          showToast('Someone else saved first. Their latest version is shown — please repeat your last change.');
          renderAll();
        },
        onConflict: (remoteMain, remoteLog) => {
          try { adoptRemoteState(remoteMain || latestMainData, remoteLog || latestLogData); } catch (e) { console.error('Conflict reload parse error:', e); }
          setCloudSyncIndicator('saved', 'Firestore Synced ✓');
          applyUserIdentityToTree(false);
          showToast('Someone else saved first. Their latest version is shown — please repeat your last change.');
        },
        onOffline: (err) => {
          console.warn('Firestore save skipped because this device is offline:', err);
          setCloudSyncIndicator('offline', 'Offline — save when you reconnect');
          showToast(OFFLINE_SAVE_MESSAGE);
        },
        onError: (err) => {
          console.error('Firestore save error:', err);
          const formatted = formatFirestoreError(err);
          if (formatted.offline) setCloudSyncIndicator('offline', 'Offline — save when you reconnect');
          else setCloudSyncIndicator('offline', 'Firestore Write Blocked');
          showToast(formatted.text);
        }
      };
    }

    async function initFirebaseAndPersistence() {
      const config = await resolveFirebaseConfig();
      if (!config) {
        authStateResolved = true;
        setCloudSyncIndicator('offline', 'Firebase Config Missing');
        renderAll();
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
            sessionAuth = { email: '', displayName: '', photoURL: '', isAuthenticated: false };
            appState = normalizeAppState(createBlankDataset());
            undoStack = [];
            redoStack = [];
            purgeLocalCachedRecords();
            stopDocListeners();
            closeInspector();
            setCloudSyncIndicator('offline', 'Sign In Required');
            renderAll();
            return;
          }

          const signedEmail = user.email.trim().toLowerCase();
          sessionAuth = {
            email: signedEmail,
            displayName: user.displayName || signedEmail.split('@')[0],
            photoURL: user.photoURL || '',
            isAuthenticated: true
          };

          const docRef = getArchiveDocRef();
          const logRef = getLogDocRef();
          setCloudSyncIndicator('syncing', 'Loading Firestore...');

          try {
            const [initialSnap, logSnap] = await Promise.all([getDoc(docRef), getDoc(logRef)]);
            if (myGeneration !== authGeneration) return; // account changed while loading
            if (!initialSnap.exists()) {
              const expected = getConfiguredSuperAdminEmail();
              if (expected && signedEmail !== expected) {
                firestoreAccessDenied = true;
                appState = normalizeAppState(createBlankDataset());
                setCloudSyncIndicator('offline', 'Sign In Required');
                showToast('This archive has not been created yet. Sign in as the Super Admin to set it up.');
                renderAll();
                return;
              }
              const fresh = createBlankDataset();
              fresh.superAdminEmail = expected || signedEmail;
              syncTreeEmailsWithPermissions(fresh);
              appState = normalizeAppState(fresh);
              await persistState(appState);
              if (myGeneration !== authGeneration) return;
              showToast(`Initialized ${getSiteTitle()} in Firestore (Super Admin: ${fresh.superAdminEmail})`);
            } else {
              applyLoadedDocuments(initialSnap.data(), logSnap.exists() ? logSnap.data() : null);
              undoStack = [];
              redoStack = [];
              if (pendingLogMigration && isSuperAdminEmail(signedEmail)) {
                showToast('The change log is still in the tree document. Open migrate-log.html to download a backup and move it; regular saves will not move it automatically.');
              }
            }
          } catch (readErr) {
            if (myGeneration !== authGeneration) return;
            if (readErr?.code === 'permission-denied') {
              firestoreAccessDenied = true;
              appState = normalizeAppState(createBlankDataset());
              purgeLocalCachedRecords();
              setCloudSyncIndicator('offline', 'Access Restricted');
              renderAll();
              return;
            }
            console.error('Initial Firestore read error:', readErr);
          }

          stopDocListeners();
          const onDenied = (err, label) => {
            if (myGeneration !== authGeneration) return;
            if (err?.code === 'permission-denied') {
              firestoreAccessDenied = true;
              appState = normalizeAppState(createBlankDataset());
              purgeLocalCachedRecords();
              setCloudSyncIndicator('offline', 'Access Restricted');
              renderAll();
            } else {
              console.error(label, err);
              setCloudSyncIndicator('offline', 'Sync Interrupted');
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
                setCloudSyncIndicator('saved', 'Firestore Synced ✓');
                return;
              }
              if (data.updatedAt && data.updatedAt === archiveBaseUpdatedAt && !wasDenied) {
                latestMainData = data;
                setCloudSyncIndicator('saved', 'Firestore Synced ✓');
                return;
              }
              try {
                adoptRemoteState(data, latestLogData);
                applyUserIdentityToTree(false);
                setCloudSyncIndicator('saved', 'Firestore Synced ✓');
              } catch (parseErr) {
                console.error('Archive parse error:', parseErr);
              }
            },
            (err) => onDenied(err, 'Firestore onSnapshot error:')
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
                adoptRemoteState(latestMainData, data);
                applyUserIdentityToTree(false);
                setCloudSyncIndicator('saved', 'Firestore Synced ✓');
              } catch (parseErr) {
                console.error('Change log snapshot parse error:', parseErr);
              }
            },
            (err) => onDenied(err, 'Change log onSnapshot error:')
          );

          applyUserIdentityToTree(true);
        });

        // Race authStateReady against a 2.5s ceiling so embedded iframes never hang
        await Promise.race([
          auth.authStateReady(),
          new Promise(resolve => setTimeout(resolve, 2500))
        ]);
        authStateResolved = true;
        renderAll();
      } catch (err) {
        authStateResolved = true;
        console.error('Firebase initialization failed:', err);
        setCloudSyncIndicator('offline', 'Firebase Init Error');
        renderAll();
      }
    }

    function applyUserIdentityToTree(shouldCenter = true) {
      if (!isAuthorizedViewer()) {
        appState = normalizeAppState(createBlankDataset());
        renderAll();
        return;
      }
      const cid = resolveCentralPersonIdForUser();
      const matchedPerson = findPersonByEmailInState(appState, getActiveUserEmail());
      if (matchedPerson && !sessionAuth.displayName) {
        sessionAuth.displayName = getDisplayName(matchedPerson, true);
      }
      if (cid && appState.persons[cid]) {
        appState.centralPersonId = cid;
        if (!appState.selectedPersonId || !appState.persons[appState.selectedPersonId]) {
          appState.selectedPersonId = cid;
        }
      }
      renderAll();
      if (shouldCenter && cid) {
        requestAnimationFrame(() => centerOnPerson(cid, true));
      }
    }

    async function signInWithGooglePopup(forceSelectAccount = false) {
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
        document.getElementById('modal-google-auth').classList.add('hidden');
      } catch (err) {
        console.warn('Google popup sign-in error:', err?.code || err);
        if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
          showToast('Popup blocked — use Full-Page Google Redirect Sign-In or open in a full tab.');
        } else if (err?.code !== 'auth/popup-closed-by-user') {
          showToast(`Google Sign-In failed: ${err?.message || err?.code}`);
        }
      }
    }

    async function signInWithGoogleRedirectFlow() {
      if (!auth) return;
      try {
        const provider = new GoogleAuthProvider();
        await signInWithRedirect(auth, provider);
      } catch (err) {
        showToast(`Redirect Sign-In failed: ${err?.message || err?.code}`);
      }
    }

    async function signOutGoogleUser() {
      pendingSaveState = null;
      undoStack = [];
      redoStack = [];
      uiState.highlightedKinship = null;
      closeInspector();
      appState = normalizeAppState(createBlankDataset());
      purgeLocalCachedRecords();
      if (auth) {
        try {
          await signOut(auth);
        } catch (err) {}
      }
      if (authChannel) {
        try { authChannel.postMessage({ type: 'AUTH_UPDATED' }); } catch (e) {}
      }
      document.getElementById('modal-google-auth').classList.add('hidden');
      renderAll();
      showToast('Signed out of Google Account');
    }

    /* =====================================================================
     * 5. MUTATIONS, UNDO/REDO, CHANGE LOG RESET & DELETE ALL ARCHIVE
     * ===================================================================== */
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

    function logChangeEvent(summary, category, beforeSnap, afterSnap) {
      const role = getEffectiveSessionRole();
      const actorStr = role === 'super_admin'
        ? `Super Admin (${getActiveUserEmail()})`
        : role === 'admin'
          ? `Admin (${getActiveUserEmail()})`
          : `Editor (${getActiveUserEmail() || 'User'})`;
      appendChangeLogEntry(appState, summary, category, beforeSnap, afterSnap, actorStr);
    }

    function commitMutation(summary, mutatorFn, category = 'Tree Data') {
      if (!canEditTree()) {
        showToast('View Access Only: Sign in with an Editor Google account to edit.');
        return false;
      }
      const beforeSnap = captureDomainSnapshot(appState);
      try {
        mutatorFn(appState);
      } catch (mutErr) {
        console.error('Edit failed, restoring previous state:', mutErr);
        restoreDomainSnapshot(beforeSnap);
        renderAll();
        showToast('That edit could not be applied.');
        return false;
      }
      undoStack.push(beforeSnap);
      if (undoStack.length > 35) undoStack.shift();
      redoStack = [];
      syncTreeEmailsWithPermissions(appState);
      appState.tree.revision = (appState.tree.revision || 1) + 1;

      const afterSnap = captureDomainSnapshot(appState);
      logChangeEvent(summary, category, beforeSnap, afterSnap);
      persistState(appState);
      renderAll();
      showToast(summary);
      return true;
    }

    // Restores people/families/permissions/title from a snapshot onto the CURRENT state,
    // keeping the change log, audit log and session fields intact.
    function restoreDomainSnapshot(snap) {
      if (!snap) return;
      appState.tree = deepClone(snap.tree || appState.tree);
      appState.persons = deepClone(snap.persons || {});
      appState.families = deepClone(snap.families || {});
      appState.accessControl = appState.accessControl || { activeSessionRole: 'guest', permissions: [], auditLog: [] };
      appState.accessControl.permissions = deepClone(snap.accessControl?.permissions || []);
      normalizeAppState(appState);
      if (!appState.persons[appState.selectedPersonId]) {
        appState.selectedPersonId = resolveCentralPersonIdForUser();
      }
    }

    function undo() {
      if (!canEditTree() || undoStack.length === 0) return;
      const beforeSnap = captureDomainSnapshot(appState);
      redoStack.push(beforeSnap);
      const prev = undoStack.pop();
      restoreDomainSnapshot(prev);
      const afterSnap = captureDomainSnapshot(appState);
      logChangeEvent('Undo previous tree edit', 'Tree Data', beforeSnap, afterSnap);
      persistState(appState);
      renderAll();
      showToast('Undid last change');
    }

    function redo() {
      if (!canEditTree() || redoStack.length === 0) return;
      const beforeSnap = captureDomainSnapshot(appState);
      undoStack.push(beforeSnap);
      const next = redoStack.pop();
      restoreDomainSnapshot(next);
      const afterSnap = captureDomainSnapshot(appState);
      logChangeEvent('Redo tree edit', 'Tree Data', beforeSnap, afterSnap);
      persistState(appState);
      renderAll();
      showToast('Redid change');
    }

    /* =====================================================================
     * 6. DISPLAY, PRIVACY & RELATIONSHIP HELPERS
     * ===================================================================== */
    function isDeceased(person) {
      return Boolean(person && person.livingStatus === 'deceased');
    }

    function getDeathYear(person) {
      if (!person) return '';
      const deat = (person.events || []).find(e => e && e.type === 'DEAT');
      return deat ? extractYearLabel(deat.date) : '';
    }

    function getDeceasedLabel(person) {
      if (!isDeceased(person)) return '';
      const year = getDeathYear(person);
      return year ? `Deceased ${year}` : 'Deceased';
    }

    function deceasedCornerHtml(person) {
      const label = getDeceasedLabel(person);
      if (!label) return '';
      return `<span class="deceased-corner" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"></span>`;
    }

    function getDisplayName(person) {
      if (!person) return 'Unknown';
      const full = `${person.given || ''} ${person.surname || ''}`.trim();
      return full || 'Unnamed Individual';
    }

    function getDisplayNameWithMaiden(person) {
      const base = getDisplayName(person);
      if (!person) return base;
      if (person.altName) {
        const altClean = person.altName.trim();
        if (altClean.toLowerCase().startsWith('born ')) {
          return `${base} (${altClean})`;
        }
        return `${base} (born ${altClean})`;
      }
      return base;
    }

    function getVitalSummary(person) {
      if (!person) return '';
      const birt = (person.events || []).find(e => e.type === 'BIRT');
      const deat = (person.events || []).find(e => e.type === 'DEAT');
      const parts = [];
      if (birt && birt.date) parts.push(`b. ${birt.date}${birt.place ? ' · ' + birt.place : ''}`);
      if (deat && deat.date) parts.push(`d. ${deat.date}`);
      return parts.join(' | ') || 'Dates unrecorded';
    }

    function getHeaderVitalLine(person) {
      if (!person) return 'Vital details unrecorded';

      const birt = (person.events || []).find(e => e.type === 'BIRT');
      const deat = (person.events || []).find(e => e.type === 'DEAT');

      if (birt && (birt.date || birt.place)) {
        const formattedBirth = birt.date ? formatDisplayDate(birt.date, 'long') : '';
        let ageBadge = '';
        if (birt.date) {
          if (deat && deat.date) {
            const aged = computeAgeYears(birt.date, deat.date);
            if (aged !== null) ageBadge = ` (aged ${aged})`;
          } else if (person.livingStatus === 'living') {
            const ageNow = computeAgeYears(birt.date, null);
            if (ageNow !== null) ageBadge = ` (age ${ageNow})`;
          }
        }
        const segments = [];
        if (formattedBirth) segments.push(`${formattedBirth}${ageBadge}`);
        if (birt.place) segments.push(birt.place);
        return segments.join(' • ');
      }

      if (deat && (deat.date || deat.place)) {
        const dFmt = deat.date ? `Died ${formatDisplayDate(deat.date, 'long')}` : 'Deceased';
        return deat.place ? `${dFmt} • ${deat.place}` : dFmt;
      }

      return 'Vital details unrecorded';
    }

    function getSilhouetteSvgInner(sex) {
      if (sex === 'F') {
        return `<path d="M12 4a3.8 3.8 0 00-3.8 3.8c0 1.4.75 2.62 1.87 3.28-.82.42-1.62 1.04-2.22 1.82-.95 1.24-1.35 2.82-1.35 4.35V19h11v-1.75c0-1.53-.4-3.11-1.35-4.35-.6-.78-1.4-1.4-2.22-1.82A3.79 3.79 0 0015.8 7.8 3.8 3.8 0 0012 4z" />`;
      }
      return `<path d="M12 4a3.75 3.75 0 100 7.5A3.75 3.75 0 0012 4zm0 9c-3.34 0-6.5 1.68-6.5 4.5V19h13v-1.5c0-2.82-3.16-4.5-6.5-4.5z" />`;
    }

    function getCardLifespanLabel(person) {
      if (!person) return '';
      const birt = (person.events || []).find(e => e.type === 'BIRT');
      const deat = (person.events || []).find(e => e.type === 'DEAT');
      const bYear = birt ? extractYearLabel(birt.date) : '';
      const dYear = deat ? extractYearLabel(deat.date) : '';
      if (bYear && dYear) return `${bYear} – ${dYear}`;
      if (bYear) return bYear;
      if (dYear) return `? – ${dYear}`;
      return '';
    }

    // personId -> family indexes (in original order) where they are a partner / a child.
    function buildFamilyIndex(families) {
      const asPartner = new Map();
      const asChild = new Map();
      const add = (map, key, idx) => {
        if (!key) return;
        let list = map.get(key);
        if (!list) { list = []; map.set(key, list); }
        if (list[list.length - 1] !== idx) list.push(idx);
      };
      families.forEach((f, idx) => {
        if (!f) return;
        add(asPartner, f.partner1Id, idx);
        add(asPartner, f.partner2Id, idx);
        (f.children || []).forEach(c => add(asChild, c && c.personId, idx));
      });
      return { asPartner, asChild };
    }

    // Sorted union of two ascending index lists (keeps the original family iteration order).
    function mergeFamilyIndexLists(a, b) {
      a = a || [];
      b = b || [];
      const out = [];
      let i = 0, j = 0;
      while (i < a.length || j < b.length) {
        const next = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
        if (out[out.length - 1] !== next) out.push(next);
      }
      return out;
    }

    function wouldCreateAncestorCycle(candidateParentId, candidateChildId) {
      if (!candidateParentId || !candidateChildId) return false;
      if (candidateParentId === candidateChildId) return true;
      const visited = new Set([candidateChildId]);
      const queue = [candidateChildId];
      const famList = Object.values(appState.families);
      const famIndex = buildFamilyIndex(famList);
      while (queue.length > 0) {
        const curr = queue.shift();
        (famIndex.asPartner.get(curr) || []).map(i => famList[i]).forEach(f => {
          if (f.partner1Id === curr || f.partner2Id === curr) {
            (f.children || []).forEach(c => {
              if (c.personId && !visited.has(c.personId)) {
                visited.add(c.personId);
                queue.push(c.personId);
              }
            });
          }
        });
      }
      return visited.has(candidateParentId);
    }

    /* =====================================================================
     * 7. SIBLING-PRESERVING, MULTI-SPOUSE LAYERED GENERATIONAL LAYOUT ENGINE
     * ===================================================================== */
    const CARD_W = 140;
    const CARD_H = 144;
    const PARTNER_GAP = 44;
    const MIN_UNIT_GAP = 44;
    const LAYER_HEIGHT = 228;
    const TOP_OFFSET = 42;
    const LEFT_SWIMLANE_MARGIN = 172;

    function getFocusPersonId() {
      if (uiState.focusPersonId && appState.persons[uiState.focusPersonId]) return uiState.focusPersonId;
      return resolveCentralPersonIdForUser() || Object.keys(appState.persons)[0] || null;
    }

    function isFocusViewActive() {
      return Boolean(uiState.focusMode && uiState.viewMode === 'canvas');
    }

    // Accordion view: the focused person's ancestors (with each ancestor couple's
    // children shown as closed branches), the focused person's spouses and all of
    // their descendants. Everyone else stays folded until their branch is opened.
    function computeFocusPersonSet(focusId) {
      const persons = appState.persons;
      const partnerFams = {};
      const childFams = {};
      Object.values(appState.families).forEach(f => {
        [f.partner1Id, f.partner2Id].forEach(pid => {
          if (pid) (partnerFams[pid] = partnerFams[pid] || []).push(f);
        });
        (f.children || []).forEach(c => {
          if (c && c.personId) (childFams[c.personId] = childFams[c.personId] || []).push(f);
        });
      });
      const show = new Set();
      if (!focusId || !persons[focusId]) return show;

      const lineage = new Set([focusId]);
      const up = [focusId];
      while (up.length) {
        const cur = up.shift();
        (childFams[cur] || []).forEach(f => {
          [f.partner1Id, f.partner2Id].forEach(pid => {
            if (pid && persons[pid] && !lineage.has(pid)) { lineage.add(pid); up.push(pid); }
          });
        });
      }
      lineage.forEach(id => {
        show.add(id);
        if (id === focusId) return;
        (partnerFams[id] || []).forEach(f => {
          if (!(f.children || []).some(c => lineage.has(c.personId))) return; // other marriages stay folded
          [f.partner1Id, f.partner2Id].forEach(pid => { if (pid && persons[pid]) show.add(pid); });
          (f.children || []).forEach(c => { if (persons[c.personId]) show.add(c.personId); });
        });
      });

      const down = [focusId];
      const seen = new Set([focusId]);
      while (down.length) {
        const cur = down.shift();
        (partnerFams[cur] || []).forEach(f => {
          [f.partner1Id, f.partner2Id].forEach(pid => { if (pid && persons[pid]) show.add(pid); });
          (f.children || []).forEach(c => {
            const k = c.personId;
            if (k && persons[k] && !seen.has(k)) { seen.add(k); show.add(k); down.push(k); }
          });
        });
      }
      return show;
    }

    function getVisiblePersonIdsForLayout() {
      const base = getBaseVisiblePersonIds();
      if (!isFocusViewActive()) return base;
      const focusSet = computeFocusPersonSet(getFocusPersonId());
      const out = new Set();
      base.forEach(id => { if (focusSet.has(id)) out.add(id); });
      // A highlighted kinship path is always shown in full.
      (uiState.highlightedKinship?.pathIds || []).forEach(id => { if (appState.persons[id]) out.add(id); });
      if (out.size === 0) base.forEach(id => out.add(id));
      return out;
    }

    function getBaseVisiblePersonIds() {
      const allIds = Object.keys(appState.persons);
      if (allIds.length === 0) return new Set();

      const families = Object.values(appState.families);
      const famIndex = buildFamilyIndex(families);
      const famsOf = (pid) => mergeFamilyIndexLists(famIndex.asPartner.get(pid), famIndex.asChild.get(pid)).map(i => families[i]);
      const hiddenByCollapse = new Set();

      uiState.collapsedAncestorIds.forEach(anchorId => {
        if (!appState.persons[anchorId]) return;
        const queue = [anchorId];
        const seen = new Set([anchorId]);
        while (queue.length > 0) {
          const curr = queue.shift();
          (famIndex.asChild.get(curr) || []).map(i => families[i]).forEach(f => {
            if ((f.children || []).some(c => c.personId === curr)) {
              [f.partner1Id, f.partner2Id].forEach(pid => {
                if (pid && appState.persons[pid] && !seen.has(pid)) {
                  seen.add(pid);
                  hiddenByCollapse.add(pid);
                  queue.push(pid);
                }
              });
            }
          });
        }
      });

      // In focus view the generation depth is measured from the focused person.
      const centralId = (isFocusViewActive() ? getFocusPersonId() : resolveCentralPersonIdForUser()) || allIds[0];

      if (uiState.generationDepth >= 5) {
        return new Set(allIds.filter(id => !hiddenByCollapse.has(id)));
      }

      const relDist = { [centralId]: 0 };
      const queue = [centralId];
      while (queue.length > 0) {
        const curr = queue.shift();
        const d = relDist[curr];
        famsOf(curr).forEach(f => {
          if (f.partner1Id === curr && f.partner2Id && relDist[f.partner2Id] === undefined) {
            relDist[f.partner2Id] = d;
            queue.push(f.partner2Id);
          }
          if (f.partner2Id === curr && f.partner1Id && relDist[f.partner1Id] === undefined) {
            relDist[f.partner1Id] = d;
            queue.push(f.partner1Id);
          }
          if ((f.children || []).some(c => c.personId === curr)) {
            [f.partner1Id, f.partner2Id].forEach(pid => {
              if (pid && relDist[pid] === undefined) {
                relDist[pid] = d - 1;
                queue.push(pid);
              }
            });
          }
          if (f.partner1Id === curr || f.partner2Id === curr) {
            (f.children || []).forEach(c => {
              if (c.personId && relDist[c.personId] === undefined) {
                relDist[c.personId] = d + 1;
                queue.push(c.personId);
              }
            });
          }
        });
      }

      const visible = new Set();
      allIds.forEach(id => {
        if (hiddenByCollapse.has(id)) return;
        const dist = relDist[id];
        if (dist === undefined || Math.abs(dist) <= uiState.generationDepth) {
          visible.add(id);
        }
      });
      return visible;
    }

    // Layout depends only on ids, family structure and view options, so re-use it
    // across the several renders that happen for one interaction.
    let layoutCache = { key: null, value: null };
    function computeTreeLayout() {
      const depth = uiState.generationDepth;
      const key = [
        depth,
        Array.from(uiState.collapsedAncestorIds || []).sort().join(','),
        depth < 5 ? (resolveCentralPersonIdForUser() || '') : '',
        isFocusViewActive() ? `focus:${getFocusPersonId() || ''}` : 'full',
        (uiState.highlightedKinship?.pathIds || []).join(','),
        Object.keys(appState.persons).join(','),
        JSON.stringify(appState.families)
      ].join('|');
      if (layoutCache.key === key && layoutCache.value) return layoutCache.value;
      const value = computeTreeLayoutUncached();
      layoutCache = { key, value };
      return value;
    }

    function computeTreeLayoutUncached() {
      const visibleSet = getVisiblePersonIdsForLayout();
      const persons = {};
      visibleSet.forEach(id => {
        if (appState.persons[id]) persons[id] = appState.persons[id];
      });

      const allFamilies = Object.values(appState.families);
      const families = allFamilies.filter(f =>
        (f.partner1Id && persons[f.partner1Id]) || (f.partner2Id && persons[f.partner2Id])
      );
      const personIds = Object.keys(persons);

      const hasAnyParentInFullTree = {};
      const hasHiddenParentBranch = {};
      // People with relatives (parents, partners or children) folded out of view.
      const hasHiddenRelatives = {};
      allFamilies.forEach(f => {
        const partners = [f.partner1Id, f.partner2Id].filter(pid => pid && appState.persons[pid]);
        const kids = (f.children || []).map(c => c.personId).filter(k => k && appState.persons[k]);
        const hiddenPartner = partners.some(pid => !visibleSet.has(pid));
        const hiddenKid = kids.some(k => !visibleSet.has(k));
        partners.forEach(pid => {
          if (visibleSet.has(pid) && (hiddenKid || hiddenPartner)) hasHiddenRelatives[pid] = true;
        });
        if (hiddenPartner) kids.forEach(k => { if (visibleSet.has(k)) hasHiddenRelatives[k] = true; });
      });
      allFamilies.forEach(f => {
        const parents = [f.partner1Id, f.partner2Id].filter(pid => pid && appState.persons[pid]);
        if (parents.length === 0) return;
        (f.children || []).forEach(ch => {
          if (!persons[ch.personId]) return;
          hasAnyParentInFullTree[ch.personId] = true;
          if (parents.some(pid => !visibleSet.has(pid))) {
            hasHiddenParentBranch[ch.personId] = true;
          }
        });
      });

      if (personIds.length === 0) {
        return {
          nodes: {},
          unitsByGen: {},
          familyGutterMap: {},
          hasAnyParentInFullTree,
          hasHiddenParentBranch,
          hasHiddenRelatives,
          maxGen: 0,
          generations: {},
          bounds: { minX: 0, minY: 0, maxX: 960, maxY: 480 }
        };
      }

      const gen = {};
      personIds.forEach(id => { gen[id] = 0; });

      for (let iter = 0; iter < personIds.length * 2 + 8; iter++) {
        let changed = false;
        families.forEach(fam => {
          const p1 = fam.partner1Id && persons[fam.partner1Id] ? fam.partner1Id : null;
          const p2 = fam.partner2Id && persons[fam.partner2Id] ? fam.partner2Id : null;
          let parentGen = 0;
          if (p1 && p2) {
            parentGen = Math.max(gen[p1], gen[p2]);
            if (gen[p1] !== parentGen) { gen[p1] = parentGen; changed = true; }
            if (gen[p2] !== parentGen) { gen[p2] = parentGen; changed = true; }
          } else if (p1) {
            parentGen = gen[p1];
          } else if (p2) {
            parentGen = gen[p2];
          }

          (fam.children || []).forEach(ch => {
            if (persons[ch.personId] && gen[ch.personId] < parentGen + 1) {
              gen[ch.personId] = parentGen + 1;
              changed = true;
            }
          });
        });
        // Pull parents down to sit directly above their nearest child (e.g. a spouse's
        // parents added later would otherwise float in the top generation).
        families.forEach(fam => {
          let minChild = Infinity;
          (fam.children || []).forEach(ch => {
            if (persons[ch.personId] && gen[ch.personId] < minChild) minChild = gen[ch.personId];
          });
          if (minChild === Infinity) return;
          [fam.partner1Id, fam.partner2Id].forEach(pid => {
            if (pid && persons[pid] && gen[pid] < minChild - 1) {
              gen[pid] = minChild - 1;
              changed = true;
            }
          });
        });
        if (!changed) break;
      }

      const minG = Object.values(gen).reduce((m, v) => (v < m ? v : m), Infinity);
      let maxGen = 0;
      personIds.forEach(id => {
        gen[id] = gen[id] - minG;
        if (gen[id] > maxGen) maxGen = gen[id];
      });

      const childPrimaryFamMap = {};
      const childSiblingIndexMap = {};
      families.forEach((fam, fIdx) => {
        (fam.children || []).forEach((ch, cIdx) => {
          if (!persons[ch.personId]) return;
          if (!childPrimaryFamMap[ch.personId] || ch.linkage === 'biological') {
            childPrimaryFamMap[ch.personId] = { fam, fIdx };
            childSiblingIndexMap[ch.personId] = cIdx;
          }
        });
      });

      /* ---------------------------------------------------------------
       * Family-group ("tidy tree") placement.
       * 1. Spouses in the same generation form one horizontal unit
       *    (a person with several marriages sits between their spouses).
       * 2. Every unit is claimed by exactly one parent unit (the parents of
       *    its first blood member), so each sibling group is laid out as one
       *    block directly beneath its parents' union.
       * 3. Subtrees are packed left-to-right using per-generation contours,
       *    so sibling groups never overlap and stay compact.
       * 4. Unclaimed units (top ancestors, in-law parents) are placed next to
       *    the relatives they connect to, keeping cross-links short.
       * --------------------------------------------------------------- */
      const UNIT_STEP = CARD_W + PARTNER_GAP;
      const FAMILY_GROUP_GAP = MIN_UNIT_GAP + 24;
      const TREE_GAP = MIN_UNIT_GAP * 2;
      const unitsByGen = {};
      const personToUnit = {};
      const allUnits = [];
      const famOrder = new Map(families.map((f, i) => [f, i]));

      const spouseAdj = {};
      const pairFamIdx = {};
      families.forEach((f, i) => {
        const a = f.partner1Id, b = f.partner2Id;
        if (!a || !b || a === b || !persons[a] || !persons[b] || gen[a] !== gen[b]) return;
        spouseAdj[a] = spouseAdj[a] || [];
        spouseAdj[b] = spouseAdj[b] || [];
        if (!spouseAdj[a].includes(b)) spouseAdj[a].push(b);
        if (!spouseAdj[b].includes(a)) spouseAdj[b].push(a);
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (pairFamIdx[key] === undefined) pairFamIdx[key] = { idx: i, p1: a };
      });
      const pairInfo = (a, b) => pairFamIdx[a < b ? `${a}|${b}` : `${b}|${a}`] || { idx: 999999, p1: a };
      const famsByPartner = {};
      families.forEach(f => {
        [f.partner1Id, f.partner2Id].forEach(pid => {
          if (!pid || !persons[pid]) return;
          famsByPartner[pid] = famsByPartner[pid] || [];
          if (!famsByPartner[pid].includes(f)) famsByPartner[pid].push(f);
        });
      });

      const orderChain = (comp) => {
        if (comp.length === 1) return comp.slice();
        const deg = id => (spouseAdj[id] || []).length;
        const edgeCount = comp.reduce((s, id) => s + deg(id), 0) / 2;
        const isPath = edgeCount === comp.length - 1 && comp.every(id => deg(id) <= 2);
        if (isPath) {
          // Start from the end whose marriage is listed first; partner1 on the left for a couple.
          const ends = comp.filter(id => deg(id) === 1);
          ends.sort((x, y) => {
            const ix = pairInfo(x, spouseAdj[x][0]);
            const iy = pairInfo(y, spouseAdj[y][0]);
            if (ix.idx !== iy.idx) return ix.idx - iy.idx;
            return (ix.p1 === x ? 0 : 1) - (iy.p1 === y ? 0 : 1);
          });
          const out = [ends[0] || comp[0]];
          const seen = new Set(out);
          let cur = out[0];
          for (;;) {
            const nxt = (spouseAdj[cur] || []).find(n => !seen.has(n));
            if (!nxt) break;
            out.push(nxt);
            seen.add(nxt);
            cur = nxt;
          }
          comp.forEach(id => { if (!seen.has(id)) out.push(id); });
          return out;
        }
        const hub = comp.slice().sort((x, y) => deg(y) - deg(x))[0];
        const nbs = spouseAdj[hub].slice().sort((x, y) => pairInfo(hub, x).idx - pairInfo(hub, y).idx);
        const out = [nbs[0], hub, ...nbs.slice(1)];
        comp.forEach(id => { if (!out.includes(id)) out.push(id); });
        return out;
      };

      for (let g = 0; g <= maxGen; g++) {
        const genIds = personIds.filter(id => gen[id] === g);
        const visited = new Set();
        const units = [];
        genIds.forEach(startId => {
          if (visited.has(startId)) return;
          const comp = [];
          const q = [startId];
          visited.add(startId);
          while (q.length) {
            const cur = q.shift();
            comp.push(cur);
            (spouseAdj[cur] || []).forEach(n => {
              if (!visited.has(n) && gen[n] === g) { visited.add(n); q.push(n); }
            });
          }
          const chain = orderChain(comp);
          const famSet = new Set();
          chain.forEach(pid => (famsByPartner[pid] || []).forEach(f => famSet.add(f)));
          const ownW = chain.length * CARD_W + Math.max(0, chain.length - 1) * PARTNER_GAP;
          const u = {
            id: `unit_${chain.join('_')}`,
            members: chain,
            famIds: Array.from(famSet).sort((a, b) => famOrder.get(a) - famOrder.get(b)).map(f => f.id),
            ownWidth: ownW,
            subtreeWidth: ownW,
            gen: g,
            order: allUnits.length
          };
          units.push(u);
          allUnits.push(u);
          chain.forEach(mid => { personToUnit[mid] = u; });
        });
        unitsByGen[g] = units;
      }

      // Union centre of a family relative to its unit's left edge.
      const unionRelX = (u, fam) => {
        const idxs = [u.members.indexOf(fam.partner1Id), u.members.indexOf(fam.partner2Id)].filter(i => i >= 0);
        if (idxs.length === 0) return u.ownWidth / 2;
        return (idxs.reduce((s, i) => s + i, 0) / idxs.length) * UNIT_STEP + CARD_W / 2;
      };

      // Claim each unit for one parent unit (blood line = member with most marriages, then left-most).
      const claimedKids = new Map();
      const claimedBy = new Map();
      allUnits.forEach(cu => {
        if (cu.gen === 0) return;
        const candidates = cu.members.slice().sort((a, b) =>
          (spouseAdj[b] || []).length - (spouseAdj[a] || []).length || cu.members.indexOf(a) - cu.members.indexOf(b));
        for (const pid of candidates) {
          const info = childPrimaryFamMap[pid];
          if (!info) continue;
          const fam = info.fam;
          const parentPid = [fam.partner1Id, fam.partner2Id].find(x => x && persons[x] && gen[x] === cu.gen - 1);
          if (!parentPid) continue;
          const pu = personToUnit[parentPid];
          if (!pu || pu === cu) continue;
          if (!claimedKids.has(pu)) claimedKids.set(pu, []);
          claimedKids.get(pu).push({
            unit: cu,
            fam,
            pid,
            famPos: unionRelX(pu, fam),
            famIdx: info.fIdx,
            sib: childSiblingIndexMap[pid] ?? 999999
          });
          claimedBy.set(cu, { unit: pu, fam, pid });
          // Does this child's spouse come from another visible family? Those siblings go to the
          // right end of their sibling group so the in-law family can sit right next to them.
          const list = claimedKids.get(pu);
          list[list.length - 1].inLaw = cu.members.some(m => {
            if (m === pid) return false;
            const mi = childPrimaryFamMap[m];
            if (!mi) return false;
            const mp = [mi.fam.partner1Id, mi.fam.partner2Id].find(x => x && persons[x] && personToUnit[x]);
            return Boolean(mp && personToUnit[mp] !== pu);
          }) ? 1 : 0;
          break;
        }
      });
      claimedKids.forEach(list => list.sort((a, b) =>
        a.famPos - b.famPos || a.famIdx - b.famIdx || a.inLaw - b.inLaw || a.sib - b.sib || a.unit.order - b.unit.order));

      // Returns { contour: Map(gen -> [minX, maxX]), placements: [{unit, x}] } relative to u's left edge = 0.
      function layoutSubtree(u) {
        const kids = claimedKids.get(u) || [];
        const contour = new Map([[u.gen, [0, u.ownWidth]]]);
        if (kids.length === 0) return { contour, placements: [{ unit: u, x: 0 }] };

        // 1) Pack the children's subtrees left-to-right as tightly as their contours allow.
        const accContour = new Map();
        const packed = []; // { k, sub, shift, group }
        const groups = []; // one per family: { fam, famPos, start, centers: [] }
        kids.forEach(k => {
          const sub = layoutSubtree(k.unit);
          const prev = packed[packed.length - 1];
          const newGroup = !prev || prev.k.fam !== k.fam;
          let shift = 0;
          if (prev) {
            const gap = newGroup ? FAMILY_GROUP_GAP : MIN_UNIT_GAP;
            shift = -Infinity;
            sub.contour.forEach(([mn], g) => {
              const r = accContour.get(g);
              if (r) shift = Math.max(shift, r[1] + gap - mn);
            });
            if (shift === -Infinity) shift = prev.shift + prev.k.unit.ownWidth + gap;
          }
          if (newGroup) groups.push({ fam: k.fam, famPos: k.famPos, start: shift, centers: [], weight: 0 });
          const grp = groups[groups.length - 1];
          grp.centers.push(shift + k.unit.members.indexOf(k.pid) * UNIT_STEP + CARD_W / 2);
          grp.weight++;
          packed.push({ k, sub, shift, group: groups.length - 1 });
          sub.contour.forEach(([mn, mx], g) => {
            const r = accContour.get(g);
            accContour.set(g, r ? [Math.min(r[0], mn + shift), Math.max(r[1], mx + shift)] : [mn + shift, mx + shift]);
          });
        });

        // 2) Slide each family's sibling block toward its own union (parents' marriage point),
        //    never closer to the previous block than packing allowed (isotonic regression / PAV).
        const targets = groups.map(gp => {
          const mid = (Math.min(...gp.centers) + Math.max(...gp.centers)) / 2;
          return gp.famPos - mid; // extra shift this block wants
        });
        const pools = [];
        targets.forEach((v, i) => {
          pools.push({ sum: v * groups[i].weight, w: groups[i].weight, from: i, to: i });
          while (pools.length > 1) {
            const q = pools[pools.length - 1];
            const pq = pools[pools.length - 2];
            if (pq.sum / pq.w <= q.sum / q.w) break;
            pools.splice(pools.length - 2, 2, { sum: pq.sum + q.sum, w: pq.w + q.w, from: pq.from, to: q.to });
          }
        });
        const groupDelta = new Array(groups.length).fill(0);
        pools.forEach(pl => { for (let i = pl.from; i <= pl.to; i++) groupDelta[i] = pl.sum / pl.w; });

        const placements = [{ unit: u, x: 0 }];
        packed.forEach(pk => {
          const off = pk.shift + groupDelta[pk.group];
          pk.sub.placements.forEach(pl => placements.push({ unit: pl.unit, x: pl.x + off }));
          pk.sub.contour.forEach(([mn, mx], g) => {
            const r = contour.get(g);
            contour.set(g, r ? [Math.min(r[0], mn + off), Math.max(r[1], mx + off)] : [mn + off, mx + off]);
          });
        });
        return { contour, placements };
      }

      const unitX = new Map();
      const globalRight = new Map(); // gen -> right-most edge placed so far
      const roots = allUnits.filter(u => !claimedBy.has(u));

      // Where a root would ideally sit, based on relatives that are already placed.
      const rootDesiredShift = (root) => {
        const wants = [];
        (claimedKids.get(root) ? [] : root.famIds.map(id => appState.families[id]).filter(Boolean)).forEach(f => {
          (f.children || []).forEach(c => {
            const cu = personToUnit[c.personId];
            if (cu && unitX.has(cu) && gen[c.personId] === root.gen + 1) {
              wants.push(unitX.get(cu) + cu.members.indexOf(c.personId) * UNIT_STEP + CARD_W / 2 - unionRelX(root, f));
            }
          });
        });
        root.members.forEach((pid, idx) => {
          const info = childPrimaryFamMap[pid];
          if (!info) return;
          [info.fam.partner1Id, info.fam.partner2Id].forEach(par => {
            const pu = par && personToUnit[par];
            if (pu && unitX.has(pu)) {
              wants.push(unitX.get(pu) + unionRelX(pu, info.fam) - (idx * UNIT_STEP + CARD_W / 2));
            }
          });
        });
        if (wants.length === 0) return null;
        return wants.reduce((s, v) => s + v, 0) / wants.length;
      };

      const occupied = new Map(); // gen -> [[left, right], ...] of placed units (absolute)
      const fits = (sub, shift) => {
        for (const [g, [mn, mx]] of sub.contour) {
          const list = occupied.get(g);
          if (!list) continue;
          const l = mn + shift - TREE_GAP / 2;
          const r = mx + shift + TREE_GAP / 2;
          for (const [a, b] of list) {
            if (l < b && r > a) return false;
          }
        }
        return true;
      };
      const placeRoot = (root) => {
        const sub = layoutSubtree(root);
        let minShift = -Infinity;
        sub.contour.forEach(([mn], g) => {
          const r = globalRight.get(g);
          if (r !== undefined) minShift = Math.max(minShift, r + TREE_GAP - mn);
        });
        const desired = rootDesiredShift(root);
        let shift;
        if (minShift === -Infinity) {
          shift = desired ?? 0;
        } else if (desired === null) {
          shift = minShift; // unrelated tree: start to the right of everything
        } else if (fits(sub, desired)) {
          shift = desired;
        } else {
          // Nearest free slot (left or right) to where this family wants to be.
          const cands = [minShift];
          sub.contour.forEach(([mn, mx], g) => {
            (occupied.get(g) || []).forEach(([a, b]) => {
              cands.push(b + TREE_GAP - mn, a - TREE_GAP - mx);
            });
          });
          shift = minShift;
          let best = Math.abs(minShift - desired);
          cands.forEach(c => {
            const d = Math.abs(c - desired);
            if (d < best && fits(sub, c)) { best = d; shift = c; }
          });
        }
        sub.placements.forEach(pl => {
          const x = pl.x + shift;
          unitX.set(pl.unit, x);
          if (!occupied.has(pl.unit.gen)) occupied.set(pl.unit.gen, []);
          occupied.get(pl.unit.gen).push([x, x + pl.unit.ownWidth]);
        });
        sub.contour.forEach(([, mx], g) => {
          globalRight.set(g, Math.max(globalRight.get(g) ?? -Infinity, mx + shift));
        });
      };

      const pendingRoots = new Set(roots);
      while (pendingRoots.size > 0) {
        // Prefer a root linked to something already placed (in-laws stay close), otherwise the next in order.
        let next = null;
        let nextDesired = Infinity;
        pendingRoots.forEach(r => {
          const d = rootDesiredShift(r);
          if (d !== null && d < nextDesired) { next = r; nextDesired = d; }
        });
        if (!next) next = pendingRoots.values().next().value;
        pendingRoots.delete(next);
        placeRoot(next);
      }

      const nodePositions = {};
      let minX = Infinity;
      unitX.forEach(x => { if (x < minX) minX = x; });
      const xShift = (LEFT_SWIMLANE_MARGIN + 28) - (isFinite(minX) ? minX : 0);
      allUnits.forEach(u => {
        const left = (unitX.get(u) ?? 0) + xShift;
        u.desiredLeft = left;
        u.members.forEach((pid, idx) => {
          nodePositions[pid] = {
            x: left + idx * UNIT_STEP,
            y: TOP_OFFSET + u.gen * LAYER_HEIGHT,
            gen: u.gen
          };
        });
      });
      Object.keys(unitsByGen).forEach(g => {
        unitsByGen[g].sort((a, b) => a.desiredLeft - b.desiredLeft);
      });

      const familyGutterMap = {};
      for (let g = 0; g <= maxGen; g++) {
        const layerFams = families.filter(f => {
          const p1g = f.partner1Id && nodePositions[f.partner1Id] ? nodePositions[f.partner1Id].gen : null;
          const p2g = f.partner2Id && nodePositions[f.partner2Id] ? nodePositions[f.partner2Id].gen : null;
          const parentLayer = p1g !== null && p2g !== null ? Math.max(p1g, p2g) : (p1g ?? p2g);
          return parentLayer === g && (f.children || []).some(c => nodePositions[c.personId]);
        });

        layerFams.sort((a, b) => {
          const ax = a.partner1Id && nodePositions[a.partner1Id] ? nodePositions[a.partner1Id].x : 0;
          const bx = b.partner1Id && nodePositions[b.partner1Id] ? nodePositions[b.partner1Id].x : 0;
          return ax - bx;
        });

        const gutterTop = TOP_OFFSET + g * LAYER_HEIGHT + CARD_H;
        layerFams.forEach((f, idx) => {
          familyGutterMap[f.id] = gutterTop + 20 + (idx % 5) * 11;
        });
      }

      let maxRight = 960;
      Object.values(nodePositions).forEach(pos => {
        if (pos.x + CARD_W + 90 > maxRight) maxRight = pos.x + CARD_W + 90;
      });

      return {
        nodes: nodePositions,
        unitsByGen,
        familyGutterMap,
        hasAnyParentInFullTree,
        hasHiddenParentBranch,
        hasHiddenRelatives,
        maxGen,
        generations: gen,
        bounds: {
          minX: 0,
          minY: 0,
          maxX: maxRight,
          maxY: (maxGen + 1) * LAYER_HEIGHT + 44
        }
      };
    }

    /* =====================================================================
     * 8. RENDERING: HEADER, SWIMLANES, CONNECTORS, PORTRAIT CARDS & OUTLINE
     * ===================================================================== */
    function renderAll() {
      try { applyConfigToDom(); } catch (e) {}

      updateHeaderControls();
      if (!isAuthorizedViewer()) {
        clearCanvasDomLayers();
        document.getElementById('outline-list-container').innerHTML = '';
        document.getElementById('inspector-body').innerHTML = '';
        return;
      }
      const layout = computeTreeLayout();
      renderVisualCanvas(layout);
      renderAccessibleOutline(layout.generations);
      renderInspector(layout.generations);
    }

    function updateHeaderControls() {
      const authorized = isAuthorizedViewer();
      const activeEmail = getActiveUserEmail();
      const activeRole = getEffectiveSessionRole();

      document.getElementById('header-tree-title').textContent = authorized
        ? (appState.tree.title || getSiteTitle())
        : getSiteTitle();

      const editable = canEditTree();
      document.getElementById('btn-undo').disabled = !editable || undoStack.length === 0;
      document.getElementById('btn-redo').disabled = !editable || redoStack.length === 0;

      const centralId = authorized ? resolveCentralPersonIdForUser() : null;
      if (authorized) appState.centralPersonId = centralId;
      const centralPerson = centralId ? appState.persons[centralId] : null;

      const accountLabel = activeEmail
        ? (sessionAuth.displayName || (centralPerson ? getDisplayName(centralPerson, true) : activeEmail))
        : 'Sign in with Google';
      document.getElementById('header-google-user-label').textContent = accountLabel;
      const accountBtn = document.getElementById('btn-google-account');
      accountBtn.dataset.signedIn = activeEmail ? 'true' : 'false';

      document.getElementById('gen-depth-main-name').textContent = centralPerson
        ? getDisplayName(centralPerson, true)
        : 'Central Person';

      const depth = uiState.generationDepth;
      document.getElementById('label-gen-depth').textContent = depth >= 5 ? '5+' : String(depth);
      const fillEl = document.getElementById('gen-depth-fill');
      if (fillEl) fillEl.style.width = `${((depth - 1) / 4) * 100}%`;
      document.querySelectorAll('.gen-dot-btn').forEach(dot => {
        const val = parseInt(dot.dataset.setGenDepth, 10);
        if (val === depth) {
          dot.className = 'gen-dot-btn relative z-10 w-5 h-5 rounded-full bg-slate-800 ring-4 ring-slate-200 transition-transform';
        } else if (val < depth) {
          dot.className = 'gen-dot-btn relative z-10 w-3.5 h-3.5 rounded-full bg-slate-700 transition-transform hover:scale-125';
        } else {
          dot.className = 'gen-dot-btn relative z-10 w-3.5 h-3.5 rounded-full bg-slate-300 transition-transform hover:scale-125';
        }
      });

      const authToolbarGroup = document.getElementById('authorized-toolbar-group');
      const headerSearchWrap = document.getElementById('header-search-wrap');
      const viewSwitcherWrap = document.getElementById('view-switcher-wrap');
      const canvasBottomControls = document.getElementById('canvas-bottom-controls');
      const canvasLegendPill = document.getElementById('canvas-legend-pill');
      const adminLinkEl = document.getElementById('link-admin-panel');
      const inspectorBtnEl = document.getElementById('btn-toggle-inspector');
      const badgeEl = document.getElementById('badge-active-role');
      const logMigNotice = document.getElementById('log-migration-notice');
      if (logMigNotice) {
        logMigNotice.classList.toggle('hidden', !(pendingLogMigration && isSuperAdminEmail(getActiveUserEmail())));
      }
      const readonlyBanner = document.getElementById('readonly-banner');
      const readonlyBadge = document.getElementById('readonly-banner-badge');
      const readonlyMsg = document.getElementById('readonly-banner-msg');
      const unauthOverlay = document.getElementById('unauthenticated-overlay');
      const unauthTitle = document.getElementById('unauth-gate-title');
      const unauthSub = document.getElementById('unauth-gate-subtitle');
      const fullTabHint = document.getElementById('btn-open-full-tab-hint');
      const emptyOverlay = document.getElementById('empty-tree-overlay');
      const emptyAddBtn = document.getElementById('btn-empty-add-first');
      const emptyImportLink = document.getElementById('btn-empty-import-admin');
      const emptySubtitle = document.getElementById('empty-tree-subtitle');

      const hasAdminPrivilege = canAccessAdminPanel();
      if (authToolbarGroup) authToolbarGroup.classList.toggle('hidden', !authorized);
      // These carry responsive display classes, so auth state uses its own class
      if (headerSearchWrap) headerSearchWrap.classList.toggle('auth-hidden', !authorized);
      if (viewSwitcherWrap) viewSwitcherWrap.classList.toggle('auth-hidden', !authorized);
      document.getElementById('btn-header-more')?.classList.toggle('auth-hidden', !authorized);
      if (!authorized) {
        headerSearchWrap?.classList.remove('search-open');
        document.getElementById('header-more-menu')?.classList.add('hidden');
      }
      if (canvasBottomControls) canvasBottomControls.classList.toggle('hidden', !authorized);
      if (canvasLegendPill) canvasLegendPill.classList.toggle('auth-hidden', !authorized); // keeps its md:flex (hidden on phones)
      const quietRole = !authorized
        ? (activeRole === 'unauthorized' ? 'Restricted' : 'Signed out')
        : (activeRole === 'super_admin' ? 'Super Admin'
          : activeRole === 'admin' ? 'Admin'
          : activeRole === 'edit' ? 'Edit'
          : 'View');
      if (adminLinkEl) {
        adminLinkEl.classList.toggle('hidden', !hasAdminPrivilege);
        const adminTitle = hasAdminPrivilege ? `Admin panel · ${quietRole}` : 'Admin panel';
        adminLinkEl.setAttribute('title', adminTitle);
        adminLinkEl.setAttribute('aria-label', adminTitle);
        const menuAdmin = document.querySelector('#header-more-menu [data-proxy-for="link-admin-panel"]');
        if (menuAdmin) menuAdmin.setAttribute('title', adminTitle);
      }
      if (inspectorBtnEl) inspectorBtnEl.classList.toggle('hidden', !authorized);
      accountBtn.setAttribute('title', activeEmail ? `Google account · ${quietRole}` : 'Sign in with Google');
      accountBtn.setAttribute('aria-label', activeEmail ? `Google account: ${accountLabel} · ${quietRole}` : 'Sign in with Google');

      if (!authorized) {
        emptyOverlay?.classList.add('hidden');
        unauthOverlay?.classList.remove('hidden');
        const isEmbeddedIframe = window.self !== window.top;
        if (fullTabHint) fullTabHint.classList.toggle('hidden', !isEmbeddedIframe);

        if (activeRole === 'unauthorized') {
          badgeEl.textContent = 'Restricted';
          badgeEl.className = 'role-hint text-[9.5px] shrink-0';
          unauthTitle.textContent = 'Account Not Yet Authorized';
          unauthSub.textContent = `Signed in as ${activeEmail}. Cloud Firestore denied read access because this Google email is not in authorizedEmails yet. Ask the Super Admin to add your email.`;
          readonlyBadge.textContent = 'Restricted';
          readonlyMsg.textContent = `Signed in as ${activeEmail} — Firestore Security Rules block access until authorized.`;
          readonlyBanner.classList.remove('hidden');
        } else {
          badgeEl.textContent = 'Signed out';
          badgeEl.className = 'role-hint text-[9.5px] shrink-0';
          unauthTitle.textContent = 'Sign In to ' + getSiteTitle();
          unauthSub.textContent = 'No genealogy records are loaded until you sign in with an authorized Google Account.';
          readonlyBanner.classList.add('hidden');
        }
        return;
      }

      unauthOverlay?.classList.add('hidden');
      if (emptyAddBtn) emptyAddBtn.classList.toggle('hidden', !canEditTree());
      if (emptyImportLink) emptyImportLink.classList.toggle('hidden', !hasAdminPrivilege);
      if (emptySubtitle) {
        emptySubtitle.textContent = hasAdminPrivilege
          ? 'Cloud Firestore storage is currently empty. Add your founding person directly or import an existing GEDCOM 5.5.1 / 7.0 file via the Admin Panel.'
          : 'Cloud Firestore storage is currently empty. Click below to add the founding person to begin building your family tree.';
      }

      if (activeRole === 'super_admin' || activeRole === 'admin') {
        // Role is a tooltip / dot on the single Admin control, not a coloured badge.
        badgeEl.textContent = '';
        badgeEl.className = 'role-hint hidden text-[9.5px] shrink-0';
        readonlyBanner.classList.add('hidden');
      } else if (activeRole === 'edit') {
        badgeEl.textContent = 'Edit';
        badgeEl.className = 'role-hint text-[9.5px] shrink-0';
        readonlyBanner.classList.add('hidden');
      } else {
        badgeEl.textContent = 'View';
        badgeEl.className = 'role-hint text-[9.5px] shrink-0';
        readonlyBadge.textContent = 'View Access';
        readonlyMsg.textContent = `Signed in as ${activeEmail} (Tree Member · View Access). Ask the Super Admin for Edit access if needed.`;
        readonlyBanner.classList.remove('hidden');
      }

      updateFullTreeToggle();
      document.getElementById('btn-view-canvas').setAttribute('aria-pressed', String(uiState.viewMode === 'canvas'));
      document.getElementById('btn-view-list').setAttribute('aria-pressed', String(uiState.viewMode === 'list'));
      const btnCanvas = document.getElementById('btn-view-canvas');
      const btnList = document.getElementById('btn-view-list');
      if (uiState.viewMode === 'canvas') {
        btnCanvas.classList.add('bg-white', 'text-archival-indigo', 'shadow-2xs');
        btnCanvas.classList.remove('text-slate-600');
        btnList.classList.remove('bg-white', 'text-archival-indigo', 'shadow-2xs');
        btnList.classList.add('text-slate-600');
        document.getElementById('canvas-viewport').classList.remove('hidden');
        document.getElementById('outline-viewport').classList.add('hidden');
      } else {
        btnList.classList.add('bg-white', 'text-archival-indigo', 'shadow-2xs');
        btnList.classList.remove('text-slate-600');
        btnCanvas.classList.remove('bg-white', 'text-archival-indigo', 'shadow-2xs');
        btnCanvas.classList.add('text-slate-600');
        document.getElementById('canvas-viewport').classList.add('hidden');
        document.getElementById('outline-viewport').classList.remove('hidden');
      }

    }


    const canvasDom = {
      nodes: new Map(),
      unions: new Map(),
      edges: new Map()
    };
    let canvasSwimlanesKey = '';
    let canvasJumpKey = '';
    // Cards under an active finger/pen press. iOS Safari keeps sending a touch's
    // events to the element it started on; if a recull removes that element the
    // gesture goes dead, so pinned cards stay in the DOM until the press ends.
    const canvasPinnedNodes = new Set();

    function clearCanvasDomLayers() {
      canvasDom.nodes.clear();
      canvasDom.unions.clear();
      canvasDom.edges.clear();
      canvasSwimlanesKey = '';
      canvasJumpKey = '';
      const swim = document.getElementById('tree-swimlanes-layer');
      const svg = document.getElementById('tree-edges-svg');
      const nodes = document.getElementById('tree-nodes-layer');
      const jump = document.getElementById('gen-jump-bar');
      if (swim) swim.innerHTML = '';
      if (svg) svg.innerHTML = '';
      if (nodes) nodes.innerHTML = '';
      if (jump) jump.innerHTML = '';
    }

    function syncSvgEdge(key, parent, tag, attrs) {
      let el = canvasDom.edges.get(key);
      if (!el || el.tagName.toLowerCase() !== tag) {
        if (el) el.remove();
        el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        el.setAttribute('data-edge-key', key);
        parent.appendChild(el);
        canvasDom.edges.set(key, el);
      }
      Object.keys(attrs).forEach((name) => {
        const value = attrs[name];
        if (value == null || value === false || value === '') {
          if (el.hasAttribute(name)) el.removeAttribute(name);
        } else if (el.getAttribute(name) !== String(value)) {
          el.setAttribute(name, value);
        }
      });
      ['stroke-dasharray', 'class', 'fill'].forEach((name) => {
        if (!Object.prototype.hasOwnProperty.call(attrs, name) && el.hasAttribute(name)) el.removeAttribute(name);
      });
      return el;
    }

    function pruneCanvasMap(map, used) {
      for (const [key, el] of map) {
        if (used.has(key)) continue;
        if (el && canvasPinnedNodes.has(el)) continue;
        if (el && el.remove) el.remove();
        map.delete(key);
      }
    }

    function renderVisualCanvas(layout) {
      const personIds = Object.keys(layout.nodes);
      const emptyOverlay = document.getElementById('empty-tree-overlay');
      if (Object.keys(appState.persons).length === 0) {
        emptyOverlay.classList.remove('hidden');
        clearCanvasDomLayers();
        return;
      }
      emptyOverlay.classList.add('hidden');

      const svgEl = document.getElementById('tree-edges-svg');
      const nodesLayer = document.getElementById('tree-nodes-layer');
      const swimlanesLayer = document.getElementById('tree-swimlanes-layer');

      const totalWidth = Math.max(layout.bounds.maxX, 1100);
      const totalHeight = Math.max(layout.bounds.maxY, 480);

      svgEl.setAttribute('width', totalWidth);
      svgEl.setAttribute('height', totalHeight);
      svgEl.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`);

      let swimlanesHtml = '';
      let jumpPillsHtml = '';
      for (let g = 0; g <= layout.maxGen; g++) {
        const topY = g * LAYER_HEIGHT;
        const roman = toRomanNumeral(g + 1);
        const bgClass = g % 2 === 0 ? 'bg-white/65' : 'bg-parchment-100/65';
        const roleSubtitle = g === 0
          ? 'Founding Ancestors'
          : g === layout.maxGen
            ? 'Latest Generation'
            : `Generation ${roman}`;

        swimlanesHtml += `
          <div style="top:${topY}px; left:0; width:${totalWidth}px; height:${LAYER_HEIGHT}px;" class="absolute ${bgClass} border-b border-parchment-200/90">
            <div class="sticky left-0 inline-flex flex-col justify-center h-full px-4 border-r border-parchment-200/80 bg-white/80 backdrop-blur-2xs" style="width:${LEFT_SWIMLANE_MARGIN - 12}px;">
              <span class="text-[11px] font-bold uppercase tracking-wider text-archival-indigo">GEN ${roman}</span>
              <span class="text-[10.5px] text-slate-500 mt-0.5">${escapeHtml(roleSubtitle)}</span>
            </div>
          </div>
        `;

        jumpPillsHtml += `
          <button type="button" data-jump-gen="${g}" class="px-2 py-1 rounded-lg hover:bg-parchment-100 text-slate-700 hover:text-archival-indigo transition">
            Gen ${roman}
          </button>
        `;
      }
      const swimKey = layout.maxGen + '|' + totalWidth + '|' + totalHeight;
      if (canvasSwimlanesKey !== swimKey) {
        swimlanesLayer.innerHTML = swimlanesHtml;
        canvasSwimlanesKey = swimKey;
      }
      if (canvasJumpKey !== swimKey) {
        document.getElementById('gen-jump-bar').innerHTML = jumpPillsHtml;
        canvasJumpKey = swimKey;
      }

      const childParentFamilies = {};
      Object.values(appState.families).forEach(fam => {
        const p1Valid = fam.partner1Id && layout.nodes[fam.partner1Id];
        const p2Valid = fam.partner2Id && layout.nodes[fam.partner2Id];
        if (!p1Valid && !p2Valid) return;
        (fam.children || []).forEach(c => {
          if (!layout.nodes[c.personId]) return;
          if (!childParentFamilies[c.personId]) childParentFamilies[c.personId] = [];
          childParentFamilies[c.personId].push(fam.id);
        });
      });

      const activePersonIds = new Set(uiState.highlightedKinship ? uiState.highlightedKinship.pathIds : []);
      const usedEdges = new Set();
      const usedUnions = new Set();
      const usedNodes = new Set();

      Object.values(appState.families).forEach(fam => {
        const pos1 = fam.partner1Id ? layout.nodes[fam.partner1Id] : null;
        const pos2 = fam.partner2Id ? layout.nodes[fam.partner2Id] : null;
        if (!pos1 && !pos2) return;

        const isKinFamily = activePersonIds.has(fam.partner1Id) && activePersonIds.has(fam.partner2Id);
        let unionX = 0;
        let unionY = 0;

        if (pos1 && pos2) {
          const leftPos = pos1.x <= pos2.x ? pos1 : pos2;
          const rightPos = pos1.x <= pos2.x ? pos2 : pos1;
          const x1 = leftPos.x + CARD_W;
          const x2 = rightPos.x;
          unionY = leftPos.y + CARD_H / 2;
          unionX = (x1 + x2) / 2;

          const dash = fam.status === 'divorced' ? '5,4' : null;
          const kinClass = isKinFamily ? 'kinship-edge-active' : '';

          if (Math.abs(x2 - x1) <= PARTNER_GAP + 8) {
            const key = 'union-line-' + fam.id;
            usedEdges.add(key);
            syncSvgEdge(key, svgEl, 'line', {
              x1, y1: unionY, x2, y2: unionY,
              stroke: '#94A3B8', 'stroke-width': '1.75',
              'stroke-dasharray': dash, class: kinClass
            });
          } else {
            const c1x = leftPos.x + CARD_W / 2;
            const c2x = rightPos.x + CARD_W / 2;
            const archY = leftPos.y - 16;
            unionX = (c1x + c2x) / 2;
            unionY = archY;
            const key = 'union-path-' + fam.id;
            usedEdges.add(key);
            syncSvgEdge(key, svgEl, 'path', {
              d: `M ${c1x} ${leftPos.y} L ${c1x} ${archY} L ${c2x} ${archY} L ${c2x} ${rightPos.y}`,
              fill: 'none', stroke: '#94A3B8', 'stroke-width': '1.6',
              'stroke-dasharray': dash, class: kinClass
            });
          }

          const mYear = extractYearLabel(fam.marriageDate);
          const unionTitle = fam.status === 'divorced'
            ? 'Divorced'
            : mYear
              ? `Married ${mYear}`
              : 'Union';

          usedUnions.add(fam.id);
          let unionEl = canvasDom.unions.get(fam.id);
          if (!unionEl) {
            unionEl = document.createElement('div');
            unionEl.dataset.unionId = fam.id;
            unionEl.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="9.2" cy="12.5" r="4.3" /><circle cx="14.8" cy="12.5" r="4.3" /></svg>`;
            unionEl.className = 'absolute rounded-full bg-amber-50/95 border border-amber-200 shadow-2xs flex items-center justify-center text-amber-700 z-10 pointer-events-none';
            nodesLayer.appendChild(unionEl);
            canvasDom.unions.set(fam.id, unionEl);
          }
          unionEl.style.left = (unionX - 15) + 'px';
          unionEl.style.top = (unionY - 15) + 'px';
          unionEl.style.width = '30px';
          unionEl.style.height = '30px';
          unionEl.title = unionTitle;
        } else {
          const singlePos = pos1 || pos2;
          unionX = singlePos.x + CARD_W / 2;
          unionY = singlePos.y + CARD_H;
        }

        const validChildren = (fam.children || []).filter(c => layout.nodes[c.personId]);
        if (validChildren.length > 0) {
          const busY = layout.familyGutterMap[fam.id] || (unionY + 48);
          const dropKey = 'drop-' + fam.id;
          usedEdges.add(dropKey);
          syncSvgEdge(dropKey, svgEl, 'line', {
            x1: unionX, y1: unionY, x2: unionX, y2: busY,
            stroke: '#94A3B8', 'stroke-width': '1.75'
          });

          const childConnectors = validChildren.map(c => {
            const cPos = layout.nodes[c.personId];
            const pList = childParentFamilies[c.personId] || [fam.id];
            const pIdx = pList.indexOf(fam.id);
            const offsetX = pList.length > 1 ? (pIdx === 0 ? -18 : 18) : 0;
            return {
              childId: c.personId,
              linkage: c.linkage || 'biological',
              cx: cPos.x + CARD_W / 2 + offsetX,
              topY: cPos.y
            };
          });

          const allBusXs = [unionX, ...childConnectors.map(cc => cc.cx)];
          const minBusX = Math.min(...allBusXs);
          const maxBusX = Math.max(...allBusXs);

          if (maxBusX > minBusX) {
            const busKey = 'bus-' + fam.id;
            usedEdges.add(busKey);
            syncSvgEdge(busKey, svgEl, 'line', {
              x1: minBusX, y1: busY, x2: maxBusX, y2: busY,
              stroke: '#94A3B8', 'stroke-width': '1.75'
            });
          }

          childConnectors.forEach(cc => {
            const isAdoptive = cc.linkage === 'adoptive' || cc.linkage === 'step';
            const isKinChild = activePersonIds.has(cc.childId) && (activePersonIds.has(fam.partner1Id) || activePersonIds.has(fam.partner2Id));
            const key = 'child-' + fam.id + '-' + cc.childId;
            usedEdges.add(key);
            syncSvgEdge(key, svgEl, 'line', {
              x1: cc.cx, y1: busY, x2: cc.cx, y2: cc.topY,
              stroke: isAdoptive ? '#0284C7' : '#94A3B8',
              'stroke-width': '1.75',
              'stroke-dasharray': isAdoptive ? '5,4' : null,
              class: isKinChild ? 'kinship-edge-active' : ''
            });
          });
        }
      });

      pruneCanvasMap(canvasDom.edges, usedEdges);
      pruneCanvasMap(canvasDom.unions, usedUnions);

      personIds.forEach(id => {
        const p = appState.persons[id];
        const pos = layout.nodes[id];
        if (!pos) return;

        const isSelected = appState.selectedPersonId === id;
        const isCentral = appState.centralPersonId === id;
        const isKin = activePersonIds.has(id);
        const displayName = getDisplayName(p);
        const lifespanStr = getCardLifespanLabel(p);
        const deceasedLabel = getDeceasedLabel(p);
        const cardAria = deceasedLabel
          ? (lifespanStr ? `${displayName}, ${lifespanStr}, ${deceasedLabel}` : `${displayName}, ${deceasedLabel}`)
          : (lifespanStr ? `${displayName}, ${lifespanStr}` : displayName);

        const focusView = isFocusViewActive();
        const isFocusPerson = focusView && id === getFocusPersonId();
        const hasFolded = Boolean(layout.hasHiddenRelatives && layout.hasHiddenRelatives[id]);
        const hasParentBranch = focusView
          ? (hasFolded || (isFocusPerson && Boolean(layout.hasAnyParentInFullTree && layout.hasAnyParentInFullTree[id])))
          : Boolean(layout.hasAnyParentInFullTree && layout.hasAnyParentInFullTree[id]);
        const isBranchCollapsed = focusView
          ? hasFolded && !isFocusPerson
          : (uiState.collapsedAncestorIds.has(id) || Boolean(layout.hasHiddenParentBranch && layout.hasHiddenParentBranch[id]));
        const branchTitle = focusView
          ? (isFocusPerson ? `Close ${displayName}'s branch (go up one level)` : `Open ${displayName}'s branch and close the others`)
          : `Focus on ${displayName}'s branch`;

        const cardBorder = p.sex === 'F'
          ? 'border-rose-300'
          : p.sex === 'M'
            ? 'border-sky-300'
            : 'border-slate-300';

        const avatarRing = p.sex === 'F'
          ? 'border-rose-200 bg-rose-50/60 text-slate-400'
          : p.sex === 'M'
            ? 'border-sky-200 bg-sky-50/60 text-slate-400'
            : 'border-slate-200 bg-slate-100 text-slate-400';

        const portraitUrl = p.photoUrl ? safeImageUrl(p.photoUrl) : '';
        const inner = `
            ${hasParentBranch ? `
              <button
                type="button"
                data-toggle-ancestor-stub="${escapeAttr(id)}"
                title="${escapeAttr(branchTitle)}"
                aria-label="${escapeAttr(branchTitle)}"
                aria-expanded="${isBranchCollapsed ? 'false' : 'true'}"
                class="absolute -top-[9px] left-1.5 flex items-center gap-1 px-1 py-1 rounded-t transition-transform hover:-translate-y-0.5 z-20 ${isFocusPerson ? 'ring-2 ring-amber-400 rounded' : ''}"
              >
                <span class="w-3.5 h-1.5 rounded-[2px] ${isBranchCollapsed ? 'bg-archival-indigo' : 'bg-slate-400/85'} block"></span>
                <span class="w-3.5 h-1.5 rounded-[2px] ${isBranchCollapsed ? 'bg-archival-indigo' : 'bg-slate-400/85'} block"></span>
              </button>
            ` : ''}

            ${isCentral ? `
              <span title="Logged-In Central Person" class="you-badge absolute -top-2.5 px-1.5 py-0.2 rounded-full bg-archival-indigo text-white text-[9px] font-bold uppercase tracking-wider shadow-2xs">
                You
              </span>
            ` : ''}
            ${deceasedCornerHtml(p)}

            <div class="w-11 h-11 rounded-full border ${avatarRing} flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
              ${portraitUrl
                ? `<img src="${escapeAttr(portraitUrl)}" alt="" class="w-full h-full object-cover" />`
                : `<svg class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">${getSilhouetteSvgInner(p.sex)}</svg>`
              }
            </div>

            <div class="w-full min-w-0 space-y-0.5">
              <div class="font-sans font-semibold text-[11.5px] leading-tight text-slate-900 line-clamp-2 break-words">
                ${escapeHtml(displayName)}
              </div>
              <div class="text-[10.5px] text-slate-500 truncate">
                ${escapeHtml(lifespanStr)}
              </div>
            </div>

            ${(isSelected && canEditTree()) ? `
              <div class="absolute -bottom-7 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-900 text-white px-2 py-0.5 rounded-full shadow-md text-[10px] font-medium whitespace-nowrap z-20">
                <button data-quick-rel="parent" class="hover:text-amber-300 px-1 transition">+Parent</button>
                <span class="text-slate-600">·</span>
                <button data-quick-rel="spouse" class="hover:text-amber-300 px-1 transition">+Spouse</button>
                <span class="text-slate-600">·</span>
                <button data-quick-rel="child" class="hover:text-amber-300 px-1 transition">+Child</button>
                <span class="text-slate-600">·</span>
                <button data-quick-rel="sibling" class="hover:text-amber-300 px-1 transition">+Sibling</button>
              </div>
            ` : ''}
        `;
        const className = `person-card absolute bg-white border-[1.5px] ${cardBorder} rounded-xl px-2 py-2.5 shadow-2xs cursor-pointer flex flex-col items-center justify-between text-center z-10 ${isSelected ? 'selected' : ''} ${isCentral ? 'central-person' : ''} ${isKin ? 'kinship-highlight' : ''}`;
        const sig = [pos.x, pos.y, className, cardAria, inner].join('\x1f');
        usedNodes.add(id);
        let el = canvasDom.nodes.get(id);
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-person-card', id);
          el.setAttribute('tabindex', '0');
          el.setAttribute('role', 'button');
          nodesLayer.appendChild(el);
          canvasDom.nodes.set(id, el);
        }
        el.style.left = pos.x + 'px';
        el.style.top = pos.y + 'px';
        el.style.width = CARD_W + 'px';
        el.style.height = CARD_H + 'px';
        if (el.className !== className) el.className = className;
        if (el.getAttribute('aria-label') !== cardAria) el.setAttribute('aria-label', cardAria);
        if (el.dataset.canvasSig !== sig) {
          el.innerHTML = inner;
          el.dataset.canvasSig = sig;
        }
      });

      pruneCanvasMap(canvasDom.nodes, usedNodes);
      applyCanvasTransform();
    }

    function applyCanvasTransform() {
      const stage = document.getElementById('canvas-stage');
      if (!stage) return;
      stage.style.transform = `translate(${uiState.panX}px, ${uiState.panY}px) scale(${uiState.zoom})`;
      document.getElementById('btn-zoom-reset').textContent = `${Math.round(uiState.zoom * 100)}%`;
    }

    function fitTreeToScreen() {
      const viewport = document.getElementById('canvas-viewport');
      const layout = computeTreeLayout();
      const personIds = Object.keys(layout.nodes);
      if (personIds.length === 0) return;

      const vw = viewport.clientWidth || 960;
      const vh = viewport.clientHeight || 560;
      const treeW = layout.bounds.maxX - layout.bounds.minX + 32;
      const treeH = layout.bounds.maxY - layout.bounds.minY + 64;

      const scaleX = vw / treeW;
      const scaleY = vh / treeH;
      const optimalZoom = Math.max(0.32, Math.min(1.05, Math.min(scaleX, scaleY)));

      uiState.zoom = optimalZoom;
      uiState.panX = Math.max(12, (vw - (layout.bounds.maxX - layout.bounds.minX) * optimalZoom) / 2);
      uiState.panY = Math.max(24, (vh - (layout.bounds.maxY - layout.bounds.minY) * optimalZoom) / 2);
      applyCanvasTransform();
    }

    // Open one branch (accordion) and smoothly re-centre on it.
    function setFocusPerson(personId, opts = {}) {
      if (!personId || !appState.persons[personId]) return;
      uiState.focusPersonId = personId;
      if (opts.enableFocus) uiState.focusMode = true;
      saveViewPrefs();
      if (opts.render === false) return;
      renderAll();
      centerOnPerson(opts.recenterOn && computeTreeLayout().nodes[opts.recenterOn] ? opts.recenterOn : personId, true);
    }

    function setFullTreeMode(full) {
      uiState.focusMode = !full;
      saveViewPrefs();
      renderAll();
      if (full) {
        fitTreeToScreen();
      } else {
        centerOnPerson(getFocusPersonId(), true);
      }
      const ann = document.getElementById('toast-banner');
      if (ann) showToast(full ? 'Showing the full family tree' : 'Focus view: open a branch with the small tabs on top of a card');
    }

    function updateFullTreeToggle() {
      const btn = document.getElementById('btn-toggle-full-tree');
      const lbl = document.getElementById('lbl-toggle-full-tree');
      if (!btn || !lbl) return;
      const full = !uiState.focusMode;
      btn.setAttribute('aria-pressed', String(full));
      lbl.textContent = full ? 'Focus view' : 'Show full tree';
      btn.title = full ? 'Return to the focused view (one branch open at a time)' : 'Show every branch of the family tree';
    }

    function centerOnPerson(personId, smooth = true) {
      const viewport = document.getElementById('canvas-viewport');
      const layout = computeTreeLayout();
      const pos = layout.nodes[personId];
      if (!pos || !viewport) return;

      const vw = viewport.clientWidth || 960;
      const vh = viewport.clientHeight || 560;
      const stage = document.getElementById('canvas-stage');

      uiState.zoom = Math.max(0.78, Math.min(1.05, uiState.zoom));
      uiState.panX = vw / 2 - (pos.x + CARD_W / 2) * uiState.zoom;
      uiState.panY = vh / 2 - (pos.y + CARD_H / 2) * uiState.zoom;

      if (smooth && stage) {
        stage.classList.add('stage-smooth-pan');
        applyCanvasTransform();
        setTimeout(() => stage.classList.remove('stage-smooth-pan'), 380);
      } else {
        applyCanvasTransform();
      }
    }

    function renderAccessibleOutline(generations) {
      const container = document.getElementById('outline-list-container');
      const persons = Object.values(appState.persons);
      document.getElementById('outline-person-count').textContent = `${persons.length} Individual${persons.length === 1 ? '' : 's'}`;

      if (persons.length === 0) {
        container.innerHTML = `
          <div class="bg-white border border-parchment-300 rounded-2xl p-6 text-center space-y-2 shadow-2xs">
            <div class="font-serif text-base font-semibold text-slate-900">No Individuals in Archive Yet</div>
            <p class="text-xs text-slate-500">Switch to the Tree view to add your first person or import a GEDCOM file from the Admin Panel.</p>
          </div>
        `;
        return;
      }

      const byGen = {};
      persons.forEach(p => {
        const g = generations[p.id] ?? 0;
        if (!byGen[g]) byGen[g] = [];
        byGen[g].push(p);
      });

      const sortedGens = Object.keys(byGen).map(Number).sort((a, b) => a - b);
      container.innerHTML = sortedGens.map(g => {
        const roman = toRomanNumeral(g + 1);
        return `
          <div class="bg-white border border-parchment-300 rounded-2xl p-4 shadow-2xs space-y-2.5">
            <div class="flex items-center justify-between border-b border-parchment-200 pb-2">
              <span class="text-xs font-bold uppercase tracking-wider text-archival-indigo">Generation ${roman}</span>
              <span class="text-[11px] text-slate-500">${byGen[g].length} member${byGen[g].length === 1 ? '' : 's'}</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              ${byGen[g].map(p => `
                <button type="button" data-outline-person="${escapeAttr(p.id)}" class="relative text-left p-2.5 rounded-xl border border-parchment-200 hover:border-archival-indigo hover:bg-parchment-50 transition flex items-center justify-between gap-2">
                  ${deceasedCornerHtml(p)}
                  <div class="min-w-0">
                    <div class="font-semibold text-xs text-slate-900 truncate">${escapeHtml(getDisplayName(p))}</div>
                    <div class="text-[11px] text-slate-500 truncate">${escapeHtml(getVitalSummary(p))}</div>
                  </div>
                  ${p.id === appState.centralPersonId ? `<span class="px-1.5 py-0.5 rounded-full bg-archival-indigo text-white text-[9px] font-bold uppercase shrink-0">You</span>` : ''}
                </button>
              `).join('')}
            </div>
          </div>
        `;
      }).join('');
    }

    /* =====================================================================
     * 9. REDESIGNED PERSON PROFILE EXTENSION SHEET
     * ===================================================================== */
    function openInspector(personId, tabName = null) {
      if (!isAuthorizedViewer()) return;
      if (personId && appState.persons[personId]) {
        appState.selectedPersonId = personId;
      }
      if (tabName) uiState.inspectorTab = tabName;
      const drawer = document.getElementById('inspector-drawer');
      if (!uiState.inspectorOpen && document.activeElement && !drawer.contains(document.activeElement)) {
        inspectorReturnFocus = document.activeElement;
      }
      uiState.inspectorOpen = true;
      drawer.classList.remove('translate-x-full');
      drawer.inert = false;
      renderAll();
    }

    let inspectorReturnFocus = null;
    function closeInspector() {
      uiState.inspectorOpen = false;
      const drawer = document.getElementById('inspector-drawer');
      const hadFocus = drawer.contains(document.activeElement);
      drawer.classList.add('translate-x-full');
      drawer.inert = true;
      if (hadFocus && inspectorReturnFocus && document.contains(inspectorReturnFocus)) {
        try { inspectorReturnFocus.focus(); } catch (e) {}
      }
      inspectorReturnFocus = null;
    }

    function updateCircleActionActiveState() {
      const modes = ['profile', 'edit', 'add'];
      modes.forEach(m => {
        const el = document.getElementById(`circle-bg-${m}`);
        if (!el) return;
        const active = uiState.inspectorTab === m;
        if (active) {
          el.className = 'w-11 h-11 rounded-full bg-archival-indigo text-white shadow-xs flex items-center justify-center transition';
        } else {
          el.className = 'w-11 h-11 rounded-full bg-stone-100 group-hover:bg-stone-200 text-slate-700 flex items-center justify-center transition';
        }
      });
    }

    function renderInspector(generations) {
      const person = appState.selectedPersonId ? appState.persons[appState.selectedPersonId] : null;
      if (!person) {
        const inspectorCorner = document.getElementById('inspector-deceased-corner');
        if (inspectorCorner) {
          inspectorCorner.classList.add('hidden');
          inspectorCorner.removeAttribute('title');
          inspectorCorner.removeAttribute('aria-label');
        }
        return;
      }

      updateCircleActionActiveState();

      const avatarWrap = document.getElementById('inspector-avatar-wrap');
      const avatarImg = document.getElementById('inspector-avatar-img');
      const avatarSvg = document.getElementById('inspector-avatar-svg');

      avatarWrap.className = person.sex === 'F'
        ? 'w-16 h-16 rounded-full border-2 border-rose-300 bg-rose-50/70 flex items-center justify-center overflow-hidden'
        : person.sex === 'M'
          ? 'w-16 h-16 rounded-full border-2 border-sky-300 bg-sky-50/70 flex items-center justify-center overflow-hidden'
          : 'w-16 h-16 rounded-full border-2 border-slate-300 bg-slate-100 flex items-center justify-center overflow-hidden';

      const safePortrait = person.photoUrl ? safeImageUrl(person.photoUrl) : '';
      if (safePortrait) {
        avatarImg.src = safePortrait;
        avatarImg.classList.remove('hidden');
        avatarSvg.classList.add('hidden');
      } else {
        avatarImg.removeAttribute('src');
        avatarImg.classList.add('hidden');
        avatarSvg.classList.remove('hidden');
        avatarSvg.innerHTML = getSilhouetteSvgInner(person.sex);
      }

      document.getElementById('inspector-person-name').textContent = getDisplayNameWithMaiden(person);

      const inspectorCorner = document.getElementById('inspector-deceased-corner');
      if (inspectorCorner) {
        const deceasedLabel = getDeceasedLabel(person);
        if (deceasedLabel) {
          inspectorCorner.classList.remove('hidden');
          inspectorCorner.setAttribute('title', deceasedLabel);
          inspectorCorner.setAttribute('aria-label', deceasedLabel);
        } else {
          inspectorCorner.classList.add('hidden');
          inspectorCorner.removeAttribute('title');
          inspectorCorner.removeAttribute('aria-label');
        }
      }

      const kinshipLabelEl = document.getElementById('inspector-kinship-label');
      const centralId = appState.centralPersonId;
      if (centralId && centralId === person.id) {
        kinshipLabelEl.textContent = 'This is you';
      } else if (centralId && appState.persons[centralId]) {
        const kin = computeKinship(centralId, person.id);
        kinshipLabelEl.textContent = kin ? `Your ${kin.title.toLowerCase()}` : 'Extended relative';
      } else {
        const genNum = (generations[person.id] ?? 0) + 1;
        kinshipLabelEl.textContent = `Generation ${toRomanNumeral(genNum)}`;
      }

      document.getElementById('inspector-vital-text').textContent = getHeaderVitalLine(person);

      const body = document.getElementById('inspector-body');
      const editable = canEditTree();

      // -------------------------------------------------------------------
      // VIEW 1: PROFILE EXTENSION SHEET (Accordion Sheet)
      // -------------------------------------------------------------------
      if (uiState.inspectorTab === 'profile') {
        const mediaItems = person.media || [];
        const emails = person.emails || [];
        const permissions = appState.accessControl?.permissions || [];

        const parents = [];
        const spouses = [];
        const children = [];
        const spouseUnions = [];

        Object.values(appState.families).forEach(f => {
          const selfChild = (f.children || []).find(c => c.personId === person.id);
          if (selfChild) {
            const linkage = normalizeLinkage(selfChild.linkage);
            const role = parentRoleLabel(linkage);
            if (f.partner1Id && appState.persons[f.partner1Id]) {
              parents.push({ person: appState.persons[f.partner1Id], role, kind: 'parent', famId: f.id, linkage });
            }
            if (f.partner2Id && appState.persons[f.partner2Id]) {
              parents.push({ person: appState.persons[f.partner2Id], role, kind: 'parent', famId: f.id, linkage });
            }
          }
          if (f.partner1Id === person.id || f.partner2Id === person.id) {
            const spId = f.partner1Id === person.id ? f.partner2Id : f.partner1Id;
            const spPerson = spId && appState.persons[spId] ? appState.persons[spId] : null;
            const unionStatus = f.status === 'divorced' ? 'divorced' : 'married';
            if (spPerson) {
              spouses.push({
                person: spPerson,
                role: unionStatus === 'divorced' ? 'Former spouse' : 'Spouse',
                kind: 'spouse',
                famId: f.id,
                status: unionStatus
              });
            }
            spouseUnions.push({ fam: f, spouse: spPerson });
            (f.children || []).forEach(c => {
              if (appState.persons[c.personId]) {
                const linkage = normalizeLinkage(c.linkage);
                children.push({
                  person: appState.persons[c.personId],
                  role: childRoleLabel(linkage),
                  kind: 'child',
                  famId: f.id,
                  linkage
                });
              }
            });
          }
        });

        const birthEvent = (person.events || []).find(e => e.type === 'BIRT');
        const birthDateStr = birthEvent ? birthEvent.date : '';
        const EVENT_LABELS = {
          BIRT: 'Birth',
          DEAT: 'Death',
          ADOP: 'Adoption',
          RESI: 'Residence',
          OCCU: 'Occupation',
          EDUC: 'Education',
          BURI: 'Burial',
          EVEN: 'Life Event'
        };

        const timelineEntries = [];
        (person.events || []).forEach(ev => {
          const parsed = parseFlexibleDateParts(ev.date);
          const yearStr = parsed?.year ? String(parsed.year) : '—';
          const ageVal = (ev.type !== 'BIRT' && birthDateStr && ev.date) ? computeAgeYears(birthDateStr, ev.date) : null;
          timelineEntries.push({
            kind: 'event',
            id: ev.id,
            sortYear: parsed?.year || 9999,
            yearLabel: yearStr,
            ageLabel: ageVal !== null ? `Age ${ageVal}` : '',
            title: EVENT_LABELS[ev.type] || ev.type || 'Event',
            dateRaw: ev.date || '',
            dateFormatted: ev.date ? formatDisplayDate(ev.date, 'long') : 'Date unrecorded',
            place: ev.place || '',
            spouse: null
          });
        });

        spouseUnions.forEach(({ fam, spouse }) => {
          const parsed = parseFlexibleDateParts(fam.marriageDate);
          const yearStr = parsed?.year ? String(parsed.year) : '—';
          const ageVal = (birthDateStr && fam.marriageDate) ? computeAgeYears(birthDateStr, fam.marriageDate) : null;
          timelineEntries.push({
            kind: 'marriage',
            id: fam.id,
            sortYear: parsed?.year || 9998,
            yearLabel: yearStr,
            ageLabel: ageVal !== null ? `Age ${ageVal}` : '',
            title: fam.status === 'divorced' ? 'Divorce / Union:' : 'Marriage to:',
            dateRaw: fam.marriageDate || '',
            dateFormatted: fam.marriageDate ? formatDisplayDate(fam.marriageDate, 'short') : '',
            place: fam.marriagePlace || '',
            unionStatus: fam.status === 'divorced' ? 'divorced' : 'married',
            spouse
          });
        });

        timelineEntries.sort((a, b) => a.sortYear - b.sortYear);
        const immediateCount = parents.length + spouses.length + children.length;

        body.innerHTML = `
          <div class="divide-y divide-stone-200">

            <!-- 1. PHOTOS & VIDEOS ACCORDION ROW -->
            <div>
              <div class="px-4 py-3.5 flex items-center justify-between">
                <button type="button" data-toggle-accordion="photos" class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-600 hover:text-slate-900">
                  <span>PHOTOS &amp; VIDEOS${mediaItems.length > 0 ? ` (${mediaItems.length})` : ''}</span>
                  <span class="text-xs">${uiState.accordions.photos ? '⌃' : '⌄'}</span>
                </button>
                ${editable ? `<button type="button" id="btn-accordion-add-photo" class="text-xs font-semibold text-orange-700 hover:text-orange-900">+ Add</button>` : ''}
              </div>

              ${(uiState.accordions.photos || uiState.showPhotoAddForm) ? `
                <div class="px-4 pb-4 space-y-2.5">
                  ${uiState.showPhotoAddForm && editable ? `
                    <form id="form-add-person-photo" class="p-3 rounded-xl bg-stone-50 border border-stone-200 space-y-2">
                      <input type="url" name="photoUrl" required placeholder="https://example.com/portrait.jpg" title="https:// links only" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                      <input type="text" name="caption" placeholder="Caption (e.g., Wedding Portrait 2007)" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                      <label class="flex items-center gap-1.5 text-[11px] text-slate-700">
                        <input type="checkbox" name="setAsAvatar" checked />
                        <span>Set as primary profile portrait</span>
                      </label>
                      <div class="flex justify-end gap-1.5">
                        <button type="button" id="btn-cancel-photo-form" class="px-2.5 py-1 text-xs text-slate-600">Cancel</button>
                        <button type="submit" class="px-3 py-1 rounded-lg bg-archival-indigo text-white text-xs font-semibold">Save Photo</button>
                      </div>
                    </form>
                  ` : ''}

                  ${(!redacted && isBlockedImageUrl(person.photoUrl)) || mediaItems.some(m => isBlockedImageUrl(m.url)) ? `
                    <p class="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed" role="status">${escapeHtml(
                      describeBlockedImageUrl(isBlockedImageUrl(person.photoUrl) ? person.photoUrl : (mediaItems.find(m => isBlockedImageUrl(m.url)) || {}).url)
                    )}</p>
                  ` : ''}
                  ${mediaItems.length > 0 ? `
                    <div class="grid grid-cols-3 gap-2">
                      ${mediaItems.map(m => {
                        const src = safeImageUrl(m.url);
                        const blocked = isBlockedImageUrl(m.url);
                        return `
                        <div class="group relative rounded-xl overflow-hidden border ${blocked ? 'border-amber-300' : 'border-stone-200'} aspect-square bg-stone-100">
                          ${src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(m.caption || '')}" class="w-full h-full object-cover" />` : `<div class="w-full h-full flex items-center justify-center text-[10px] text-amber-900 px-1 text-center">${blocked ? 'https only — not shown' : 'No image'}</div>`}
                          ${editable ? `<button type="button" data-delete-media="${escapeAttr(m.id)}" aria-label="Delete photo" class="touch-visible flex sm:hidden sm:group-hover:flex sm:group-focus-within:flex absolute top-1 right-1 w-6 h-6 rounded-full bg-slate-900/75 text-white text-[10px] items-center justify-center">✕</button>` : ''}
                        </div>
                      `;
                      }).join('')}
                    </div>
                  ` : (!uiState.showPhotoAddForm ? `<p class="text-xs text-stone-500 italic">No photos or videos linked yet.</p>` : '')}
                </div>
              ` : ''}
            </div>

            <!-- 2. BIOGRAPHY ACCORDION ROW -->
            <div>
              <div class="px-4 py-3.5 flex items-center justify-between">
                <button type="button" data-toggle-accordion="bio" class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-600 hover:text-slate-900">
                  <span>BIOGRAPHY</span>
                  <span class="text-xs">${uiState.accordions.bio ? '⌃' : '⌄'}</span>
                </button>
                ${editable ? `<button type="button" id="btn-accordion-add-bio" class="text-xs font-semibold text-orange-700 hover:text-orange-900">+ Add</button>` : ''}
              </div>

              ${uiState.accordions.bio ? `
                <div class="px-4 pb-4 text-xs text-slate-700 leading-relaxed">
                  ${person.bio
                    ? `<p class="whitespace-pre-line bg-stone-50 p-3 rounded-xl border border-stone-200">${escapeHtml(person.bio)}</p>`
                    : `<p class="text-stone-500 italic">No biography written yet. Click + Add to record their life story.</p>`
                  }
                </div>
              ` : ''}
            </div>

            <!-- 3. IMMEDIATE FAMILY ACCORDION ROW -->
            <div>
              <div class="px-4 py-3.5 flex items-center justify-between">
                <button type="button" data-toggle-accordion="family" class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-600 hover:text-slate-900">
                  <span>IMMEDIATE FAMILY${immediateCount > 0 ? ` (${immediateCount})` : ''}</span>
                  <span class="text-xs">${uiState.accordions.family ? '⌃' : '⌄'}</span>
                </button>
                ${editable ? `<button type="button" id="btn-accordion-add-family" class="text-xs font-semibold text-orange-700 hover:text-orange-900">+ Add</button>` : ''}
              </div>

              ${uiState.accordions.family ? `
                <div class="px-4 pb-4 space-y-1.5">
                  ${[...parents, ...spouses, ...children].map(item => `
                    <div class="relative flex items-center gap-2 p-2 rounded-xl border border-stone-200/80 bg-white">
                      ${deceasedCornerHtml(item.person)}
                      <button type="button" data-search-pick="${escapeAttr(item.person.id)}" class="flex-1 min-w-0 flex items-center justify-between gap-2.5 text-left hover:bg-stone-50 rounded-lg px-0.5 py-0.5 transition">
                        <div class="flex items-center gap-2.5 min-w-0">
                          <span class="w-8 h-8 rounded-full border ${item.person.sex === 'F' ? 'border-rose-200 bg-rose-50/70' : 'border-sky-200 bg-sky-50/70'} flex items-center justify-center text-slate-400 shrink-0 overflow-hidden">
                            ${safeImageUrl(item.person.photoUrl)
                              ? `<img src="${escapeAttr(safeImageUrl(item.person.photoUrl))}" alt="" class="w-full h-full object-cover" />`
                              : `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">${getSilhouetteSvgInner(item.person.sex)}</svg>`
                            }
                          </span>
                          <div class="min-w-0">
                            <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(getDisplayNameWithMaiden(item.person))}</div>
                            <div class="text-[11px] text-slate-500">${escapeHtml(item.role)} · ${escapeHtml(getCardLifespanLabel(item.person))}</div>
                          </div>
                        </div>
                        <span class="text-slate-400 text-xs">›</span>
                      </button>
                      ${editable && (item.kind === 'child' || item.kind === 'parent') ? `
                        <select data-set-child-linkage="${escapeAttr(item.famId)}" data-set-child-id="${escapeAttr(item.kind === 'child' ? item.person.id : person.id)}" aria-label="Parent link type for ${escapeAttr(getDisplayName(item.kind === 'child' ? item.person : person))}" class="shrink-0 max-w-[7.5rem] px-1.5 py-1 text-[11px] bg-white border border-stone-300 rounded-lg">
                          <option value="biological" ${item.linkage === 'biological' ? 'selected' : ''}>Biological</option>
                          <option value="adoptive" ${item.linkage === 'adoptive' ? 'selected' : ''}>Adopted</option>
                          <option value="step" ${item.linkage === 'step' ? 'selected' : ''}>Step</option>
                        </select>
                      ` : ''}
                      ${editable && item.kind === 'spouse' ? `
                        <select data-set-union-status="${escapeAttr(item.famId)}" aria-label="Union status with ${escapeAttr(getDisplayName(item.person))}" class="shrink-0 max-w-[7.5rem] px-1.5 py-1 text-[11px] bg-white border border-stone-300 rounded-lg">
                          <option value="married" ${item.status === 'married' ? 'selected' : ''}>Married</option>
                          <option value="divorced" ${item.status === 'divorced' ? 'selected' : ''}>Divorced</option>
                        </select>
                      ` : ''}
                    </div>
                  `).join('') || `<p class="text-xs text-stone-500 italic">No parents, spouses, or children linked yet.</p>`}
                </div>
              ` : ''}
            </div>

            <!-- 4. FACTS CHRONOLOGICAL TIMELINE ACCORDION ROW (EXPANDED BY DEFAULT) -->
            <div>
              <div class="px-4 py-3.5 flex items-center justify-between">
                <button type="button" data-toggle-accordion="facts" class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-600 hover:text-slate-900">
                  <span>FACTS</span>
                  <span class="text-xs">${uiState.accordions.facts ? '⌃' : '⌄'}</span>
                </button>
                ${editable ? `<button type="button" id="btn-accordion-add-fact" class="text-xs font-semibold text-orange-700 hover:text-orange-900">+ Add</button>` : ''}
              </div>

              ${uiState.accordions.facts ? `
                <div class="px-4 pb-5 space-y-4">
                  ${uiState.showFactAddForm && editable ? `
                    <form id="form-add-event" class="p-3 rounded-xl bg-stone-50 border border-stone-200 space-y-2">
                      <div class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Add Life Fact</div>
                      <div class="grid grid-cols-2 gap-2">
                        <select name="evType" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                          <option value="BIRT">Birth</option>
                          <option value="DEAT">Death</option>
                          <option value="RESI">Residence</option>
                          <option value="OCCU">Occupation</option>
                          <option value="EDUC">Education</option>
                          <option value="ADOP">Adoption</option>
                        </select>
                        <input name="evDate" type="text" placeholder="July 4 1977" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                      </div>
                      <input name="evPlace" type="text" placeholder="Place (e.g., Springfield)" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                      <div class="flex justify-end gap-1.5">
                        <button type="button" id="btn-cancel-fact-form" class="px-2.5 py-1 text-xs text-slate-600">Cancel</button>
                        <button type="submit" class="px-3 py-1 rounded-lg bg-archival-indigo text-white text-xs font-semibold">Save Fact</button>
                      </div>
                    </form>
                  ` : ''}

                  ${timelineEntries.length === 0 ? `
                    <p class="text-xs text-stone-500 italic">No birth, marriage, or life facts recorded yet. Click <strong>+ Add</strong> above.</p>
                  ` : `
                    <div class="space-y-4 pt-1">
                      ${timelineEntries.map(item => {
                        const isEditingThis = uiState.editingFactItem && uiState.editingFactItem.kind === item.kind && uiState.editingFactItem.id === item.id;
                        return `
                          <div class="space-y-2">
                            <div class="flex items-start gap-4 group">
                              <!-- Left Year & Age Column -->
                              <div class="w-14 shrink-0 text-left">
                                <div class="text-sm font-semibold text-slate-900 leading-tight">${escapeHtml(item.yearLabel)}</div>
                                ${item.ageLabel ? `<div class="text-[11px] text-stone-500 mt-0.5">${escapeHtml(item.ageLabel)}</div>` : ''}
                              </div>

                              <!-- Center Fact Details -->
                              <div class="flex-1 min-w-0 space-y-1">
                                <div class="text-xs font-bold text-slate-900">${escapeHtml(item.title)}</div>

                                ${item.spouse ? `
                                  <button type="button" data-search-pick="${escapeAttr(item.spouse.id)}" class="flex items-center gap-2 py-0.5 text-left group/sp">
                                    <span class="w-7 h-7 rounded-full border ${item.spouse.sex === 'F' ? 'border-rose-200 bg-rose-50/70' : 'border-sky-200 bg-sky-50/70'} flex items-center justify-center text-slate-400 shrink-0 overflow-hidden">
                                      ${safeImageUrl(item.spouse.photoUrl)
                                        ? `<img src="${escapeAttr(safeImageUrl(item.spouse.photoUrl))}" alt="" class="w-full h-full object-cover" />`
                                        : `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">${getSilhouetteSvgInner(item.spouse.sex)}</svg>`
                                      }
                                    </span>
                                    <span class="text-xs font-semibold text-slate-900 group-hover/sp:text-archival-indigo group-hover/sp:underline leading-snug">
                                      ${escapeHtml(getDisplayNameWithMaiden(item.spouse))}
                                    </span>
                                  </button>
                                ` : ''}

                                ${item.dateFormatted ? `<div class="text-xs text-slate-600">${escapeHtml(item.dateFormatted)}</div>` : ''}
                                ${item.place ? `<div class="text-xs text-slate-600">${escapeHtml(item.place)}</div>` : ''}
                              </div>

                              <!-- Right Circular Edit Pencil Button -->
                              ${editable ? `
                                <button
                                  type="button"
                                  data-edit-fact-kind="${escapeAttr(item.kind)}"
                                  data-edit-fact-id="${escapeAttr(item.id)}"
                                  title="Edit Fact Date or Place"
                                  class="w-9 h-9 rounded-full border border-stone-200 bg-white hover:bg-stone-100 text-slate-600 flex items-center justify-center shrink-0 shadow-2xs transition"
                                >
                                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
                                  </svg>
                                </button>
                              ` : ''}
                            </div>

                            ${isEditingThis && editable ? `
                              <form data-save-fact-kind="${escapeAttr(item.kind)}" data-save-fact-id="${escapeAttr(item.id)}" class="p-3 rounded-xl bg-stone-50 border border-stone-200 space-y-2 ml-14">
                                <div class="grid grid-cols-2 gap-2">
                                  <input name="factDate" type="text" value="${escapeAttr(item.dateRaw)}" placeholder="Date (e.g. July 4 1977)" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                                  <input name="factPlace" type="text" value="${escapeAttr(item.place)}" placeholder="Place (e.g. Springfield)" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                                </div>
                                ${item.kind === 'marriage' ? `
                                  <label class="block text-[11px] font-medium text-slate-700">Union status
                                    <select name="unionStatus" class="mt-1 w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                                      <option value="married" ${item.unionStatus === 'divorced' ? '' : 'selected'}>Married</option>
                                      <option value="divorced" ${item.unionStatus === 'divorced' ? 'selected' : ''}>Divorced</option>
                                    </select>
                                  </label>
                                ` : ''}
                                <div class="flex items-center justify-between">
                                  ${item.kind === 'event' ? `<button type="button" data-delete-event="${escapeAttr(item.id)}" class="text-[11px] font-semibold text-rose-700 hover:underline">Delete Fact</button>` : `<span></span>`}
                                  <div class="flex gap-1.5">
                                    <button type="button" id="btn-cancel-inline-fact" class="px-2.5 py-1 text-xs text-slate-600">Cancel</button>
                                    <button type="submit" class="px-3 py-1 rounded-lg bg-archival-indigo text-white text-xs font-semibold">Save</button>
                                  </div>
                                </div>
                              </form>
                            ` : ''}
                          </div>
                        `;
                      }).join('')}
                    </div>
                  `}
                </div>
              ` : ''}
            </div>

            <!-- 5. GOOGLE ACCOUNT & EMAIL ACCESS SECTION -->
            <div class="p-4 bg-stone-50/70 space-y-2.5">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-bold uppercase tracking-wider text-stone-600">Google User Access (${emails.length})</span>
                ${canAccessAdminPanel() ? `<a href="/admin.html" class="text-[11px] font-semibold text-archival-indigo hover:underline">Admin Panel →</a>` : ''}
              </div>

              ${emails.length > 0 ? `
                <div class="space-y-1.5">
                  ${emails.map(em => {
                    const isSuper = isSuperAdminEmail(em);
                    const perm = permissions.find(pm => pm.email.toLowerCase() === em.toLowerCase());
                    const effectiveRole = isSuper ? 'super_admin' : (perm ? perm.role : '');
                    const roleLabel = isSuper ? 'Super Admin' : effectiveRole === 'edit' || effectiveRole === 'admin' ? 'Edit' : effectiveRole === 'view' ? 'View' : 'Email only (no sign-in yet)';
                    const badgeClass = isSuper
                      ? 'bg-amber-100 text-amber-900'
                      : (effectiveRole === 'edit' || effectiveRole === 'admin')
                        ? 'bg-emerald-100 text-emerald-800'
                        : effectiveRole === 'view'
                          ? 'bg-indigo-100 text-archival-indigo'
                          : 'bg-slate-100 text-slate-600';
                    const badgeHtml = isSuper
                      ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${badgeClass}">Super Admin</span>`
                      : canManageAccess()
                        ? `<button type="button" data-toggle-email-role="${escapeAttr(em)}" title="Switch between Edit and View Access" class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase transition ${effectiveRole === 'edit' || effectiveRole === 'admin' ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' : 'bg-indigo-100 text-archival-indigo hover:bg-indigo-200'}">${effectiveRole === 'edit' || effectiveRole === 'admin' ? 'Edit ↻' : (effectiveRole === 'view' ? 'View ↻' : 'Grant View ↻')}</button>`
                        : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${badgeClass}">${escapeHtml(roleLabel)}</span>`;
                    return `
                      <div class="flex items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-stone-200 text-xs">
                        <span class="font-medium text-slate-800 truncate">${escapeHtml(em)}</span>
                        <div class="flex items-center gap-1.5 shrink-0">
                          ${badgeHtml}
                          ${(editable && !isSuper) ? `<button type="button" data-remove-person-email="${escapeAttr(em)}" class="text-slate-400 hover:text-rose-600 px-1">✕</button>` : ''}
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
              ` : `<div class="text-[11px] text-stone-500 italic">No Google email linked yet.</div>`}

              ${editable ? `
                <form id="form-add-person-email" class="flex items-center gap-1.5 pt-1">
                  <input type="email" name="newEmail" required placeholder="relative@example.com" class="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                  ${canManageAccess() ? `
                    <select name="emailRole" aria-label="Access Level" class="px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg font-medium text-slate-700 shrink-0">
                      <option value="view" selected>View</option>
                      <option value="edit">Edit</option>
                    </select>
                  ` : ''}
                  <button type="submit" class="px-2.5 py-1.5 rounded-lg bg-archival-indigo hover:bg-archival-indigoHover text-white text-xs font-semibold transition shrink-0">+ Add</button>
                </form>
                <p class="text-[11px] text-slate-500 leading-relaxed">${canManageAccess() ? 'New emails are granted View access unless you choose Edit. Only you, the Super Admin, can change who may sign in.' : 'This stores the email on the person. Only the Super Admin can grant sign-in access (View or Edit).'}</p>
              ` : ''}
            </div>

          </div>
        `;
        return;
      }

      // -------------------------------------------------------------------
      // VIEW 2: EDIT IDENTITY, PORTRAIT & BIOGRAPHY
      // -------------------------------------------------------------------
      if (uiState.inspectorTab === 'edit') {
        body.innerHTML = `
          <div class="p-4 space-y-4">
            <form id="form-edit-person-profile" class="space-y-3 bg-stone-50 p-3.5 rounded-2xl border border-stone-200">
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Edit Identity &amp; Biography</div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Given Name</label>
                  <input name="given" type="text" value="${escapeAttr(person.given || '')}" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                </div>
                <div>
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Surname</label>
                  <input name="surname" type="text" value="${escapeAttr(person.surname || '')}" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Maiden / Birth Surname</label>
                  <input name="altName" type="text" placeholder="e.g. Lee" value="${escapeAttr(person.altName || '')}" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                </div>
                <div>
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Sex</label>
                  <select name="sex" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                    <option value="M" ${person.sex === 'M' ? 'selected' : ''}>Male (M)</option>
                    <option value="F" ${person.sex === 'F' ? 'selected' : ''}>Female (F)</option>
                    <option value="U" ${person.sex === 'U' ? 'selected' : ''}>Unknown (U)</option>
                  </select>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Living Status</label>
                  <select name="livingStatus" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                    <option value="living" ${person.livingStatus === 'living' ? 'selected' : ''}>Living</option>
                    <option value="deceased" ${person.livingStatus === 'deceased' ? 'selected' : ''}>Deceased</option>
                    <option value="unknown" ${person.livingStatus === 'unknown' ? 'selected' : ''}>Unknown</option>
                  </select>
                </div>
                <div>
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Portrait Photo URL</label>
                  <input name="photoUrl" type="url" placeholder="https://..." value="${escapeAttr(person.photoUrl || '')}" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                  ${isBlockedImageUrl(person.photoUrl) ? `<p class="text-[11px] text-amber-900 leading-relaxed">${escapeHtml(describeBlockedImageUrl(person.photoUrl))}</p>` : ''}
                </div>
              </div>

              <div>
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Biography</label>
                <textarea name="bio" rows="3" ${editable ? '' : 'disabled'} class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">${escapeHtml(person.bio || '')}</textarea>
              </div>

              ${editable ? `<button type="submit" class="w-full py-2 rounded-xl bg-archival-indigo hover:bg-archival-indigoHover text-white text-xs font-semibold shadow-2xs transition">Save Profile &amp; Return to Sheet</button>` : ''}
            </form>
          </div>
        `;
        return;
      }

      // -------------------------------------------------------------------
      // VIEW 3: ADD RELATIVES & PROVISION MARRIAGE / ADOPTION
      // -------------------------------------------------------------------
      if (uiState.inspectorTab === 'add') {
        const otherPeople = Object.values(appState.persons).filter(op => op.id !== person.id);
        const allFamiliesArr = Object.values(appState.families);

        body.innerHTML = `
          <div class="p-4 space-y-4">
            ${editable ? `
              <div class="bg-stone-50 p-3.5 rounded-2xl border border-stone-200 space-y-2">
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Create New Relative</div>
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" data-quick-rel="parent" class="py-2 px-2.5 rounded-xl bg-white hover:bg-stone-100 border border-stone-300 text-xs font-semibold text-slate-800 transition">+ New Parent</button>
                  <button type="button" data-quick-rel="spouse" class="py-2 px-2.5 rounded-xl bg-white hover:bg-stone-100 border border-stone-300 text-xs font-semibold text-slate-800 transition">+ New Spouse</button>
                  <button type="button" data-quick-rel="child" class="py-2 px-2.5 rounded-xl bg-white hover:bg-stone-100 border border-stone-300 text-xs font-semibold text-slate-800 transition">+ New Child</button>
                  <button type="button" data-quick-rel="sibling" class="py-2 px-2.5 rounded-xl bg-white hover:bg-stone-100 border border-stone-300 text-xs font-semibold text-slate-800 transition">+ New Sibling</button>
                </div>
              </div>

              ${otherPeople.length > 0 ? `
                <form id="form-provision-link" class="bg-indigo-50/50 p-3.5 rounded-2xl border border-indigo-200 space-y-2.5">
                  <div class="text-[11px] font-bold uppercase tracking-wider text-archival-indigo">Provision Marriage or Adoption Link</div>
                  <p class="text-[11px] text-slate-600">Connect existing individuals across branches for marriage or adoption without duplicating records.</p>

                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Link Action</label>
                    <select id="prov-link-type" name="linkType" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                      <option value="marriage">Marriage / Partnership with Existing Person</option>
                      <option value="adopt_child">Adopt Existing Person as Child</option>
                      <option value="step_child">Add Existing Person as Stepchild</option>
                      ${allFamiliesArr.length > 0 ? `<option value="adoptive_parents">Assign Adoptive Parents to This Person</option>` : ''}
                      ${allFamiliesArr.length > 0 ? `<option value="step_parents">Assign Step-Parents to This Person</option>` : ''}
                    </select>
                  </div>

                  <div id="prov-target-person-wrap">
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Select Existing Person in Tree</label>
                    <select name="targetPersonId" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                      ${otherPeople.map(op => `<option value="${escapeAttr(op.id)}">${escapeHtml(getDisplayName(op))}</option>`).join('')}
                    </select>
                  </div>

                  <div id="prov-adoptive-fam-wrap" class="hidden">
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Select Adoptive Couple / Family Unit</label>
                    <select name="targetFamilyId" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                      ${allFamiliesArr.map(f => {
                        const p1 = f.partner1Id && appState.persons[f.partner1Id] ? getDisplayName(appState.persons[f.partner1Id]) : null;
                        const p2 = f.partner2Id && appState.persons[f.partner2Id] ? getDisplayName(appState.persons[f.partner2Id]) : null;
                        const label = [p1, p2].filter(Boolean).join(' & ') || `Family (${f.id})`;
                        return `<option value="${escapeAttr(f.id)}">${escapeHtml(label)}</option>`;
                      }).join('')}
                    </select>
                  </div>

                  <div id="prov-marriage-meta-wrap" class="grid grid-cols-2 gap-2">
                    <input name="marriageDate" placeholder="June 12 1985" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                    <input name="marriagePlace" placeholder="Marriage Place (opt)" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                  </div>

                  <button type="submit" class="w-full py-2 rounded-xl bg-archival-indigo hover:bg-archival-indigoHover text-white text-xs font-semibold shadow-2xs transition">Provision Link</button>
                </form>
              ` : ''}
            ` : `<div class="text-xs text-slate-500">View Access Only: Switch to an Editor account to add relatives.</div>`}
          </div>
        `;
        return;
      }

      // -------------------------------------------------------------------
      // VIEW 4: EVIDENCE & CITATIONS (opened from the profile More menu)
      // -------------------------------------------------------------------
      const assertions = person.assertions || [];
      body.innerHTML = `
        <div class="p-4 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Research Claims &amp; Citations (${assertions.length})</span>
            <div class="flex items-center gap-2">
              ${editable ? `<button type="button" id="btn-toggle-add-assertion" class="text-xs font-semibold text-orange-700 hover:text-orange-900">+ Add Claim</button>` : ''}
              <button type="button" id="btn-back-to-profile-sheet" class="text-xs font-semibold text-archival-indigo hover:underline">← Profile</button>
            </div>
          </div>

          ${uiState.showAssertionAddForm && editable ? `
            <form id="form-add-assertion" class="p-3 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
              <div class="grid grid-cols-2 gap-2">
                <select name="factType" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                  <option value="BIRT">Birth Claim</option>
                  <option value="DEAT">Death Claim</option>
                  <option value="MARR">Marriage Claim</option>
                  <option value="RESI">Residence Claim</option>
                  <option value="EVEN">General Fact</option>
                </select>
                <select name="status" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
                  <option value="accepted">Accepted</option>
                  <option value="competing">Competing / Unverified</option>
                </select>
              </div>
              <input name="value" required type="text" placeholder="Claimed Date & Place (e.g., July 4 1977 · Springfield)" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
              <div class="grid grid-cols-2 gap-2">
                <input name="sourceTitle" required type="text" placeholder="Source Title (e.g., Civil Registry)" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                <input name="locator" type="text" placeholder="Page / Folio / Certificate #" class="px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
              </div>
              <textarea name="transcription" rows="2" placeholder="Verbatim source extract or notes..." class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg"></textarea>
              <div class="flex justify-end gap-1.5">
                <button type="button" id="btn-cancel-assertion-form" class="px-2.5 py-1 text-xs text-slate-600">Cancel</button>
                <button type="submit" class="px-3 py-1 rounded-lg bg-archival-indigo text-white text-xs font-semibold">Save Citation</button>
              </div>
            </form>
          ` : ''}

          ${assertions.length === 0 ? `
            <p class="text-xs text-stone-500 italic py-2">No source citations or competing research claims attached to this individual yet.</p>
          ` : assertions.map(a => {
            const isAcc = a.status === 'accepted';
            return `
              <div class="p-3 rounded-xl border ${isAcc ? 'border-emerald-300 bg-emerald-50/40' : 'border-amber-300 bg-amber-50/40'} space-y-1.5 text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-slate-900">${escapeHtml(a.factType || 'FACT')}: ${escapeHtml(a.value || '')}</span>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${isAcc ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}">${isAcc ? 'Accepted' : 'Competing'}</span>
                </div>
                <div class="text-[11px] text-slate-700">
                  <strong>Source:</strong> ${escapeHtml(a.sourceTitle || 'Archival Record')} ${a.locator ? `· <span>${escapeHtml(a.locator)}</span>` : ''}
                </div>
                ${a.transcription ? `<div class="text-[11px] italic text-slate-600 bg-white/80 p-2 rounded-lg border border-stone-200">"${escapeHtml(a.transcription)}"</div>` : ''}
                ${editable ? `
                  <div class="flex items-center justify-end gap-2 pt-1">
                    ${!isAcc ? `<button type="button" data-accept-assertion="${escapeAttr(a.id)}" class="text-[11px] font-semibold text-emerald-800 hover:underline">✓ Mark Accepted</button>` : ''}
                    <button type="button" data-delete-assertion="${escapeAttr(a.id)}" class="text-[11px] text-rose-700 hover:underline">Delete</button>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    /* =====================================================================
     * 10. RELATIVE CREATION & KINSHIP PATHFINDER
     * ===================================================================== */
    function addNewRelativeToPerson(anchorId, relType) {
      const anchor = appState.persons[anchorId];
      if (!anchor) return;
      // In focus view, open the anchor's branch so the new relative is visible.
      if (uiState.focusMode) setFocusPerson(anchorId, { render: false });
      const anchorName = getDisplayName(anchor);
      let createdId = null;

      commitMutation(`Added ${relType} to ${anchorName}`, (state) => {
        const newId = generateId('p');
        createdId = newId;
        const defaultSurname = anchor.surname || 'Family';

        if (relType === 'parent') {
          let parentFam = Object.values(state.families).find(f => (f.children || []).some(c => c.personId === anchorId));
          const isSecondParent = Boolean(parentFam && parentFam.partner1Id && !parentFam.partner2Id);
          state.persons[newId] = {
            id: newId,
            given: isSecondParent ? 'Mother' : 'Father',
            surname: defaultSurname,
            altName: '',
            sex: isSecondParent ? 'F' : 'M',
            livingStatus: 'deceased',
            emails: [],
            photoUrl: '',
            media: [],
            bio: '',
            events: [],
            assertions: [],
            customTags: []
          };
          if (parentFam && (!parentFam.partner1Id || !parentFam.partner2Id)) {
            if (!parentFam.partner1Id) parentFam.partner1Id = newId;
            else parentFam.partner2Id = newId;
          } else {
            const famId = generateId('f');
            state.families[famId] = {
              id: famId,
              partner1Id: newId,
              partner2Id: null,
              marriageDate: '',
              marriagePlace: '',
              status: 'married',
              children: [{ personId: anchorId, linkage: 'biological' }]
            };
          }
        } else if (relType === 'spouse') {
          state.persons[newId] = {
            id: newId,
            given: 'Partner',
            surname: defaultSurname,
            altName: '',
            sex: anchor.sex === 'M' ? 'F' : anchor.sex === 'F' ? 'M' : 'U',
            livingStatus: anchor.livingStatus || 'living',
            emails: [],
            photoUrl: '',
            media: [],
            bio: '',
            events: [],
            assertions: [],
            customTags: []
          };
          const openFam = Object.values(state.families).find(f =>
            (f.partner1Id === anchorId && !f.partner2Id) ||
            (f.partner2Id === anchorId && !f.partner1Id)
          );
          if (openFam) {
            if (!openFam.partner1Id) openFam.partner1Id = newId;
            else openFam.partner2Id = newId;
          } else {
            const famId = generateId('f');
            state.families[famId] = {
              id: famId,
              partner1Id: anchorId,
              partner2Id: newId,
              marriageDate: '',
              marriagePlace: '',
              status: 'married',
              children: []
            };
          }
        } else if (relType === 'child') {
          state.persons[newId] = {
            id: newId,
            given: 'Child',
            surname: defaultSurname,
            altName: '',
            sex: 'U',
            livingStatus: 'living',
            emails: [],
            photoUrl: '',
            media: [],
            bio: '',
            events: [],
            assertions: [],
            customTags: []
          };
          let fam = Object.values(state.families).find(f => f.partner1Id === anchorId || f.partner2Id === anchorId);
          if (!fam) {
            const famId = generateId('f');
            fam = { id: famId, partner1Id: anchorId, partner2Id: null, marriageDate: '', marriagePlace: '', status: 'married', children: [] };
            state.families[famId] = fam;
          }
          fam.children.push({ personId: newId, linkage: 'biological' });
        } else if (relType === 'sibling') {
          state.persons[newId] = {
            id: newId,
            given: 'Sibling',
            surname: defaultSurname,
            altName: '',
            sex: 'U',
            livingStatus: anchor.livingStatus || 'living',
            emails: [],
            photoUrl: '',
            media: [],
            bio: '',
            events: [],
            assertions: [],
            customTags: []
          };
          let parentFam = Object.values(state.families).find(f => (f.children || []).some(c => c.personId === anchorId));
          if (!parentFam) {
            const parentId = generateId('p');
            state.persons[parentId] = {
              id: parentId,
              given: 'Parent',
              surname: defaultSurname,
              altName: '',
              sex: 'U',
              livingStatus: 'deceased',
              emails: [],
              photoUrl: '',
              media: [],
              bio: '',
              events: [],
              assertions: [],
              customTags: []
            };
            const famId = generateId('f');
            parentFam = {
              id: famId,
              partner1Id: parentId,
              partner2Id: null,
              marriageDate: '',
              marriagePlace: '',
              status: 'married',
              children: [{ personId: anchorId, linkage: 'biological' }]
            };
            state.families[famId] = parentFam;
          }
          parentFam.children.push({ personId: newId, linkage: 'biological' });
        }

        state.selectedPersonId = newId;
      });

      if (createdId) {
        openInspector(createdId, 'edit');
      }
    }

    function normalizeLinkage(linkage) {
      return (linkage === 'adoptive' || linkage === 'step') ? linkage : 'biological';
    }

    function childRoleLabel(linkage) {
      if (linkage === 'adoptive') return 'Adopted child';
      if (linkage === 'step') return 'Stepchild';
      return 'Child';
    }

    function parentRoleLabel(linkage) {
      if (linkage === 'adoptive') return 'Adoptive parent';
      if (linkage === 'step') return 'Step-parent';
      return 'Parent';
    }

    function qualifyKinTitle(title, linkages) {
      const kinds = (linkages || []).filter(l => l === 'step' || l === 'adoptive');
      if (!kinds.length || !title) return title;
      const step = kinds.includes('step');
      const exact = step ? {
        Son: 'Stepson', Daughter: 'Stepdaughter', Child: 'Stepchild',
        Father: 'Stepfather', Mother: 'Stepmother', Parent: 'Step-parent',
        Brother: 'Stepbrother', Sister: 'Stepsister', Sibling: 'Stepsibling'
      } : {
        Son: 'Adopted son', Daughter: 'Adopted daughter', Child: 'Adopted child',
        Father: 'Adoptive father', Mother: 'Adoptive mother', Parent: 'Adoptive parent',
        Brother: 'Adopted brother', Sister: 'Adopted sister', Sibling: 'Adopted sibling'
      };
      if (exact[title]) return exact[title];
      if (title === 'Self' || title === 'Wife' || title === 'Husband' || title === 'Spouse' || /^In-Law/i.test(title)) return title;
      if (step) {
        if (/^(Great-)*Grand/i.test(title)) return 'Step-' + title[0].toLowerCase() + title.slice(1);
        return 'Step ' + title;
      }
      if (/Father|Mother|Parent|Uncle|Aunt/.test(title)) return 'Adoptive ' + title[0].toLowerCase() + title.slice(1);
      return 'Adopted ' + title[0].toLowerCase() + title.slice(1);
    }

    function computeKinship(fromId, toId) {
      if (!fromId || !toId || !appState.persons[fromId] || !appState.persons[toId]) return null;
      if (fromId === toId) {
        return { title: 'Self', pathIds: [fromId] };
      }

      const adj = {};
      Object.keys(appState.persons).forEach(id => { adj[id] = []; });

      Object.values(appState.families).forEach(f => {
        const p1 = f.partner1Id && appState.persons[f.partner1Id] ? f.partner1Id : null;
        const p2 = f.partner2Id && appState.persons[f.partner2Id] ? f.partner2Id : null;
        if (p1 && p2) {
          adj[p1].push({ to: p2, dir: 'spouse' });
          adj[p2].push({ to: p1, dir: 'spouse' });
        }
        (f.children || []).forEach(c => {
          if (!appState.persons[c.personId]) return;
          const linkage = normalizeLinkage(c.linkage);
          [p1, p2].filter(Boolean).forEach(pid => {
            adj[c.personId].push({ to: pid, dir: 'up', linkage });
            adj[pid].push({ to: c.personId, dir: 'down', linkage });
          });
        });
      });

      const queue = [[{ id: fromId, dir: null, linkage: null }]];
      const visited = new Set([fromId]);
      const linkRank = (l) => (l === 'step' ? 2 : l === 'adoptive' ? 1 : 0);

      while (queue.length > 0) {
        const path = queue.shift();
        const curr = path[path.length - 1];
        if (curr.id === toId) {
          const steps = path.slice(1);
          const dirs = steps.map(s => s.dir);
          const pcLinks = steps.filter(s => s.dir === 'up' || s.dir === 'down').map(s => s.linkage);
          const target = appState.persons[toId];
          const sex = target?.sex || 'U';
          let title = 'Extended Relative';

          if (dirs.length === 1 && dirs[0] === 'spouse') {
            title = sex === 'F' ? 'Wife' : sex === 'M' ? 'Husband' : 'Spouse';
          } else if (dirs.every(d => d === 'up')) {
            const n = dirs.length;
            const base = sex === 'F' ? 'Mother' : sex === 'M' ? 'Father' : 'Parent';
            title = n === 1 ? base : n === 2 ? `Grand${base.toLowerCase()}` : `${'Great-'.repeat(n - 2)}Grand${base.toLowerCase()}`;
          } else if (dirs.every(d => d === 'down')) {
            const n = dirs.length;
            const base = sex === 'F' ? 'Daughter' : sex === 'M' ? 'Son' : 'Child';
            title = n === 1 ? base : n === 2 ? `Grand${base.toLowerCase()}` : `${'Great-'.repeat(n - 2)}Grand${base.toLowerCase()}`;
          } else {
            const firstDown = dirs.indexOf('down');
            if (firstDown > 0 && dirs.slice(0, firstDown).every(d => d === 'up') && dirs.slice(firstDown).every(d => d === 'down')) {
              const u = firstDown;
              const d = dirs.length - firstDown;
              if (u === 1 && d === 1) {
                title = sex === 'F' ? 'Sister' : sex === 'M' ? 'Brother' : 'Sibling';
              } else if (u >= 2 && d === 1) {
                const base = sex === 'F' ? 'Aunt' : sex === 'M' ? 'Uncle' : 'Aunt/Uncle';
                title = u === 2 ? base : `${'Great-'.repeat(u - 2)}${base}`;
              } else if (u === 1 && d >= 2) {
                const base = sex === 'F' ? 'Niece' : sex === 'M' ? 'Nephew' : 'Niece/Nephew';
                title = d === 2 ? base : `${'Great-'.repeat(d - 2)}${base}`;
              } else {
                const deg = Math.min(u, d) - 1;
                const rem = Math.abs(u - d);
                const ord = ['1st', '2nd', '3rd', '4th', '5th'][deg - 1] || `${deg}th`;
                title = `${ord} Cousin${rem > 0 ? ` (${rem}x removed)` : ''}`;
              }
            } else if (dirs.includes('spouse')) {
              title = 'In-Law / Spouse Relative';
            }
          }

          title = qualifyKinTitle(title, pcLinks);
          return {
            title,
            pathIds: path.map(s => s.id)
          };
        }

        const edges = (adj[curr.id] || []).slice().sort((a, b) => linkRank(a.linkage) - linkRank(b.linkage));
        for (const edge of edges) {
          if (!visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push([...path, { id: edge.to, dir: edge.dir, linkage: edge.linkage || null }]);
          }
        }
      }
      return null;
    }

    /* =====================================================================
     * 11. EVENT LISTENERS & INITIALIZATION
     * ===================================================================== */

    const SEARCH_PAGE_SIZE = 10;
    let searchResultPage = 0;
    let lastSearchResults = [];
    let lastSearchQuery = '';

    function collectSearchFields(person) {
      const fields = [];
      const seen = new Set();
      const add = (field, text) => {
        const value = String(text || '').trim();
        if (!value) return;
        const key = field + '\0' + value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        fields.push({ field, text: value });
      };
      add('name', getDisplayName(person));
      add('altName', person.altName);
      (person.emails || []).forEach(email => add('email', email));
      add('notes', person.bio || person.notes);
      add('village', person.village);
      (person.events || []).forEach(ev => {
        add('place', ev.place);
        add('village', ev.village);
        add('year', ev.date);
        const parsed = ev.date && typeof parseFlexibleDateParts === 'function' ? parseFlexibleDateParts(ev.date) : null;
        if (parsed && parsed.year) add('year', String(parsed.year));
        add('notes', ev.notes || ev.note);
      });
      Object.values(appState.families || {}).forEach(fam => {
        if (!fam || (fam.partner1Id !== person.id && fam.partner2Id !== person.id)) return;
        add('place', fam.marriagePlace);
        add('village', fam.village);
        add('year', fam.marriageDate);
        const parsed = fam.marriageDate && typeof parseFlexibleDateParts === 'function' ? parseFlexibleDateParts(fam.marriageDate) : null;
        if (parsed && parsed.year) add('year', String(parsed.year));
      });
      return fields;
    }

    function searchPeople(query) {
      const needle = String(query || '').toLowerCase().trim();
      if (!needle) return [];
      const nameHits = [];
      const otherHits = [];
      Object.values(appState.persons || {}).forEach(person => {
        const fields = collectSearchFields(person);
        const hits = fields.filter(f => f.text.toLowerCase().includes(needle));
        if (!hits.length) return;
        const row = { person, hits };
        if (hits.some(h => h.field === 'name' || h.field === 'altName')) nameHits.push(row);
        else otherHits.push(row);
      });
      const byName = (a, b) => getDisplayName(a.person).localeCompare(getDisplayName(b.person), undefined, { sensitivity: 'base' });
      nameHits.sort(byName);
      otherHits.sort(byName);
      return nameHits.concat(otherHits);
    }

    function highlightSearchText(text, query) {
      const src = String(text || '');
      const q = String(query || '');
      if (!q) return escapeHtml(src);
      const lower = src.toLowerCase();
      const needle = q.toLowerCase();
      let out = '';
      let i = 0;
      while (i < src.length) {
        const hit = lower.indexOf(needle, i);
        if (hit < 0) {
          out += escapeHtml(src.slice(i));
          break;
        }
        out += escapeHtml(src.slice(i, hit));
        out += '<mark class="search-hit">' + escapeHtml(src.slice(hit, hit + q.length)) + '</mark>';
        i = hit + needle.length;
        if (!needle.length) break;
      }
      return out;
    }

    const SEARCH_FIELD_LABELS = {
      name: 'Name',
      altName: 'Also known as',
      email: 'Email',
      place: 'Place',
      village: 'Village',
      year: 'Year',
      notes: 'Notes'
    };

    function renderSearchResults(query, page) {
      const searchDropdown = document.getElementById('search-results-dropdown');
      if (!searchDropdown) return { total: 0, page: 0, pages: 0 };
      const q = String(query || '').trim();
      lastSearchQuery = q;
      if (!q || (typeof isAuthorizedViewer === 'function' && !isAuthorizedViewer())) {
        lastSearchResults = [];
        searchResultPage = 0;
        searchDropdown.classList.add('hidden');
        searchDropdown.innerHTML = '';
        return { total: 0, page: 0, pages: 0 };
      }
      lastSearchResults = searchPeople(q);
      const total = lastSearchResults.length;
      const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE) || 1);
      searchResultPage = Math.max(0, Math.min(pages - 1, page == null ? searchResultPage : page));
      if (!total) {
        searchDropdown.innerHTML = '<div class="px-3 py-2 text-xs text-slate-400">No matches found</div>';
        searchDropdown.classList.remove('hidden');
        return { total: 0, page: 0, pages: 1 };
      }
      const start = searchResultPage * SEARCH_PAGE_SIZE;
      const rows = lastSearchResults.slice(start, start + SEARCH_PAGE_SIZE);
      const items = rows.map(row => {
        const p = row.person;
        const nameHit = row.hits.find(h => h.field === 'name') || { text: getDisplayName(p) };
        const extra = row.hits.find(h => h.field !== 'name');
        const snippet = extra
          ? `<div class="text-[10.5px] text-slate-500 truncate">${escapeHtml(SEARCH_FIELD_LABELS[extra.field] || extra.field)}: ${highlightSearchText(extra.text, q)}</div>`
          : '';
        return `<button type="button" role="option" data-search-pick="${escapeAttr(p.id)}" class="w-full text-left px-3 py-2 hover:bg-parchment-50 text-xs">
              <span class="flex items-center justify-between gap-2">
                <span class="deceased-corner-host font-semibold text-slate-900 truncate">${highlightSearchText(nameHit.text, q)}${deceasedCornerHtml(p)}</span>
                <span class="text-[10.5px] text-slate-500 shrink-0">${escapeHtml(getCardLifespanLabel(p))}</span>
              </span>
              ${snippet}
            </button>`;
      }).join('');
      const from = start + 1;
      const to = start + rows.length;
      const pager = `<div id="search-results-pager">
            <span class="text-[10.5px] text-slate-600">${from}–${to} of ${total}</span>
            <span class="flex items-center gap-1">
              <button type="button" data-search-page="prev" ${searchResultPage === 0 ? 'disabled' : ''} class="px-2 py-1 rounded-lg border border-parchment-300 text-[10.5px] font-semibold text-slate-700 disabled:opacity-40">Prev</button>
              <button type="button" data-search-page="next" ${searchResultPage >= pages - 1 ? 'disabled' : ''} class="px-2 py-1 rounded-lg border border-parchment-300 text-[10.5px] font-semibold text-slate-700 disabled:opacity-40">Next</button>
            </span>
          </div>`;
      searchDropdown.innerHTML = items + pager;
      searchDropdown.classList.remove('hidden');
      return { total, page: searchResultPage, pages, shown: rows.length };
    }


    function openPrintTreeDialog() {
      const modal = document.getElementById('print-tree-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      const first = document.getElementById('btn-print-branch');
      if (first) first.focus();
    }

    function closePrintTreeDialog() {
      const modal = document.getElementById('print-tree-modal');
      if (modal) modal.classList.add('hidden');
    }

    function printTreeView(scope) {
      const wanted = scope === 'full' ? 'full' : 'branch';
      closePrintTreeDialog();
      const prev = {
        focusMode: uiState.focusMode,
        viewMode: uiState.viewMode,
        zoom: uiState.zoom,
        panX: uiState.panX,
        panY: uiState.panY
      };
      const caption = document.getElementById('print-tree-caption');
      const treeTitle = (appState.tree && appState.tree.title) || getSiteTitle();
      if (uiState.viewMode !== 'canvas') uiState.viewMode = 'canvas';
      if (wanted === 'full') {
        uiState.focusMode = false;
        if (caption) caption.textContent = treeTitle + ' — Full tree';
        renderAll();
        fitTreeToScreen();
      } else {
        const pid = getFocusPersonId() || appState.selectedPersonId || appState.centralPersonId;
        if (pid) setFocusPerson(pid, { enableFocus: true, render: false });
        else uiState.focusMode = true;
        if (caption) caption.textContent = treeTitle + ' — Current branch';
        renderAll();
        fitTreeToScreen();
      }
      document.body.classList.add('printing');
      document.body.setAttribute('data-print-scope', wanted);
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        window.clearTimeout(restoreTimer);
        window.removeEventListener('afterprint', restore);
        document.body.classList.remove('printing');
        document.body.removeAttribute('data-print-scope');
        uiState.focusMode = prev.focusMode;
        uiState.viewMode = prev.viewMode;
        uiState.zoom = prev.zoom;
        uiState.panX = prev.panX;
        uiState.panY = prev.panY;
        renderAll();
        applyCanvasTransform();
      };
      window.addEventListener('afterprint', restore);
      const restoreTimer = window.setTimeout(restore, 1500);
      try {
        window.print();
      } catch (err) {
        restore();
        throw err;
      }
      return { scope: wanted, restore };
    }

    function focusNeighborPersonCard(current, key) {
      const cards = Array.from(document.querySelectorAll('[data-person-card]'));
      if (!cards.length) return null;
      const cur = current.getBoundingClientRect();
      const cx = cur.left + cur.width / 2;
      const cy = cur.top + cur.height / 2;
      let best = null;
      let bestScore = Infinity;
      cards.forEach(el => {
        if (el === current) return;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const dx = x - cx;
        const dy = y - cy;
        let aligned = false;
        let primary = 0;
        let secondary = 0;
        if (key === 'ArrowRight') { aligned = dx > 8; primary = dx; secondary = Math.abs(dy); }
        else if (key === 'ArrowLeft') { aligned = dx < -8; primary = -dx; secondary = Math.abs(dy); }
        else if (key === 'ArrowDown') { aligned = dy > 8; primary = dy; secondary = Math.abs(dx); }
        else if (key === 'ArrowUp') { aligned = dy < -8; primary = -dy; secondary = Math.abs(dx); }
        if (!aligned) return;
        const score = primary + secondary * 1.6;
        if (score < bestScore) { bestScore = score; best = el; }
      });
      if (!best) return null;
      best.focus();
      if (typeof best.scrollIntoView === 'function') best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return best;
    }

    function initEvents() {
      // Google Authentication Modal & Actions
      function openGoogleAuthModal() {
        const card = document.getElementById('auth-modal-current-card');
        const signoutBtn = document.getElementById('btn-google-signout');
        const oauthLabel = document.getElementById('btn-google-oauth-label');
        const activeEmail = getActiveUserEmail();

        if (activeEmail && firebaseUser) {
          const role = getEffectiveSessionRole();
          const roleName = role === 'super_admin' ? 'Super Admin' : role === 'admin' ? 'Administrator' : role === 'edit' ? 'Edit Access' : role === 'view' ? 'View Access' : 'Restricted';
          card.innerHTML = `
            <div class="font-semibold text-slate-900">Signed in with Google</div>
            <div class="text-slate-700 mt-0.5">${escapeHtml(activeEmail)}</div>
            <div class="text-[11px] text-emerald-700 font-semibold mt-1">Role: ${escapeHtml(roleName)} · Persistent Session Active</div>
          `;
          signoutBtn.classList.remove('hidden');
          oauthLabel.textContent = 'Switch Google Account';
        } else {
          card.innerHTML = `
            <div class="font-semibold text-slate-900">Not Signed In</div>
            <div class="text-slate-600 mt-0.5">Sign in once with your authorized Google Account. No records are loaded until sign-in succeeds.</div>
          `;
          signoutBtn.classList.add('hidden');
          oauthLabel.textContent = 'Continue with Google Account';
        }
        document.getElementById('modal-google-auth').classList.remove('hidden');
      }

      document.getElementById('btn-google-account').addEventListener('click', openGoogleAuthModal);
      document.getElementById('btn-banner-signin').addEventListener('click', openGoogleAuthModal);
      document.getElementById('btn-unauth-signin').addEventListener('click', () => signInWithGooglePopup(false));
      document.getElementById('btn-unauth-redirect').addEventListener('click', signInWithGoogleRedirectFlow);
      document.getElementById('btn-trigger-google-oauth').addEventListener('click', () => {
        signInWithGooglePopup(Boolean(getActiveUserEmail()));
      });
      document.getElementById('btn-trigger-google-redirect').addEventListener('click', signInWithGoogleRedirectFlow);
      document.getElementById('btn-google-signout').addEventListener('click', signOutGoogleUser);

      if (authChannel) {
        authChannel.onmessage = () => {
          if (auth && auth.currentUser) {
            auth.currentUser.reload().then(() => renderAll()).catch(() => renderAll());
          } else {
            renderAll();
          }
        };
      }

      // View Switcher
      document.getElementById('btn-view-canvas').addEventListener('click', () => {
        uiState.viewMode = 'canvas';
        renderAll();
      });
      document.getElementById('btn-view-list').addEventListener('click', () => {
        uiState.viewMode = 'list';
        renderAll();
      });

      // Undo / Redo
      document.getElementById('btn-undo').addEventListener('click', undo);
      document.getElementById('btn-redo').addEventListener('click', redo);
      document.addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
          e.preventDefault();
          redo();
        }
      });

      // Generation Depth Popover
      const genPopover = document.getElementById('popover-gen-depth');
      const genToggle = document.getElementById('btn-gen-depth-toggle');
      new MutationObserver(() => {
        genToggle.setAttribute('aria-expanded', String(!genPopover.classList.contains('hidden')));
      }).observe(genPopover, { attributes: true, attributeFilter: ['class'] });
      genToggle.addEventListener('click', () => {
        genPopover.classList.toggle('hidden');
      });
      document.getElementById('btn-close-gen-depth').addEventListener('click', () => {
        genPopover.classList.add('hidden');
        genToggle.focus();
      });
      document.querySelectorAll('[data-set-gen-depth]').forEach(btn => {
        btn.addEventListener('click', () => {
          uiState.generationDepth = parseInt(btn.dataset.setGenDepth, 10) || 5;
          renderAll();
          fitTreeToScreen();
        });
      });
      document.getElementById('btn-center-on-main').addEventListener('click', () => {
        const mainId = resolveCentralPersonIdForUser() || appState.centralPersonId;
        if (mainId && uiState.focusMode) setFocusPerson(mainId);
        else if (mainId) centerOnPerson(mainId, true);
        document.getElementById('popover-gen-depth').classList.add('hidden');
      });

      // Rename Tree Dialog
      document.getElementById('btn-rename-tree').addEventListener('click', () => {
        if (!canEditTree()) return;
        if (!canAccessAdminPanel()) {
          showToast('Only an Admin or the Super Admin can rename the tree.');
          return;
        }
        const dlgInput = document.getElementById('dialog-input');
        dlgInput.value = appState.tree.title || getSiteTitle();
        document.getElementById('modal-dialog').classList.remove('hidden');
        setTimeout(() => { dlgInput.focus(); dlgInput.select(); }, 0);
      });
      document.getElementById('dialog-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('dialog-confirm').click();
        }
      });
      document.getElementById('dialog-cancel').addEventListener('click', () => {
        document.getElementById('modal-dialog').classList.add('hidden');
      });
      document.getElementById('dialog-confirm').addEventListener('click', () => {
        const val = document.getElementById('dialog-input').value.trim();
        if (val && val !== appState.tree.title) {
          commitMutation(`Renamed tree to "${val}"`, s => { s.tree.title = val; });
        }
        document.getElementById('modal-dialog').classList.add('hidden');
      });

      // Empty Tree Add First Person
      document.getElementById('btn-empty-add-first').addEventListener('click', () => {
        if (!canEditTree()) return;
        const newId = generateId('p');
        const activeEmail = getActiveUserEmail();
        commitMutation('Added founding person to ' + getSiteTitle(), s => {
          s.persons[newId] = {
            id: newId,
            given: sessionAuth.displayName ? sessionAuth.displayName.split(' ')[0] : 'Founding',
            surname: sessionAuth.displayName && sessionAuth.displayName.includes(' ') ? sessionAuth.displayName.split(' ').slice(1).join(' ') : 'Ancestor',
            altName: '',
            sex: 'U',
            livingStatus: 'living',
            emails: activeEmail ? [activeEmail] : [],
            photoUrl: sessionAuth.photoURL || '',
            media: [],
            bio: '',
            events: [],
            assertions: [],
            customTags: []
          };
          s.centralPersonId = newId;
          s.selectedPersonId = newId;
        });
        openInspector(newId, 'edit');
        fitTreeToScreen();
      });

      // Inspector Drawer Controls
      document.getElementById('btn-toggle-inspector').addEventListener('click', () => {
        if (uiState.inspectorOpen) closeInspector();
        else openInspector(appState.selectedPersonId || appState.centralPersonId, 'profile');
      });
      document.getElementById('btn-close-inspector').addEventListener('click', closeInspector);
      document.getElementById('btn-insp-circle-profile').addEventListener('click', () => {
        uiState.inspectorTab = 'profile';
        renderAll();
      });
      document.getElementById('btn-insp-circle-edit').addEventListener('click', () => {
        uiState.inspectorTab = 'edit';
        renderAll();
      });
      document.getElementById('btn-insp-circle-add').addEventListener('click', () => {
        uiState.inspectorTab = 'add';
        renderAll();
      });
      document.getElementById('btn-avatar-camera').addEventListener('click', () => {
        uiState.inspectorTab = 'profile';
        uiState.accordions.photos = true;
        uiState.showPhotoAddForm = true;
        renderAll();
      });
      document.getElementById('btn-insp-circle-more').addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('insp-more-menu').classList.toggle('hidden');
      });
      document.getElementById('btn-set-as-central').addEventListener('click', () => {
        const pid = appState.selectedPersonId;
        if (pid && appState.persons[pid]) {
          appState.centralPersonId = pid;
          document.getElementById('insp-more-menu').classList.add('hidden');
          renderAll();
          centerOnPerson(pid, true);
          showToast(`Centered tree on ${getDisplayName(appState.persons[pid])}`);
        }
      });
      document.getElementById('btn-trace-to-central').addEventListener('click', () => {
        document.getElementById('insp-more-menu').classList.add('hidden');
        const fromId = appState.centralPersonId;
        const toId = appState.selectedPersonId;
        const res = computeKinship(fromId, toId);
        if (res) {
          uiState.highlightedKinship = res;
          document.getElementById('kinship-banner-text').textContent = `${getDisplayName(appState.persons[toId])} is your ${res.title}`;
          document.getElementById('kinship-banner').classList.remove('hidden');
          renderAll();
        } else {
          showToast('No direct lineage path found between these two individuals.');
        }
      });
      document.getElementById('btn-open-evidence-menu').addEventListener('click', () => {
        document.getElementById('insp-more-menu').classList.add('hidden');
        uiState.inspectorTab = 'evidence';
        renderAll();
      });
      document.getElementById('btn-delete-person').addEventListener('click', () => {
        document.getElementById('insp-more-menu').classList.add('hidden');
        const pid = appState.selectedPersonId;
        const person = appState.persons[pid];
        if (!person) return;
        const pName = getDisplayName(person);
        if (!window.confirm(`Remove ${pName} from the tree? Their family links will be detached. You can undo this right after with Ctrl+Z.`)) return;
        commitMutation(`Removed ${pName}`, s => {
          delete s.persons[pid];
          Object.keys(s.families).forEach(fid => {
            const f = s.families[fid];
            if (f.partner1Id === pid) f.partner1Id = null;
            if (f.partner2Id === pid) f.partner2Id = null;
            f.children = (f.children || []).filter(c => c.personId !== pid);
            if (!f.partner1Id && !f.partner2Id && f.children.length === 0) {
              delete s.families[fid];
            }
          });
          s.selectedPersonId = Object.keys(s.persons)[0] || null;
          if (s.centralPersonId === pid) s.centralPersonId = s.selectedPersonId;
        });
        closeInspector();
      });

      // Kinship Modal
      document.getElementById('btn-open-kinship').addEventListener('click', () => {
        const persons = Object.values(appState.persons);
        if (persons.length < 2) {
          showToast('Add at least two people to compute kinship.');
          return;
        }
        const fromSel = document.getElementById('kinship-from-select');
        const toSel = document.getElementById('kinship-to-select');
        const opts = persons.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(getDisplayName(p))}</option>`).join('');
        fromSel.innerHTML = opts;
        toSel.innerHTML = opts;
        if (appState.centralPersonId) fromSel.value = appState.centralPersonId;
        if (appState.selectedPersonId && appState.selectedPersonId !== fromSel.value) {
          toSel.value = appState.selectedPersonId;
        } else if (persons[1]) {
          toSel.value = persons[1].id;
        }
        updateKinshipModalPreview();
        document.getElementById('modal-kinship').classList.remove('hidden');
      });

      function updateKinshipModalPreview() {
        const fromId = document.getElementById('kinship-from-select').value;
        const toId = document.getElementById('kinship-to-select').value;
        const box = document.getElementById('kinship-result-box');
        const res = computeKinship(fromId, toId);
        if (!res) {
          box.innerHTML = `<span class="text-slate-500">No connected family path found between these two individuals.</span>`;
          return;
        }
        const trail = res.pathIds.map(id => escapeHtml(getDisplayName(appState.persons[id]))).join(' → ');
        box.innerHTML = `
          <div class="font-bold text-archival-indigo">${escapeHtml(getDisplayName(appState.persons[toId]))} is ${escapeHtml(res.title)} of ${escapeHtml(getDisplayName(appState.persons[fromId]))}</div>
          <div class="text-[11px] text-slate-600 mt-1">${trail}</div>
        `;
      }

      document.getElementById('kinship-from-select').addEventListener('change', updateKinshipModalPreview);
      document.getElementById('kinship-to-select').addEventListener('change', updateKinshipModalPreview);
      document.getElementById('btn-highlight-kinship').addEventListener('click', () => {
        const fromId = document.getElementById('kinship-from-select').value;
        const toId = document.getElementById('kinship-to-select').value;
        const res = computeKinship(fromId, toId);
        if (res) {
          uiState.highlightedKinship = res;
          document.getElementById('kinship-banner-text').textContent = `${getDisplayName(appState.persons[toId])} is ${res.title} of ${getDisplayName(appState.persons[fromId])}`;
          document.getElementById('kinship-banner').classList.remove('hidden');
          document.getElementById('modal-kinship').classList.add('hidden');
          renderAll();
        }
      });
      document.getElementById('btn-clear-kinship').addEventListener('click', () => {
        uiState.highlightedKinship = null;
        document.getElementById('kinship-banner').classList.add('hidden');
        renderAll();
      });

      // Quick Search
      const searchInput = document.getElementById('search-input');
      const searchDropdown = document.getElementById('search-results-dropdown');
      const searchWrapEl = document.getElementById('header-search-wrap');
      const searchToggleBtn = document.getElementById('btn-search-toggle');
      const setMobileSearchOpen = (openIt, returnFocus) => {
        searchWrapEl.classList.toggle('search-open', openIt);
        searchToggleBtn.setAttribute('aria-expanded', String(openIt));
        if (openIt) setTimeout(() => document.getElementById('search-input').focus(), 0);
        else if (returnFocus) searchToggleBtn.focus();
      };
      searchToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setMobileSearchOpen(!searchWrapEl.classList.contains('search-open'), false);
      });
      document.getElementById('search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchWrapEl.classList.contains('search-open')) {
          e.preventDefault();
          e.stopPropagation();
          searchDropdown.classList.add('hidden');
          setMobileSearchOpen(false, true);
        }
      });
      document.addEventListener('click', (e) => {
        if (searchWrapEl.classList.contains('search-open') && !searchWrapEl.contains(e.target) && e.target !== searchToggleBtn) {
          setMobileSearchOpen(false, false);
        }
      });
      searchInput.addEventListener('input', () => {
        searchResultPage = 0;
        renderSearchResults(searchInput.value, 0);
      });

      // Canvas Pan, Zoom & Generation Jump
      const viewport = document.getElementById('canvas-viewport');
      // Pointer events cover mouse, pen and touch. One pointer pans; two pointers pinch-zoom.
      const activePointers = new Map();
      let pinchStart = null;
      let dragMoved = false;
      let suppressNextClick = false;
      const pressedCards = new Map();
      // Once a pan or pinch is under way, capture the pointer on the viewport (which is
      // never re-rendered) so moves keep arriving even if the touched card is culled.
      // Not done on pointerdown, so a plain tap still clicks the card.
      const captureOnViewport = (pointerId) => {
        try { if (!viewport.hasPointerCapture(pointerId)) viewport.setPointerCapture(pointerId); } catch (_) { /* pointer already gone */ }
      };
      const zoomAt = (mx, my, nextZoomRaw) => {
        const nextZoom = Math.max(0.28, Math.min(2.1, nextZoomRaw));
        uiState.panX = mx - (mx - uiState.panX) * (nextZoom / uiState.zoom);
        uiState.panY = my - (my - uiState.panY) * (nextZoom / uiState.zoom);
        uiState.zoom = nextZoom;
        applyCanvasTransform();
      };
      const zoomAroundCentre = (factor) => {
        const rect = viewport.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, uiState.zoom * factor);
      };
      viewport.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const onInteractive = e.target.closest('[data-person-card]') || e.target.closest('button');
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pressedCard = e.pointerType !== 'mouse' && e.target.closest('[data-person-card]');
        if (pressedCard) { pressedCards.set(e.pointerId, pressedCard); canvasPinnedNodes.add(pressedCard); }
        if (activePointers.size === 2) {
          const [a, b] = Array.from(activePointers.values());
          const rect = viewport.getBoundingClientRect();
          pinchStart = {
            dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            zoom: uiState.zoom,
            cx: (a.x + b.x) / 2 - rect.left,
            cy: (a.y + b.y) / 2 - rect.top
          };
          uiState.isDragging = false;
          dragMoved = true;
          activePointers.forEach((_, id) => captureOnViewport(id));
          return;
        }
        // Mouse drags never start on a card/button (keeps click behaviour); touch may pan from anywhere.
        if (onInteractive && e.pointerType === 'mouse') return;
        uiState.isDragging = true;
        dragMoved = false;
        uiState.dragOriginX = e.clientX;
        uiState.dragOriginY = e.clientY;
        uiState.dragStartX = e.clientX - uiState.panX;
        uiState.dragStartY = e.clientY - uiState.panY;
        viewport.classList.add('cursor-grabbing');
      });
      window.addEventListener('pointermove', e => {
        if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchStart && activePointers.size >= 2) {
          const [a, b] = Array.from(activePointers.values());
          const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          zoomAt(pinchStart.cx, pinchStart.cy, pinchStart.zoom * (dist / pinchStart.dist));
          pinchStart.zoom = uiState.zoom;
          pinchStart.dist = dist;
          return;
        }
        if (!uiState.isDragging) return;
        if (!dragMoved && Math.hypot(e.clientX - uiState.dragOriginX, e.clientY - uiState.dragOriginY) < 6) return;
        if (!dragMoved) captureOnViewport(e.pointerId);
        dragMoved = true;
        uiState.panX = e.clientX - uiState.dragStartX;
        uiState.panY = e.clientY - uiState.dragStartY;
        applyCanvasTransform();
      });
      const endPointer = (e) => {
        activePointers.delete(e.pointerId);
        const pressedCard = pressedCards.get(e.pointerId);
        if (pressedCard) { pressedCards.delete(e.pointerId); canvasPinnedNodes.delete(pressedCard); }
        if (activePointers.size < 2) pinchStart = null;
        if (activePointers.size === 0) {
          if (uiState.isDragging && dragMoved) suppressNextClick = true;
          uiState.isDragging = false;
          viewport.classList.remove('cursor-grabbing');
          setTimeout(() => { suppressNextClick = false; }, 0);
        }
      };
      window.addEventListener('pointerup', endPointer);
      window.addEventListener('pointercancel', endPointer);
      // Safari backstop: stop the page itself from scrolling or pinch-zooming while a
      // finger moves on the tree (touch-action alone is not always honoured on iOS).
      // touchmove only, so taps still produce clicks.
      viewport.addEventListener('touchmove', e => {
        if (e.cancelable && !e.target.closest('.canvas-float-toolbar')) e.preventDefault();
      }, { passive: false });
      ['gesturestart', 'gesturechange'].forEach(type => viewport.addEventListener(type, e => e.preventDefault(), { passive: false }));
      // A pan that ended over a card should not also open that card.
      viewport.addEventListener('click', e => {
        if (suppressNextClick) {
          e.stopPropagation();
          e.preventDefault();
          suppressNextClick = false;
        }
      }, true);
      viewport.addEventListener('keydown', e => {
        const card = e.target.closest && e.target.closest('[data-person-card]');
        if (card && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          card.click();
          return;
        }
        if (card && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          focusNeighborPersonCard(card, e.key);
          return;
        }
        if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target?.tagName) && e.key !== '+' && e.key !== '-') return;
        const step = 60;
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAroundCentre(1.15); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAroundCentre(0.87); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); uiState.panX += step; applyCanvasTransform(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); uiState.panX -= step; applyCanvasTransform(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); uiState.panY += step; applyCanvasTransform(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); uiState.panY -= step; applyCanvasTransform(); }
      });
      viewport.addEventListener('wheel', e => {
        if (!isAuthorizedViewer()) return;
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        if (e.ctrlKey && Math.abs(e.deltaY) < 50) {
          // Trackpad pinch gesture: smooth, proportional zoom
          zoomAt(mx, my, uiState.zoom * Math.exp(-e.deltaY * 0.01));
          return;
        }
        const factor = e.deltaY < 0 ? 1.1 : 0.91;
        const nextZoom = Math.max(0.28, Math.min(2.1, uiState.zoom * factor));
        uiState.panX = mx - (mx - uiState.panX) * (nextZoom / uiState.zoom);
        uiState.panY = my - (my - uiState.panY) * (nextZoom / uiState.zoom);
        uiState.zoom = nextZoom;
        applyCanvasTransform();
      }, { passive: false });

      document.getElementById('btn-zoom-in').addEventListener('click', () => zoomAroundCentre(1.15));
      document.getElementById('btn-zoom-out').addEventListener('click', () => zoomAroundCentre(0.87));
      document.getElementById('btn-zoom-reset').addEventListener('click', () => {
        const rect = viewport.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, 1);
      });
      document.getElementById('btn-fit-screen').addEventListener('click', fitTreeToScreen);
      document.getElementById('btn-toggle-full-tree').addEventListener('click', () => setFullTreeMode(uiState.focusMode));
      const openPrint = () => openPrintTreeDialog();
      document.getElementById('btn-print-tree')?.addEventListener('click', openPrint);
      document.getElementById('btn-print-tree-menu')?.addEventListener('click', openPrint);
      document.getElementById('btn-print-branch')?.addEventListener('click', () => printTreeView('branch'));
      document.getElementById('btn-print-full')?.addEventListener('click', () => printTreeView('full'));
      document.getElementById('print-tree-modal')?.addEventListener('click', (e) => {
        if (e.target && e.target.closest('[data-print-cancel]')) closePrintTreeDialog();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('print-tree-modal')?.classList.contains('hidden')) {
          closePrintTreeDialog();
        }
      });


      // Delegated Clicks across Canvas, Outline & Profile Sheet
      document.addEventListener('click', e => {
        if (!e.target.closest('#btn-insp-circle-more') && !e.target.closest('#insp-more-menu')) {
          document.getElementById('insp-more-menu')?.classList.add('hidden');
        }

        const closeModalBtn = e.target.closest('[data-close-modal]');
        if (closeModalBtn) {
          document.getElementById(closeModalBtn.dataset.closeModal)?.classList.add('hidden');
          return;
        }

        const jumpGenBtn = e.target.closest('[data-jump-gen]');
        if (jumpGenBtn) {
          const g = parseInt(jumpGenBtn.dataset.jumpGen, 10);
          const vh = viewport.clientHeight || 560;
          const stage = document.getElementById('canvas-stage');
          uiState.panY = vh / 2 - (TOP_OFFSET + g * LAYER_HEIGHT + CARD_H / 2) * uiState.zoom;
          stage.classList.add('stage-smooth-pan');
          applyCanvasTransform();
          setTimeout(() => stage.classList.remove('stage-smooth-pan'), 360);
          return;
        }

        const stubBtn = e.target.closest('[data-toggle-ancestor-stub]');
        if (stubBtn) {
          e.stopPropagation();
          const pid = stubBtn.dataset.toggleAncestorStub;
          if (isFocusViewActive() && pid === getFocusPersonId()) {
            // Accordion: closing the open branch moves focus up to the parents' line.
            const parentFam = Object.values(appState.families).find(f => (f.children || []).some(c => c.personId === pid));
            const up = parentFam && [parentFam.partner1Id, parentFam.partner2Id].find(x => x && appState.persons[x]);
            if (up) setFocusPerson(up, { recenterOn: pid });
            else showToast('This is the top of this branch. Use "Show full tree" for the overall view.');
          } else {
            setFocusPerson(pid, { enableFocus: true });
          }
          return;
        }

        const quickRelBtn = e.target.closest('[data-quick-rel]');
        if (quickRelBtn) {
          e.stopPropagation();
          addNewRelativeToPerson(appState.selectedPersonId, quickRelBtn.dataset.quickRel);
          return;
        }

        const cardEl = e.target.closest('[data-person-card]');
        if (cardEl) {
          const pid = cardEl.dataset.personCard;
          uiState.editingFactItem = null;
          openInspector(pid, 'profile');
          return;
        }

        const pageBtn = e.target.closest('[data-search-page]');
        if (pageBtn) {
          if (pageBtn.disabled || pageBtn.getAttribute('disabled') !== null) return;
          const dir = pageBtn.getAttribute('data-search-page');
          searchResultPage += dir === 'next' ? 1 : -1;
          renderSearchResults(lastSearchQuery, searchResultPage);
          const input = document.getElementById('search-input');
          if (input) input.focus();
          return;
        }

        const pickBtn = e.target.closest('[data-search-pick]');
        if (pickBtn) {
          const pid = pickBtn.dataset.searchPick;
          searchDropdown.classList.add('hidden');
          document.getElementById('header-search-wrap').classList.remove('search-open');
          document.getElementById('btn-search-toggle').setAttribute('aria-expanded', 'false');
          searchInput.value = '';
          uiState.viewMode = 'canvas';
          uiState.editingFactItem = null;
          if (uiState.focusMode) setFocusPerson(pid, { render: false });
          openInspector(pid, 'profile');
          centerOnPerson(pid, true);
          return;
        }

        const outlineBtn = e.target.closest('[data-outline-person]');
        if (outlineBtn) {
          if (uiState.focusMode) setFocusPerson(outlineBtn.dataset.outlinePerson, { render: false });
          openInspector(outlineBtn.dataset.outlinePerson, 'profile');
          return;
        }

        // Accordion toggles & + Add actions
        const accBtn = e.target.closest('[data-toggle-accordion]');
        if (accBtn) {
          const key = accBtn.dataset.toggleAccordion;
          uiState.accordions[key] = !uiState.accordions[key];
          renderAll();
          return;
        }

        if (e.target.id === 'btn-accordion-add-photo') {
          uiState.accordions.photos = true;
          uiState.showPhotoAddForm = !uiState.showPhotoAddForm;
          renderAll();
          return;
        }
        if (e.target.id === 'btn-cancel-photo-form') {
          uiState.showPhotoAddForm = false;
          renderAll();
          return;
        }
        if (e.target.id === 'btn-accordion-add-bio') {
          uiState.inspectorTab = 'edit';
          renderAll();
          return;
        }
        if (e.target.id === 'btn-accordion-add-family') {
          uiState.inspectorTab = 'add';
          renderAll();
          return;
        }
        if (e.target.id === 'btn-accordion-add-fact') {
          uiState.accordions.facts = true;
          uiState.showFactAddForm = !uiState.showFactAddForm;
          renderAll();
          return;
        }
        if (e.target.id === 'btn-cancel-fact-form') {
          uiState.showFactAddForm = false;
          renderAll();
          return;
        }

        const editFactBtn = e.target.closest('[data-edit-fact-kind]');
        if (editFactBtn) {
          const kind = editFactBtn.dataset.editFactKind;
          const id = editFactBtn.dataset.editFactId;
          if (uiState.editingFactItem && uiState.editingFactItem.kind === kind && uiState.editingFactItem.id === id) {
            uiState.editingFactItem = null;
          } else {
            uiState.editingFactItem = { kind, id };
          }
          renderAll();
          return;
        }
        if (e.target.id === 'btn-cancel-inline-fact') {
          uiState.editingFactItem = null;
          renderAll();
          return;
        }

        const delEventBtn = e.target.closest('[data-delete-event]');
        if (delEventBtn) {
          const evId = delEventBtn.dataset.deleteEvent;
          commitMutation('Deleted life event', s => {
            const p = s.persons[s.selectedPersonId];
            if (p) p.events = (p.events || []).filter(ev => ev.id !== evId);
          });
          uiState.editingFactItem = null;
          renderAll();
          return;
        }

        const delMediaBtn = e.target.closest('[data-delete-media]');
        if (delMediaBtn) {
          const mId = delMediaBtn.dataset.deleteMedia;
          commitMutation('Removed photo', s => {
            const p = s.persons[s.selectedPersonId];
            if (p) p.media = (p.media || []).filter(m => m.id !== mId);
          });
          return;
        }

        // Toggle Email Role (Edit <-> View)
        const toggleEmailBtn = e.target.closest('[data-toggle-email-role]');
        if (toggleEmailBtn) {
          if (!canManageAccess()) {
            showToast('Only the Super Admin can change who may sign in or whether they can edit.');
            return;
          }
          const targetEmail = toggleEmailBtn.dataset.toggleEmailRole.toLowerCase();
          commitMutation(`Toggled access role for ${targetEmail}`, s => {
            const perm = (s.accessControl?.permissions || []).find(pm => pm.email.toLowerCase() === targetEmail);
            if (perm && perm.role !== 'super_admin') {
              perm.role = perm.role === 'edit' ? 'view' : 'edit';
              perm.updatedAt = new Date().toISOString().slice(0, 10);
            }
          }, 'Access Control');
          return;
        }

        const remEmailBtn = e.target.closest('[data-remove-person-email]');
        if (remEmailBtn) {
          const targetEmail = remEmailBtn.dataset.removePersonEmail.toLowerCase();
          commitMutation(`Removed email ${targetEmail}`, s => {
            const p = s.persons[s.selectedPersonId];
            if (p) p.emails = (p.emails || []).filter(em => em.toLowerCase() !== targetEmail);
            if (canManageAccess(s)) {
              s.accessControl.permissions = (s.accessControl.permissions || []).filter(pm => pm.email.toLowerCase() !== targetEmail);
            }
          }, canManageAccess() ? 'Access Control' : 'Tree');
          return;
        }

        // Evidence & Citations actions
        if (e.target.id === 'btn-back-to-profile-sheet') {
          uiState.inspectorTab = 'profile';
          renderAll();
          return;
        }
        if (e.target.id === 'btn-toggle-add-assertion') {
          uiState.showAssertionAddForm = !uiState.showAssertionAddForm;
          renderAll();
          return;
        }
        if (e.target.id === 'btn-cancel-assertion-form') {
          uiState.showAssertionAddForm = false;
          renderAll();
          return;
        }
        const acceptAsrtBtn = e.target.closest('[data-accept-assertion]');
        if (acceptAsrtBtn) {
          const asrtId = acceptAsrtBtn.dataset.acceptAssertion;
          commitMutation('Marked research claim as Accepted', s => {
            const p = s.persons[s.selectedPersonId];
            const item = (p?.assertions || []).find(a => a.id === asrtId);
            if (item) item.status = 'accepted';
          }, 'Evidence');
          return;
        }
        const delAsrtBtn = e.target.closest('[data-delete-assertion]');
        if (delAsrtBtn) {
          const asrtId = delAsrtBtn.dataset.deleteAssertion;
          commitMutation('Deleted research citation', s => {
            const p = s.persons[s.selectedPersonId];
            if (p) p.assertions = (p.assertions || []).filter(a => a.id !== asrtId);
          }, 'Evidence');
          return;
        }

      });

      // Delegated Form Submissions & Dynamic Select Changes
      document.addEventListener('change', e => {
        const linkSel = e.target.closest && e.target.closest('[data-set-child-linkage]');
        if (linkSel) {
          if (!canEditTree()) return;
          const famId = linkSel.dataset.setChildLinkage;
          const childId = linkSel.dataset.setChildId;
          const linkage = normalizeLinkage(linkSel.value);
          const fam = appState.families[famId];
          const child = appState.persons[childId];
          if (!fam || !child) return;
          commitMutation(`Set ${getDisplayName(child)} as ${childRoleLabel(linkage).toLowerCase()}`, s => {
            const family = s.families[famId];
            if (!family) return;
            family.children = family.children || [];
            const rec = family.children.find(c => c.personId === childId);
            if (rec) rec.linkage = linkage;
            else family.children.push({ personId: childId, linkage });
          }, 'Relationship');
          return;
        }
        const unionSel = e.target.closest && e.target.closest('[data-set-union-status]');
        if (unionSel) {
          if (!canEditTree()) return;
          const famId = unionSel.dataset.setUnionStatus;
          const status = unionSel.value === 'divorced' ? 'divorced' : 'married';
          const fam = appState.families[famId];
          if (!fam) return;
          commitMutation(`Marked union as ${status}`, s => {
            if (s.families[famId]) s.families[famId].status = status;
          }, 'Relationship');
          return;
        }
        if (e.target.id === 'prov-link-type') {
          const val = e.target.value;
          const assignParents = val === 'adoptive_parents' || val === 'step_parents';
          document.getElementById('prov-target-person-wrap')?.classList.toggle('hidden', assignParents);
          document.getElementById('prov-adoptive-fam-wrap')?.classList.toggle('hidden', !assignParents);
          const famLabel = document.querySelector('#prov-adoptive-fam-wrap label');
          if (famLabel) famLabel.textContent = val === 'step_parents' ? 'Select Step Couple / Family Unit' : 'Select Adoptive Couple / Family Unit';
          document.getElementById('prov-marriage-meta-wrap')?.classList.toggle('hidden', val !== 'marriage');
        }
      });

      document.addEventListener('submit', e => {
        if (e.target.id === 'form-add-person-photo') {
          e.preventDefault();
          const fd = new FormData(e.target);
          const photoUrl = (fd.get('photoUrl') || '').trim();
          const caption = (fd.get('caption') || '').trim();
          const setAsAvatar = fd.get('setAsAvatar') === 'on';
          if (!photoUrl) return;
          if (!safeImageUrl(photoUrl)) {
            showToast('Please use an https:// image link. Data URLs and other addresses are not stored.');
            return;
          }
          commitMutation('Added portrait photo', s => {
            const p = s.persons[s.selectedPersonId];
            if (!p) return;
            p.media = p.media || [];
            p.media.push({ id: generateId('med'), url: photoUrl, caption });
            if (setAsAvatar || !p.photoUrl) p.photoUrl = photoUrl;
          });
          uiState.showPhotoAddForm = false;
          renderAll();
          return;
        }

        if (e.target.id === 'form-add-event') {
          e.preventDefault();
          const fd = new FormData(e.target);
          const type = fd.get('evType') || 'BIRT';
          const date = (fd.get('evDate') || '').trim();
          const place = (fd.get('evPlace') || '').trim();
          commitMutation(`Added ${type} fact`, s => {
            const p = s.persons[s.selectedPersonId];
            if (!p) return;
            p.events = p.events || [];
            p.events.push({ id: generateId('ev'), type, date, place });
            if (type === 'DEAT') p.livingStatus = 'deceased';
          });
          uiState.showFactAddForm = false;
          renderAll();
          return;
        }

        const saveFactForm = e.target.closest('[data-save-fact-kind]');
        if (saveFactForm) {
          e.preventDefault();
          const kind = saveFactForm.dataset.saveFactKind;
          const id = saveFactForm.dataset.saveFactId;
          const fd = new FormData(saveFactForm);
          const factDate = (fd.get('factDate') || '').trim();
          const factPlace = (fd.get('factPlace') || '').trim();

          commitMutation(`Updated ${kind === 'marriage' ? 'marriage' : 'life fact'} details`, s => {
            if (kind === 'event') {
              const p = s.persons[s.selectedPersonId];
              const ev = (p?.events || []).find(item => item.id === id);
              if (ev) {
                ev.date = factDate;
                ev.place = factPlace;
              }
            } else if (kind === 'marriage') {
              const fam = s.families[id];
              if (fam) {
                fam.marriageDate = factDate;
                fam.marriagePlace = factPlace;
                const status = (fd.get('unionStatus') || '').trim();
                if (status === 'divorced' || status === 'married') fam.status = status;
              }
            }
          });
          uiState.editingFactItem = null;
          renderAll();
          return;
        }

        if (e.target.id === 'form-add-person-email') {
          e.preventDefault();
          const fd = new FormData(e.target);
          const newEmail = (fd.get('newEmail') || '').trim().toLowerCase();
          if (!newEmail) return;
          const manage = canManageAccess();
          // New person emails are View unless the Super Admin explicitly chooses Edit.
          const emailRole = manage ? (fd.get('emailRole') === 'edit' ? 'edit' : 'view') : null;
          const summary = manage
            ? `Linked Google user ${newEmail} (${emailRole})`
            : `Added email ${newEmail} (sign-in access is granted only by the Super Admin)`;
          commitMutation(summary, s => {
            const p = s.persons[s.selectedPersonId];
            if (!p) return;
            p.emails = p.emails || [];
            if (!p.emails.some(em => em.toLowerCase() === newEmail)) {
              p.emails.push(newEmail);
            }
            if (!canManageAccess(s)) return;
            const perms = s.accessControl.permissions || [];
            const existing = perms.find(pm => pm.email.toLowerCase() === newEmail);
            if (existing) {
              if (existing.role !== 'super_admin') existing.role = emailRole;
              existing.personId = p.id;
            } else {
              perms.push({
                id: generateId('perm'),
                email: newEmail,
                personId: p.id,
                role: isSuperAdminEmail(newEmail, s) ? 'super_admin' : emailRole,
                note: `Tree Member (${getDisplayName(p)})`,
                updatedAt: new Date().toISOString().slice(0, 10)
              });
            }
          }, manage ? 'Access Control' : 'Tree');
          if (!manage) {
            showToast('Email saved on the person. Only the Super Admin can grant sign-in access.');
          }
          return;
        }

        if (e.target.id === 'form-edit-person-profile') {
          e.preventDefault();
          const fd = new FormData(e.target);
          commitMutation('Updated person profile details', s => {
            const p = s.persons[s.selectedPersonId];
            if (!p) return;
            p.given = (fd.get('given') || '').trim();
            p.surname = (fd.get('surname') || '').trim();
            p.altName = (fd.get('altName') || '').trim();
            p.sex = fd.get('sex') || 'U';
            p.livingStatus = fd.get('livingStatus') || 'living';
            const rawPhoto = (fd.get('photoUrl') || '').trim();
            p.photoUrl = rawPhoto && safeImageUrl(rawPhoto) ? rawPhoto : (rawPhoto ? (p.photoUrl || '') : '');
            p.bio = (fd.get('bio') || '').trim();
          });
          uiState.inspectorTab = 'profile';
          renderAll();
          return;
        }

        if (e.target.id === 'form-provision-link') {
          e.preventDefault();
          const fd = new FormData(e.target);
          const linkType = fd.get('linkType');
          const anchorId = appState.selectedPersonId;
          const anchor = appState.persons[anchorId];
          if (!anchor) return;

          if (linkType === 'marriage') {
            const targetId = fd.get('targetPersonId');
            const mDate = (fd.get('marriageDate') || '').trim();
            const mPlace = (fd.get('marriagePlace') || '').trim();
            if (!targetId || targetId === anchorId) return;

            commitMutation(`Provisioned marriage between ${getDisplayName(anchor)} & ${getDisplayName(appState.persons[targetId])}`, s => {
              let existingFam = Object.values(s.families).find(f =>
                (f.partner1Id === anchorId && f.partner2Id === targetId) ||
                (f.partner1Id === targetId && f.partner2Id === anchorId)
              );
              if (!existingFam) {
                const famId = generateId('f');
                s.families[famId] = {
                  id: famId,
                  partner1Id: anchorId,
                  partner2Id: targetId,
                  marriageDate: mDate,
                  marriagePlace: mPlace,
                  status: 'married',
                  children: []
                };
              } else {
                if (mDate) existingFam.marriageDate = mDate;
                if (mPlace) existingFam.marriagePlace = mPlace;
              }
            }, 'Relationship');
          } else if (linkType === 'adopt_child' || linkType === 'step_child') {
            const childId = fd.get('targetPersonId');
            const linkage = linkType === 'step_child' ? 'step' : 'adoptive';
            if (!childId || childId === anchorId) return;
            if (wouldCreateAncestorCycle(anchorId, childId)) {
              showToast(linkage === 'step' ? 'Blocked: Cannot add an ancestor as a stepchild (would create a circular loop).' : 'Blocked: Cannot adopt an ancestor (would create a circular loop).');
              return;
            }
            const verb = linkage === 'step' ? 'stepchild link' : 'adoption';
            commitMutation(`Provisioned ${verb} of ${getDisplayName(appState.persons[childId])} by ${getDisplayName(anchor)}`, s => {
              let fam = Object.values(s.families).find(f => f.partner1Id === anchorId || f.partner2Id === anchorId);
              if (!fam) {
                const famId = generateId('f');
                fam = { id: famId, partner1Id: anchorId, partner2Id: null, marriageDate: '', marriagePlace: '', status: 'married', children: [] };
                s.families[famId] = fam;
              }
              fam.children = fam.children || [];
              const rec = fam.children.find(c => c.personId === childId);
              if (rec) rec.linkage = linkage;
              else fam.children.push({ personId: childId, linkage });
            }, 'Relationship');
          } else if (linkType === 'adoptive_parents' || linkType === 'step_parents') {
            const famId = fd.get('targetFamilyId');
            const fam = appState.families[famId];
            const linkage = linkType === 'step_parents' ? 'step' : 'adoptive';
            if (!fam) return;
            if ((fam.partner1Id && wouldCreateAncestorCycle(fam.partner1Id, anchorId)) ||
                (fam.partner2Id && wouldCreateAncestorCycle(fam.partner2Id, anchorId))) {
              showToast(linkage === 'step' ? 'Blocked: Cannot assign descendants as step-parents.' : 'Blocked: Cannot assign descendants as adoptive parents.');
              return;
            }
            commitMutation(`Assigned ${linkage === 'step' ? 'step-parents' : 'adoptive parents'} to ${getDisplayName(anchor)}`, s => {
              const targetFam = s.families[famId];
              if (!targetFam) return;
              targetFam.children = targetFam.children || [];
              const rec = targetFam.children.find(c => c.personId === anchorId);
              if (rec) rec.linkage = linkage;
              else targetFam.children.push({ personId: anchorId, linkage });
            }, 'Relationship');
          }
          uiState.inspectorTab = 'profile';
          renderAll();
          return;
        }

        if (e.target.id === 'form-add-assertion') {
          e.preventDefault();
          const fd = new FormData(e.target);
          const factType = fd.get('factType') || 'EVEN';
          const status = fd.get('status') === 'competing' ? 'competing' : 'accepted';
          const value = (fd.get('value') || '').trim();
          const sourceTitle = (fd.get('sourceTitle') || '').trim();
          const locator = (fd.get('locator') || '').trim();
          const transcription = (fd.get('transcription') || '').trim();
          if (!value || !sourceTitle) return;

          commitMutation(`Added ${status} citation for ${factType}`, s => {
            const p = s.persons[s.selectedPersonId];
            if (!p) return;
            p.assertions = p.assertions || [];
            p.assertions.push({
              id: generateId('as'),
              factType,
              status,
              value,
              sourceTitle,
              locator,
              transcription
            });
          }, 'Evidence');
          uiState.showAssertionAddForm = false;
          renderAll();
          return;
        }
      });

      let resizeTimer = null;
      let lastFitWidth = window.innerWidth;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const ae = document.activeElement;
          const typing = ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName);
          const widthChange = Math.abs(window.innerWidth - lastFitWidth);
          if (typing || widthChange < 40) return; // e.g. on-screen keyboard or URL bar showing/hiding
          lastFitWidth = window.innerWidth;
          if (isAuthorizedViewer() && uiState.viewMode === 'canvas') fitTreeToScreen();
        }, 180);
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

    initEvents();
    initHeaderOverflowMenu('btn-header-more', 'header-more-menu', 'app-header');
    initAccessibleModals(['modal-dialog', 'modal-kinship'], () => {
      const menu = document.getElementById('insp-more-menu');
      const search = document.getElementById('search-results-dropdown');
      const pop = document.getElementById('popover-gen-depth');
      if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
      if (search && !search.classList.contains('hidden')) { search.classList.add('hidden'); return; }
      if (pop && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
      if (uiState.inspectorOpen) closeInspector();
    });
    window.__TREE = {
      getState: () => appState,
      getUi: () => uiState,
      load(state) {
        appState = normalizeAppState(JSON.parse(JSON.stringify(state)));
        const email = (appState.superAdminEmail || getConfiguredSuperAdminEmail() || 'owner@example.com').toLowerCase();
        appState.superAdminEmail = email;
        firebaseUser = { email, uid: 'test-uid', emailVerified: true };
        sessionAuth.isAuthenticated = true;
        sessionAuth.email = email;
        firestoreAccessDenied = false;
        delete uiState.privacyMode;
        delete uiState.revealLivingInInspector;
        renderAll();
        return { people: Object.keys(appState.persons).length };
      },
      renderAll,
      openInspector,
      setView(mode) { uiState.viewMode = mode; renderAll(); },
      setZoom(z) { uiState.zoom = z; applyCanvasTransform(); },
      fitTreeToScreen,
      getCardLifespanLabel,
      getVitalSummary,
      getHeaderVitalLine,
      getDisplayName,
      isDeceased,
      getDeceasedLabel,
      deceasedCornerHtml,
      commitMutation,
      captureDomainSnapshot,
      estimateAllStorage,
      prepareLogWrite,
      compactChangeLogEvents,
      reconstructStateBeforeEntry,
      getEntryDiff,
      entryIsRevertible,
      computeDomainDiff,
      applyDomainDiffToSnap,
      appendChangeLogEntry,
      assignLogCheckpoints,
      LOG_CHECKPOINT_LIMIT,
      setTestWrite(fn) { testWriteImpl = fn; },
      getLatestLog: () => latestLogData,
      getLatestMain: () => latestMainData,
      persistState,
      focusNeighborPersonCard,
      openPrintTreeDialog,
      closePrintTreeDialog,
      printTreeView,
      searchPeople,
      renderSearchResults,
      SEARCH_PAGE_SIZE,
      recordAppError,
      loadAppErrorLog,
      clearAppErrorLog,
      flushSave: () => saveChain,
      setPendingLogMigration(v) { pendingLogMigration = Boolean(v); }
    };

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

    const params = new URLSearchParams(location.search);
    if (params.get('test') === '1') {
      renderAll();
    } else {
      renderAll();
      initFirebaseAndPersistence();
    }
  