window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;
window.OSR_APPCHECK = window.OSR_APPCHECK || { siteKey: '', enterprise: false };

import { applyHostingAuthDomain } from './firebase-config.js';
import { computeAccessListsFromPermissions, frozenAccessListsFromMainDoc, reconcilePermissionsWithMainDoc, describeAclReport, nextArchiveRevision } from './acl-core.js';
import { createEditLockManager } from './edit-locks.js';
import { configureSaveCore, LOG_CHECKPOINT_LIMIT, OFFLINE_SAVE_MESSAGE, appendChangeLogEntry, applyDomainDiffToSnap, assignLogCheckpoints, clearAppErrorLog, compactChangeLogEvents, computeDomainDiff, deepClone, describeLogStorage, describeMainStorage, entryIsRevertible, escapeHtml, extractEmbeddedLog, formatFirestoreError, formatStorageKb, generateId, getArchiveDocPath, getArchiveId, getArchiveLogDocPath, getArchiveLogId, getEntryDiff, getOsConfig, isOfflineWriteError, isOwnEchoSnapshot, jsonFitsInDoc, loadAppErrorLog, logStateFromLogDoc, mergeLogStates, openFirestoreDatabase, paintStorageRow, reconstructStateBeforeEntry, recordAppError, rememberOwnStamp, reservedSizeForFields, trimChangeLogToFit, writeArchiveAndLog } from './save-core.js';

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
      collection,
      deleteDoc,
      serverTimestamp,
      Timestamp,
    } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
    import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
    import { initializeAppCheck, ReCaptchaV3Provider, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js";

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


    const OSR_LANG_KEY = 'osr_ui_lang_v1';
    const OSR_I18N = {
      en: {
        langName: 'English',
        language: 'Language',
        signIn: 'Sign in',
        signOut: 'Sign Out',
        admin: 'Admin',
        profile: 'Profile',
        tree: 'Tree',
        outline: 'Outline',
        kinship: 'Kinship',
        print: 'Print',
        printPdf: 'Print / Save as PDF',
        search: 'Find a person, place, year, or notes…',
        mergePeople: 'Merge duplicate people',
        takePhoto: 'Take photo',
        chooseGallery: 'Choose from gallery',
        facts: 'Facts',
        photos: 'Photos & videos',
        biography: 'Biography',
        family: 'Immediate family',
        more: 'More',
        edit: 'Edit',
        add: 'Add',
        cancel: 'Cancel',
        save: 'Save',
        fit: 'Fit',
        showFullTree: 'Show full tree',
        focusView: 'Focus view',
        settings: 'Settings',
        peopleAccess: 'People & Access',
        changeLog: 'Change log',
        data: 'Data',
        overview: 'Overview',
        inviteTitle: 'Invite someone by email',
        inviteHelp: 'Adds the address to the access list, then gives you a link and a mailto draft. Email is not sent automatically.',
        inviteEmail: 'Email address',
        inviteRole: 'Role',
        inviteRoleView: 'View',
        inviteRoleEdit: 'Edit',
        createInvite: 'Create invite',
        copyLink: 'Copy invite text',
        inviteOpenMail: 'Open in email app'
      },
      hi: {
        langName: 'हिन्दी',
        language: 'भाषा',
        signIn: 'साइन इन',
        signOut: 'साइन आउट',
        admin: 'प्रशासन',
        profile: 'प्रोफ़ाइल',
        tree: 'वृक्ष',
        outline: 'सूची',
        kinship: 'रिश्ते',
        print: 'प्रिंट',
        printPdf: 'प्रिंट / पीडीएफ सहेजें',
        search: 'व्यक्ति, स्थान, वर्ष या नोट खोजें…',
        mergePeople: 'दोहरी प्रविष्टियाँ मिलाएँ',
        takePhoto: 'फ़ोटो लें',
        chooseGallery: 'गैलरी से चुनें',
        facts: 'तथ्य',
        photos: 'फ़ोटो और वीडियो',
        biography: 'जीवन परिचय',
        family: 'निकट परिवार',
        more: 'और',
        edit: 'संपादित करें',
        add: 'जोड़ें',
        cancel: 'रद्द करें',
        save: 'सहेजें',
        fit: 'फ़िट',
        showFullTree: 'पूरा वृक्ष दिखाएँ',
        focusView: 'शाखा दृश्य',
        settings: 'सेटिंग्स',
        peopleAccess: 'लोग और पहुँच',
        changeLog: 'परिवर्तन लॉग',
        data: 'डेटा',
        overview: 'सारांश',
        inviteTitle: 'ईमेल से आमंत्रित करें',
        inviteHelp: 'पता पहुँच सूची में जुड़ जाता है, फिर आपको लिंक और मेल ड्राफ़्ट मिलता है। ईमेल अपने आप नहीं भेजा जाता।',
        inviteEmail: 'ईमेल पता',
        inviteRole: 'भूमिका',
        inviteRoleView: 'देखें',
        inviteRoleEdit: 'संपादन',
        createInvite: 'आमंत्रण बनाएँ',
        copyLink: 'आमंत्रण पाठ कॉपी करें',
        inviteOpenMail: 'ईमेल ऐप में खोलें'
      },
      mr: {
        langName: 'मराठी',
        language: 'भाषा',
        signIn: 'साइन इन',
        signOut: 'साइन आउट',
        admin: 'प्रशासन',
        profile: 'प्रोफाइल',
        tree: 'वृक्ष',
        outline: 'यादी',
        kinship: 'नाते',
        print: 'प्रिंट',
        printPdf: 'प्रिंट / पीडीएफ जतन करा',
        search: 'व्यक्ती, ठिकाण, वर्ष किंवा टिपा शोधा…',
        mergePeople: 'जुळ्या नोंदी एकत्र करा',
        takePhoto: 'फोटो काढा',
        chooseGallery: 'गॅलरीतून निवडा',
        facts: 'तथ्य',
        photos: 'फोटो आणि व्हिडिओ',
        biography: 'चरित्र',
        family: 'निकटचे कुटुंब',
        more: 'अधिक',
        edit: 'संपादित करा',
        add: 'जोडा',
        cancel: 'रद्द करा',
        save: 'जतन करा',
        fit: 'फिट',
        showFullTree: 'संपूर्ण वृक्ष दाखवा',
        focusView: 'शाखा दृश्य',
        settings: 'सेटिंग्ज',
        peopleAccess: 'लोक आणि प्रवेश',
        changeLog: 'बदलांची नोंद',
        data: 'डेटा',
        overview: 'आढावा',
        inviteTitle: 'ईमेलने आमंत्रित करा',
        inviteHelp: 'पत्ता प्रवेश यादीत जोडला जातो, नंतर तुम्हाला लिंक आणि मेल मसुदा मिळतो. ईमेल आपोआप पाठवला जात नाही.',
        inviteEmail: 'ईमेल पत्ता',
        inviteRole: 'भूमिका',
        inviteRoleView: 'पहा',
        inviteRoleEdit: 'संपादन',
        createInvite: 'आमंत्रण तयार करा',
        copyLink: 'आमंत्रण मजकूर कॉपी करा',
        inviteOpenMail: 'ईमेल अॅपमध्ये उघडा'
      }
    };


    function ensureLanguageSwitcher() {
      const slots = [document.getElementById('ui-language-slot'), document.getElementById('ui-language-slot-menu')];
      slots.forEach(slot => {
        if (!slot) return;
        if (!slot.querySelector('#ui-language-select') && !slot.querySelector('select')) {
          slot.innerHTML = languageSwitcherHtml();
        }
      });
      // if both slots exist, keep a single select in the header and a clone in the menu with a different id
      const menu = document.getElementById('ui-language-slot-menu');
      if (menu) {
        const sel = menu.querySelector('select');
        if (sel) { sel.id = 'ui-language-select-menu'; sel.value = getUiLanguage(); }
      }
    }

    function getUiLanguage() {
      try {
        const stored = (localStorage.getItem(OSR_LANG_KEY) || '').trim();
        if (OSR_I18N[stored]) return stored;
      } catch (e) {}
      return 'en';
    }

    function t(key, fallback) {
      const lang = getUiLanguage();
      const dict = OSR_I18N[lang] || OSR_I18N.en;
      if (dict[key] != null) return dict[key];
      if (OSR_I18N.en[key] != null) return OSR_I18N.en[key];
      return fallback != null ? fallback : key;
    }

    function applyI18n(root) {
      const scope = root || document;
      const lang = getUiLanguage();
      document.documentElement.setAttribute('lang', lang);
      scope.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        const translated = t(key, el.getAttribute('data-i18n-fallback') || el.textContent);
        if (el.childElementCount && el.querySelector('span[data-i18n-label], [data-i18n-label]')) {
          const label = el.querySelector('span[data-i18n-label], [data-i18n-label]');
          if (label) label.textContent = translated;
        } else if (!el.childElementCount) {
          el.textContent = translated;
        } else {
          const textNode = Array.from(el.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
          if (textNode) textNode.textContent = (el.childElementCount ? ' ' : '') ? translated : translated;
          else {
            const span = el.querySelector('span:last-child');
            if (span && !span.children.length) span.textContent = translated;
          }
        }
      });
      scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), el.getAttribute('placeholder') || ''));
      });
      scope.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.setAttribute('title', t(el.getAttribute('data-i18n-title'), el.getAttribute('title') || ''));
      });
      scope.querySelectorAll('[data-i18n-aria]').forEach(el => {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), el.getAttribute('aria-label') || ''));
      });
      const select = document.getElementById('ui-language-select');
      if (select && select.value !== lang) select.value = lang;
    }

    function setUiLanguage(lang) {
      const next = OSR_I18N[lang] ? lang : 'en';
      try { localStorage.setItem(OSR_LANG_KEY, next); } catch (e) {}
      document.documentElement.setAttribute('lang', next);
      applyI18n(document);
      if (typeof renderAll === 'function') renderAll();
      if (typeof renderAdmin === 'function') renderAdmin();
    }

    function languageSwitcherHtml() {
      const lang = getUiLanguage();
      return `<label class="inline-flex items-center gap-1 text-[11px] text-slate-600">
        <span class="sr-only" data-i18n="language">Language</span>
        <select id="ui-language-select" aria-label="${t('language', 'Language')}" class="px-2 py-1.5 min-h-[36px] text-xs bg-white border border-parchment-300 rounded-lg">
          <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
          <option value="hi" ${lang === 'hi' ? 'selected' : ''}>हिन्दी</option>
          <option value="mr" ${lang === 'mr' ? 'selected' : ''}>मराठी</option>
        </select>
      </label>`;
    }

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
    const PHOTO_MAX_EDGE = 1600;
    const PHOTO_JPEG_QUALITY = 0.82;
    const PHOTO_MAX_BYTES = 900 * 1024;
    function getStoragePhotoPrefix() { return getArchiveDocPath() + '/portraits'; }

    function getConfiguredStorageBucket() {
      const raw = (typeof firebaseApp !== 'undefined' && firebaseApp && firebaseApp.options && firebaseApp.options.storageBucket)
        || (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.storageBucket)
        || 'our-shared-roots.firebasestorage.app';
      return String(raw).replace(/^gs:\/\//, '').trim().toLowerCase();
    }

    function bucketsMatch(urlBucket, configured) {
      const a = String(urlBucket || '').toLowerCase();
      const b = String(configured || '').toLowerCase();
      if (!a || !b) return false;
      if (a === b) return true;
      const strip = (s) => s.replace(/\.firebasestorage\.app$/, '').replace(/\.appspot\.com$/, '');
      return strip(a) === strip(b);
    }

    function storagePathFromPortraitUrl(url) {
      const raw = String(url || '').trim();
      if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return null;
      let parsed;
      try { parsed = new URL(raw); } catch (e) { return null; }
      if (parsed.protocol !== 'https:') return null;
      const configured = getConfiguredStorageBucket();
      let objectPath = null;
      const classic = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (classic) {
        if (!bucketsMatch(decodeURIComponent(classic[1]), configured)) return null;
        objectPath = decodeURIComponent(classic[2]);
      } else if (bucketsMatch(parsed.hostname, configured) || parsed.hostname.toLowerCase().endsWith('.firebasestorage.app')) {
        if (!bucketsMatch(parsed.hostname, configured) && parsed.hostname.toLowerCase() !== configured) return null;
        objectPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      }
      if (!objectPath) return null;
      objectPath = objectPath.split('?')[0].replace(/^\/+/, '');
      if (objectPath.includes('..')) return null;
      const prefix = getStoragePhotoPrefix() + '/';
      if (!objectPath.startsWith(prefix)) return null;
      return objectPath;
    }

    function isOurStoragePortraitUrl(url) {
      return Boolean(storagePathFromPortraitUrl(url));
    }

    function collectPhotoUrlsFromState(stateObj) {
      const urls = [];
      Object.values((stateObj || {}).persons || {}).forEach((person) => {
        if (!person) return;
        if (person.photoUrl) urls.push(person.photoUrl);
        (person.media || []).forEach((item) => { if (item && item.url) urls.push(item.url); });
      });
      return urls;
    }

    function collectOurPortraitUrlsFromState(stateObj) {
      const set = new Set();
      collectPhotoUrlsFromState(stateObj).forEach((url) => {
        if (isOurStoragePortraitUrl(url)) set.add(url);
      });
      return set;
    }

    let deletePhotoFromStorageImpl = null;
    function setTestStorageDelete(fn) { deletePhotoFromStorageImpl = fn; }

    async function deleteOurStoragePortrait(url) {
      if (!isOurStoragePortraitUrl(url)) return { ok: false, skipped: true };
      const path = storagePathFromPortraitUrl(url);
      try {
        if (typeof deletePhotoFromStorageImpl === 'function') {
          return await deletePhotoFromStorageImpl(url);
        }
        if (!path || !firebaseStorage) return { ok: false, skipped: true };
        await deleteObject(ref(firebaseStorage, path));
        return { ok: true, path };
      } catch (err) {
        const code = String((err && err.code) || '');
        if (code === 'storage/object-not-found' || /object-not-found/i.test(code + ' ' + String(err && err.message || ''))) {
          return { ok: true, missing: true, path };
        }
        console.warn('Could not delete storage portrait', path, err);
        return { ok: false, error: err, path };
      }
    }

    async function cleanupOrphanStoragePortraits(previousUrls, stateObj = appState) {
      const stillUsed = collectOurPortraitUrlsFromState(stateObj);
      const previous = previousUrls instanceof Set ? previousUrls : new Set(previousUrls || []);
      const deleted = [];
      for (const url of previous) {
        if (stillUsed.has(url)) continue;
        if (!isOurStoragePortraitUrl(url)) continue;
        const result = await deleteOurStoragePortrait(url);
        deleted.push({ url, result });
      }
      return deleted;
    }

    function scheduleOrphanPortraitCleanup(previousUrls, writeResult) {
      return Promise.resolve(writeResult).then((res) => {
        if (res && res.ok === false) return [];
        return cleanupOrphanStoragePortraits(previousUrls);
      }).catch((err) => {
        console.warn('Portrait cleanup skipped:', err);
        return [];
      });
    }



    let firebaseStorage = null;

    let appCheckInstance = null;

    function getAppCheckOptions() {
      const cfg = window.OSR_APPCHECK || {};
      const siteKey = String(cfg.siteKey || window.FIREBASE_CONFIG?.appCheckSiteKey || '').trim();
      return { siteKey, enterprise: Boolean(cfg.enterprise) };
    }

    function isAppCheckConfigured() {
      return Boolean(getAppCheckOptions().siteKey);
    }

    function startAppCheckIfConfigured(app) {
      const { siteKey, enterprise } = getAppCheckOptions();
      if (!app || !siteKey) {
        appCheckInstance = null;
        return null;
      }
      try {
        const provider = enterprise ? new ReCaptchaEnterpriseProvider(siteKey) : new ReCaptchaV3Provider(siteKey);
        appCheckInstance = initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
        return appCheckInstance;
      } catch (err) {
        console.error('App Check failed to start', err);
        appCheckInstance = null;
        return null;
      }
    }

    let uploadPhotoToStorageImpl = null;

    function isDataImageUrl(url) {
      return /^data:image\//i.test(String(url || '').trim());
    }

    function collectInlinePhotos(stateObj) {
      const state = stateObj || appState;
      const found = [];
      Object.values(state.persons || {}).forEach(person => {
        if (!person) return;
        if (isDataImageUrl(person.photoUrl)) {
          found.push({ personId: person.id, field: 'photoUrl' });
        }
        (person.media || []).forEach((item, index) => {
          if (item && isDataImageUrl(item.url)) {
            found.push({ personId: person.id, field: 'media', index, id: item.id });
          }
        });
      });
      return found;
    }

    function dataUrlToBlob(dataUrl) {
      const parts = String(dataUrl || '').split(',');
      const head = parts[0] || '';
      const body = parts[1] || '';
      const mime = (head.match(/data:([^;]+)/i) || [])[1] || 'image/jpeg';
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }

    async function compressImageBlob(blob, opts) {
      const maxEdge = (opts && opts.maxEdge) || PHOTO_MAX_EDGE;
      const qualityStart = (opts && opts.quality) || PHOTO_JPEG_QUALITY;
      if (!blob) throw new Error('No image to compress.');
      let bitmap;
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(blob);
      } else {
        bitmap = await new Promise((resolve, reject) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
          img.src = url;
        });
      }
      try {
        let width = bitmap.width;
        let height = bitmap.height;
        if (width > maxEdge || height > maxEdge) {
          const scale = maxEdge / Math.max(width, height);
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        let quality = qualityStart;
        let out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        while (out && out.size > PHOTO_MAX_BYTES && quality > 0.5) {
          quality = Math.max(0.5, quality - 0.08);
          out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        }
        if (!out) throw new Error('Could not compress that image.');
        out._width = width;
        out._height = height;
        return out;
      } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      }
    }

    function setTestStorageUpload(fn) {
      uploadPhotoToStorageImpl = fn || null;
    }

    async function uploadPortraitBlob(personId, blob) {
      if (typeof uploadPhotoToStorageImpl === 'function') {
        return uploadPhotoToStorageImpl(personId, blob);
      }
      if (!firebaseStorage) {
        throw new Error('Photo storage is not available yet. Enable Firebase Storage in the Firebase console, deploy storage.rules, then reload.');
      }
      const safeId = String(personId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      const path = `${getStoragePhotoPrefix()}/${safeId}/${name}`;
      const storageRef = ref(firebaseStorage, path);
      await uploadBytes(storageRef, blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000' });
      return getDownloadURL(storageRef);
    }

    async function saveUploadedPortrait(personId, fileOrBlob, opts) {
      const options = opts || {};
      const compressed = await compressImageBlob(fileOrBlob);
      const url = await uploadPortraitBlob(personId, compressed);
      const caption = options.caption || '';
      const setAsAvatar = options.setAsAvatar !== false;
      const summary = 'Added portrait photo';
      const run = (state) => {
        const person = state.persons[personId];
        if (!person) throw new Error('That person is no longer in the tree.');
        person.media = person.media || [];
        person.media.push({ id: generateId('med'), url, caption, source: 'storage' });
        if (setAsAvatar || !person.photoUrl || isDataImageUrl(person.photoUrl)) person.photoUrl = url;
      };
      if (typeof commitMutation === 'function') commitMutation(summary, run, 'Tree Data');
      else if (typeof commitTreeDataMutation === 'function') await commitTreeDataMutation(summary, run);
      else throw new Error('Could not save the photo to the tree.');
      return url;
    }

    async function migrateInlinePhotos(stateObj, progressFn) {
      const state = stateObj || appState;
      const found = collectInlinePhotos(state);
      if (!found.length) return { ok: true, migrated: 0, failed: 0, total: 0 };
      const replacements = [];
      let failed = 0;
      for (let i = 0; i < found.length; i++) {
        const item = found[i];
        if (progressFn) progressFn(i, found.length, item);
        try {
          const person = state.persons[item.personId];
          const raw = item.field === 'photoUrl' ? person.photoUrl : (person.media[item.index] && person.media[item.index].url);
          const blob = dataUrlToBlob(raw);
          const compressed = await compressImageBlob(blob);
          const url = await uploadPortraitBlob(item.personId, compressed);
          replacements.push({ ...item, url });
        } catch (err) {
          failed += 1;
          console.error('Photo migration failed', err);
        }
      }
      if (replacements.length) {
        const run = (s) => {
          replacements.forEach(item => {
            const person = s.persons[item.personId];
            if (!person) return;
            if (item.field === 'photoUrl') person.photoUrl = item.url;
            else if (person.media && person.media[item.index]) person.media[item.index].url = item.url;
          });
        };
        if (typeof commitMutation === 'function') commitMutation(`Uploaded ${replacements.length} embedded photo${replacements.length === 1 ? '' : 's'} to Storage`, run, 'Tree Data');
        else if (typeof commitTreeDataMutation === 'function') await commitTreeDataMutation(`Uploaded ${replacements.length} embedded photos to Storage`, run);
        else run(state);
      }
      return { ok: failed === 0, migrated: replacements.length, failed, total: found.length };
    }

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
      if (/^data:/i.test(s)) return 'This image is stored as an embedded data URL and is no longer displayed. Use Take photo / Choose from gallery, or upload embedded photos from the Admin Data tab.';
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
          const start = parseRangeSide(range[1], raw);
          const end = parseRangeSide(range[2], raw);
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


    const UNION_STATUSES = ['married', 'divorced', 'separated', 'widowed'];
    function normalizeUnionStatus(status) {
      const s = String(status || '').trim().toLowerCase();
      if (s === 'divorced' || s === 'separated' || s === 'widowed') return s;
      return 'married';
    }
    function unionIsFormer(status) {
      const s = normalizeUnionStatus(status);
      return s === 'divorced' || s === 'separated' || s === 'widowed';
    }
    function unionShowsDivorceFields(status) {
      const s = normalizeUnionStatus(status);
      return s === 'divorced' || s === 'separated';
    }
    function unionStatusLabel(status) {
      const s = normalizeUnionStatus(status);
      return { married: 'Married', divorced: 'Divorced', separated: 'Separated', widowed: 'Widowed' }[s];
    }
    function unionSpouseHeading(status) {
      return unionIsFormer(status) ? 'Former spouse' : 'Spouse';
    }
    function unionFactTitle(status) {
      const s = normalizeUnionStatus(status);
      if (s === 'divorced') return 'Divorce / Union:';
      if (s === 'separated') return 'Separation:';
      if (s === 'widowed') return 'Widowed:';
      return 'Marriage to:';
    }
    function unionLineStyle(status) {
      const s = normalizeUnionStatus(status);
      if (s === 'divorced') return { stroke: '#DC2626', dash: '5,4' };
      if (s === 'separated') return { stroke: '#D97706', dash: '1.5,3.5' };
      if (s === 'widowed') return { stroke: '#6B7280', dash: '' };
      return { stroke: '#94A3B8', dash: '' };
    }
    function unionStatusOptionsHtml(selected) {
      const cur = normalizeUnionStatus(selected);
      return UNION_STATUSES.map((s) => `<option value="${s}"${s === cur ? ' selected' : ''}>${unionStatusLabel(s)}</option>`).join('');
    }
    function linkageOptionsHtml(selected) {
      const cur = normalizeLinkage(selected);
      return `<option value="biological"${cur === 'biological' ? ' selected' : ''}>Biological</option>`
        + `<option value="adoptive"${cur === 'adoptive' ? ' selected' : ''}>Adopted</option>`
        + `<option value="step"${cur === 'step' ? ' selected' : ''}>Step</option>`
        + `<option value="foster"${cur === 'foster' ? ' selected' : ''}>Foster</option>`
        + `<option value="guardian"${cur === 'guardian' ? ' selected' : ''}>Guardian</option>`;
    }

    const QE_PREFIX_OPTIONS = ['', 'Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.', 'Prof.', 'Shri', 'Smt.', 'Sri'];
    const QE_SUFFIX_OPTIONS = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'Ph.D.', 'M.D.'];
    const QE_MODE_OPTIONS = [
      { value: 'exact', label: 'Exactly' },
      { value: 'BEF', label: 'Before' },
      { value: 'AFT', label: 'After' },
      { value: 'ABT', label: 'Circa' },
      { value: 'unsure', label: 'Unsure' },
      { value: 'BET', label: 'Between' },
      { value: 'free', label: 'Free text' }
    ];
    const QE_SIDE_OPTIONS = [
      { value: 'exact', label: 'Exactly' },
      { value: 'BEF', label: 'Before' },
      { value: 'AFT', label: 'After' },
      { value: 'ABT', label: 'Circa' },
      { value: 'unsure', label: 'Unsure' }
    ];
    let quickEditPersonId = null;

    function quickEditIsOpen() {
      const modal = document.getElementById('modal-quick-edit');
      return Boolean(modal && !modal.classList.contains('hidden'));
    }

    function parseRangeSide(sideRaw, wholeRaw) {
      const text = String(sideRaw || '').trim();
      if (!text) return null;
      const split = splitDateQualifier(text);
      const q = split.qualifier === 'BET' ? null : split.qualifier;
      return parseOneDateBody(split.body || text, wholeRaw, q);
    }

    function qeSideQual(q) {
      if (q === 'ABT' || q === 'BEF' || q === 'AFT') return q;
      return 'exact';
    }

    function dateStringToQe(dateStr) {
      const raw = typeof dateStr === 'string' ? dateStr.trim() : '';
      const empty = {
        mode: 'exact', startQ: 'exact', year: '', month: '', day: '',
        endQ: 'exact', endYear: '', endMonth: '', endDay: '', free: raw
      };
      if (!raw) return empty;
      const parsed = parseFlexibleDateParts(raw);
      if (!parsed) return { ...empty, mode: 'free', free: raw };
      const ymd = (side) => ({
        year: side && side.year ? side.year : '',
        month: (side && side.month != null) ? (side.month + 1) : '',
        day: (side && side.day != null) ? side.day : ''
      });
      if (parsed.qualifier === 'BET' && (parsed.rangeStart || parsed.rangeEnd)) {
        const s = ymd(parsed.rangeStart);
        const e = ymd(parsed.rangeEnd);
        return {
          mode: 'BET',
          startQ: qeSideQual(parsed.rangeStart && parsed.rangeStart.qualifier),
          year: s.year, month: s.month, day: s.day,
          endQ: qeSideQual(parsed.rangeEnd && parsed.rangeEnd.qualifier),
          endYear: e.year, endMonth: e.month, endDay: e.day,
          free: raw
        };
      }
      const core = ymd(parsed);
      if (parsed.qualifier === 'ABT' || parsed.qualifier === 'BEF' || parsed.qualifier === 'AFT') {
        return { ...empty, mode: parsed.qualifier, startQ: parsed.qualifier, year: core.year, month: core.month, day: core.day, free: raw };
      }
      if (parsed.year || parsed.month != null || parsed.day != null) {
        return { ...empty, mode: 'exact', year: core.year, month: core.month, day: core.day, free: raw };
      }
      return { ...empty, mode: 'free', free: raw };
    }

    function formatQeYmd(q, y, m, d) {
      const year = parseInt(y, 10);
      const month = parseInt(m, 10);
      const day = parseInt(d, 10);
      const hasY = Number.isFinite(year) && year > 0;
      const hasM = Number.isFinite(month) && month >= 1 && month <= 12;
      const hasD = Number.isFinite(day) && day >= 1 && day <= 31;
      if (!hasY) return '';
      let body = '';
      if (hasD && hasM) body = `${MONTH_NAMES_SHORT[month - 1]} ${day} ${year}`;
      else if (hasM) body = `${MONTH_NAMES_SHORT[month - 1]} ${year}`;
      else body = String(year);
      const qual = q === 'unsure' ? 'ABT' : q;
      if (qual === 'ABT' || qual === 'BEF' || qual === 'AFT') return `${qual} ${body}`;
      return body;
    }

    function qeToDateString(parts) {
      if (!parts) return '';
      if (parts.mode === 'free') return String(parts.free || '').trim();
      if (parts.mode === 'BET') {
        const a = formatQeYmd(parts.startQ, parts.year, parts.month, parts.day);
        const b = formatQeYmd(parts.endQ, parts.endYear, parts.endMonth, parts.endDay);
        if (!a && !b) return '';
        if (!a) return b;
        if (!b) return a;
        return `BET ${a} AND ${b}`;
      }
      const q = parts.mode === 'unsure' ? 'ABT' : parts.mode;
      return formatQeYmd(q === 'exact' ? 'exact' : q, parts.year, parts.month, parts.day);
    }

    function qeOptionList(options, selected) {
      const extra = (selected && !options.includes(selected)) ? [selected] : [];
      return [...options, ...extra].map((opt) => {
        const label = opt || '';
        const sel = opt === selected ? ' selected' : '';
        return `<option value="${escapeAttr(opt)}"${sel}>${escapeHtml(label)}</option>`;
      }).join('');
    }

    function qeSelectOptions(items, selected) {
      return items.map((item) => {
        const sel = item.value === selected ? ' selected' : '';
        return `<option value="${escapeAttr(item.value)}"${sel}>${escapeHtml(item.label)}</option>`;
      }).join('');
    }

    function qeMonthOptions(selected) {
      const val = selected ? String(selected) : '';
      const months = MONTH_NAMES_SHORT.map((name, i) => {
        const v = String(i + 1);
        return `<option value="${v}"${v === val ? ' selected' : ''}>${name}</option>`;
      }).join('');
      return `<option value="">Month</option>${months}`;
    }

    function qeDateControlsHtml(name, dateStr) {
      const p = dateStringToQe(dateStr);
      const isFree = p.mode === 'free';
      const isBet = p.mode === 'BET';
      return `
        <div class="space-y-1.5" data-qe-date="${escapeAttr(name)}">
          <select data-qe-mode aria-label="${escapeAttr(name + ' qualifier')}" class="px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg max-w-full">
            ${qeSelectOptions(QE_MODE_OPTIONS, p.mode)}
          </select>
          <div data-qe-mdy class="${isFree ? 'hidden' : ''} flex flex-wrap gap-1.5">
            <select data-qe-start-q aria-label="${escapeAttr(name + ' start qualifier')}" class="${isBet ? '' : 'hidden '}px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">${qeSelectOptions(QE_SIDE_OPTIONS, p.startQ)}</select>
            <select data-qe-month aria-label="${escapeAttr(name + ' month')}" class="px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">${qeMonthOptions(p.month)}</select>
            <input data-qe-day type="number" inputmode="numeric" min="1" max="31" placeholder="Day" aria-label="${escapeAttr(name + ' day')}" value="${escapeAttr(p.day)}" class="w-16 px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
            <input data-qe-year type="number" inputmode="numeric" min="1" max="9999" placeholder="Year" aria-label="${escapeAttr(name + ' year')}" value="${escapeAttr(p.year)}" class="w-20 px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
          </div>
          <input data-qe-free type="text" placeholder="Date as written" aria-label="${escapeAttr(name + ' free text')}" value="${escapeAttr(p.free)}" class="${isFree ? '' : 'hidden '}w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
          <div data-qe-and class="${isBet ? '' : 'hidden'} space-y-1.5">
            <div class="text-[11px] font-medium text-slate-600">And</div>
            <div class="flex flex-wrap gap-1.5">
              <select data-qe-end-q aria-label="${escapeAttr(name + ' end qualifier')}" class="px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">${qeSelectOptions(QE_SIDE_OPTIONS, p.endQ)}</select>
              <select data-qe-end-month aria-label="${escapeAttr(name + ' end month')}" class="px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">${qeMonthOptions(p.endMonth)}</select>
              <input data-qe-end-day type="number" inputmode="numeric" min="1" max="31" placeholder="Day" aria-label="${escapeAttr(name + ' end day')}" value="${escapeAttr(p.endDay)}" class="w-16 px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
              <input data-qe-end-year type="number" inputmode="numeric" min="1" max="9999" placeholder="Year" aria-label="${escapeAttr(name + ' end year')}" value="${escapeAttr(p.endYear)}" class="w-20 px-2 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
            </div>
          </div>
        </div>`;
    }

    function qeReadDate(name) {
      const box = document.querySelector(`#modal-quick-edit [data-qe-date="${name}"]`);
      if (!box) return '';
      return qeToDateString({
        mode: box.querySelector('[data-qe-mode]')?.value || 'exact',
        startQ: box.querySelector('[data-qe-start-q]')?.value || 'exact',
        year: box.querySelector('[data-qe-year]')?.value || '',
        month: box.querySelector('[data-qe-month]')?.value || '',
        day: box.querySelector('[data-qe-day]')?.value || '',
        endQ: box.querySelector('[data-qe-end-q]')?.value || 'exact',
        endYear: box.querySelector('[data-qe-end-year]')?.value || '',
        endMonth: box.querySelector('[data-qe-end-month]')?.value || '',
        endDay: box.querySelector('[data-qe-end-day]')?.value || '',
        free: box.querySelector('[data-qe-free]')?.value || ''
      });
    }

    function qeSyncDateUi(box) {
      if (!box) return;
      const mode = box.querySelector('[data-qe-mode]')?.value || 'exact';
      const isFree = mode === 'free';
      const isBet = mode === 'BET';
      const startQ = box.querySelector('[data-qe-start-q]');
      if (startQ) startQ.classList.toggle('hidden', !isBet);
      box.querySelector('[data-qe-mdy]')?.classList.toggle('hidden', isFree);
      const free = box.querySelector('[data-qe-free]');
      if (free) free.classList.toggle('hidden', !isFree);
      box.querySelector('[data-qe-and]')?.classList.toggle('hidden', !isBet);
    }

    function qeFillAffixSelect(sel, options, current) {
      if (!sel) return;
      sel.innerHTML = qeOptionList(options, current || '');
      sel.value = current || '';
    }

    function qeSetAvatar(person) {
      const wrap = document.getElementById('qe-avatar-wrap');
      const img = document.getElementById('qe-avatar-img');
      const svg = document.getElementById('qe-avatar-svg');
      if (!wrap || !img || !svg) return;
      wrap.className = person.sex === 'F'
        ? 'w-16 h-16 rounded-full border-2 border-rose-300 bg-rose-50/70 flex items-center justify-center overflow-hidden shrink-0'
        : person.sex === 'M'
          ? 'w-16 h-16 rounded-full border-2 border-sky-300 bg-sky-50/70 flex items-center justify-center overflow-hidden shrink-0'
          : 'w-16 h-16 rounded-full border-2 border-slate-300 bg-slate-100 flex items-center justify-center overflow-hidden shrink-0';
      const safePortrait = person.photoUrl ? safeImageUrl(person.photoUrl) : '';
      if (safePortrait) {
        img.src = safePortrait;
        img.classList.remove('hidden');
        svg.classList.add('hidden');
        svg.innerHTML = '';
      } else {
        img.removeAttribute('src');
        img.classList.add('hidden');
        svg.classList.remove('hidden');
        svg.innerHTML = getSilhouetteSvgInner(person.sex);
      }
    }

    function qeSpouseBlockHtml(person) {
      const unions = unionsForPerson(person.id);
      if (!unions.length) return '';
      return unions.map((fam) => {
        const spouseId = [fam.partner1Id, fam.partner2Id].find((id) => id && id !== person.id);
        const spouse = spouseId ? appState.persons[spouseId] : null;
        const status = normalizeUnionStatus(fam.status);
        const heading = unionSpouseHeading(status);
        const name = spouse ? getDisplayNameWithMaiden(spouse) : 'Unknown';
        const showEnd = unionShowsDivorceFields(status);
        return `
          <div class="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-3" data-qe-union="${escapeAttr(fam.id)}">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-600" data-qe-union-heading>${escapeHtml(heading)}</div>
            <div class="text-sm font-medium text-slate-900">${escapeHtml(name)}</div>
            <label class="block text-[11px] font-medium text-slate-600 mb-1" for="qe-union-status-${escapeAttr(fam.id)}">Status</label>
            <select id="qe-union-status-${escapeAttr(fam.id)}" data-qe-union-status class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
              ${unionStatusOptionsHtml(status)}
            </select>
            <div class="text-[11px] font-medium text-slate-600">Marriage date</div>
            ${qeDateControlsHtml('marr-' + fam.id, fam.marriageDate || '')}
            <label class="block text-[11px] font-medium text-slate-600 mb-1" for="qe-marr-place-${escapeAttr(fam.id)}">Marriage place</label>
            <input id="qe-marr-place-${escapeAttr(fam.id)}" data-qe-union-place type="text" autocomplete="off" value="${escapeAttr(fam.marriagePlace || '')}" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
            <div data-qe-divorce-fields class="${showEnd ? '' : 'hidden'} space-y-1.5">
              <div class="text-[11px] font-medium text-slate-600">End date</div>
              ${qeDateControlsHtml('div-' + fam.id, fam.divorceDate || '')}
              <label class="block text-[11px] font-medium text-slate-600 mb-1" for="qe-div-place-${escapeAttr(fam.id)}">End place</label>
              <input id="qe-div-place-${escapeAttr(fam.id)}" data-qe-divorce-place type="text" autocomplete="off" value="${escapeAttr(fam.divorcePlace || '')}" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
            </div>
            ${qeChildLinkageRowsHtml(fam)}
          </div>`;
      }).join('');
    }

    function qeChildLinkageRowsHtml(fam) {
      const kids = (fam.children || []).filter((c) => c && appState.persons[c.personId]);
      if (!kids.length) return '';
      return `
            <div class="space-y-2">
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Children</div>
              ${kids.map((c) => {
                const child = appState.persons[c.personId];
                const selId = 'qe-child-link-' + fam.id + '-' + child.id;
                return `
                <div class="flex items-center justify-between gap-2">
                  <label class="min-w-0 text-xs font-medium text-slate-900 truncate" for="${escapeAttr(selId)}">${escapeHtml(getDisplayNameWithMaiden(child))}</label>
                  <select id="${escapeAttr(selId)}" data-qe-linkage data-qe-linkage-fam="${escapeAttr(fam.id)}" data-qe-linkage-child="${escapeAttr(child.id)}" aria-label="Parent link type for ${escapeAttr(getDisplayName(child))}" class="shrink-0 max-w-[7.5rem] px-1.5 py-1 text-[11px] bg-white border border-stone-300 rounded-lg">
                    ${linkageOptionsHtml(c.linkage)}
                  </select>
                </div>`;
              }).join('')}
            </div>`;
    }

    function qeParentLinksHtml(person) {
      const blocks = [];
      Object.values(appState.families || {}).forEach((f) => {
        const selfChild = (f.children || []).find((c) => c && c.personId === person.id);
        if (!selfChild) return;
        const p1 = f.partner1Id && appState.persons[f.partner1Id];
        const p2 = f.partner2Id && appState.persons[f.partner2Id];
        const names = [p1, p2].filter(Boolean).map((p) => getDisplayNameWithMaiden(p));
        const label = names.length ? names.join(' and ') : 'Parents';
        const selId = 'qe-parent-link-' + f.id;
        blocks.push(`
          <div class="space-y-1.5 rounded-xl border border-stone-200 bg-stone-50 p-3" data-qe-parent-fam="${escapeAttr(f.id)}">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Parents</div>
            <div class="text-sm font-medium text-slate-900">${escapeHtml(label)}</div>
            <label class="block text-[11px] font-medium text-slate-600 mb-1" for="${escapeAttr(selId)}">Relationship</label>
            <select id="${escapeAttr(selId)}" data-qe-linkage data-qe-linkage-fam="${escapeAttr(f.id)}" data-qe-linkage-child="${escapeAttr(person.id)}" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg">
              ${linkageOptionsHtml(selfChild.linkage)}
            </select>
          </div>`);
      });
      return blocks.join('');
    }

    function qeSyncLivingUi() {
      const living = document.querySelector('#form-quick-edit input[name="qeLiving"]:checked')?.value !== 'deceased';
      document.getElementById('qe-living-fields')?.classList.toggle('hidden', !living);
      document.getElementById('qe-death-fields')?.classList.toggle('hidden', living);
    }

    function qeSyncBirthHidden() {
      const hidden = document.getElementById('qe-birth-date-hidden');
      if (hidden) hidden.value = qeReadDate('birth');
    }

    function qeEnsureEvent(person, type) {
      person.events = person.events || [];
      let ev = person.events.find((item) => item && item.type === type);
      if (!ev) {
        ev = { id: generateId('ev'), type, date: '', place: '' };
        person.events.push(ev);
      }
      return ev;
    }

    function qeClearEmptyEvent(person, type) {
      if (!person.events) return;
      const ev = person.events.find((item) => item && item.type === type);
      if (!ev) return;
      const hasHindu = ev.tithi || ev.paksha || ev.masa;
      if (!ev.date && !ev.place && !ev.cause && !hasHindu) {
        person.events = person.events.filter((item) => item !== ev);
      }
    }

    function fillQuickEditForm(person) {
      const birt = (person.events || []).find((e) => e && e.type === 'BIRT') || {};
      const deat = (person.events || []).find((e) => e && e.type === 'DEAT') || {};
      const buri = (person.events || []).find((e) => e && e.type === 'BURI') || {};
      document.getElementById('qe-name-heading').textContent = getDisplayNameWithMaiden(person);
      qeSetAvatar(person);
      const sex = person.sex === 'M' || person.sex === 'F' ? person.sex : 'U';
      document.querySelectorAll('#form-quick-edit input[name="qeSex"]').forEach((el) => { el.checked = el.value === sex; });
      document.getElementById('qe-given').value = person.given || '';
      document.getElementById('qe-surname').value = person.surname || '';
      document.getElementById('qe-alt').value = person.altName || '';
      qeFillAffixSelect(document.getElementById('qe-prefix'), QE_PREFIX_OPTIONS, person.prefix || '');
      qeFillAffixSelect(document.getElementById('qe-suffix'), QE_SUFFIX_OPTIONS, person.suffix || '');
      document.getElementById('qe-birth-date').innerHTML = qeDateControlsHtml('birth', birt.date || '');
      document.getElementById('qe-birth-place').value = birt.place || '';
      qeSyncBirthHidden();
      const living = person.livingStatus === 'deceased' ? 'deceased' : 'living';
      document.querySelectorAll('#form-quick-edit input[name="qeLiving"]').forEach((el) => { el.checked = el.value === living; });
      document.getElementById('qe-email').value = (person.emails && person.emails[0]) || '';
      document.getElementById('qe-death-date').innerHTML = qeDateControlsHtml('death', deat.date || '');
      document.getElementById('qe-death-place').value = deat.place || '';
      document.getElementById('qe-death-cause').value = deat.cause || '';
      document.getElementById('qe-burial-place').value = buri.place || '';
      const parentsEl = document.getElementById('qe-parents');
      if (parentsEl) parentsEl.innerHTML = qeParentLinksHtml(person);
      document.getElementById('qe-spouses').innerHTML = qeSpouseBlockHtml(person);
      qeSyncLivingUi();
    }

    function setQuickEditEditable(editable) {
      const form = document.getElementById('form-quick-edit');
      if (!form) return;
      form.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = !editable; });
      const ok = document.getElementById('btn-qe-ok');
      const invite = document.getElementById('btn-qe-invite');
      if (ok) ok.classList.toggle('hidden', !editable);
      if (invite) invite.disabled = !editable;
    }

    function openQuickEditModal(personId) {
      const id = personId || appState.selectedPersonId;
      const person = id && appState.persons[id];
      const modal = document.getElementById('modal-quick-edit');
      if (!person || !modal) return;
      appState.selectedPersonId = id;
      quickEditPersonId = id;
      fillQuickEditForm(person);
      const editable = canEditTree();
      setQuickEditEditable(editable);
      modal.classList.remove('hidden');
      applyEditLockUi();
      const focusEl = document.getElementById('qe-given');
      if (focusEl && editable) {
        try { focusEl.focus(); } catch (err) {}
      }
    }

    function closeQuickEditModal() {
      const modal = document.getElementById('modal-quick-edit');
      if (!modal || modal.classList.contains('hidden')) {
        quickEditPersonId = null;
        return;
      }
      modal.classList.add('hidden');
      quickEditPersonId = null;
      applyEditLockUi();
    }

    function saveQuickEdit() {
      if (!canEditTree()) return;
      const id = quickEditPersonId || appState.selectedPersonId;
      if (!id || !appState.persons[id]) return;
      qeSyncBirthHidden();
      const given = (document.getElementById('qe-given')?.value || '').trim();
      const surname = (document.getElementById('qe-surname')?.value || '').trim();
      const altName = (document.getElementById('qe-alt')?.value || '').trim();
      const prefix = (document.getElementById('qe-prefix')?.value || '').trim();
      const suffix = (document.getElementById('qe-suffix')?.value || '').trim();
      const sex = document.querySelector('#form-quick-edit input[name="qeSex"]:checked')?.value || 'U';
      const livingStatus = document.querySelector('#form-quick-edit input[name="qeLiving"]:checked')?.value || 'living';
      const birthDate = qeReadDate('birth');
      const birthPlace = (document.getElementById('qe-birth-place')?.value || '').trim();
      const form = document.getElementById('form-quick-edit');
      const email = (document.getElementById('qe-email')?.value || '').trim().toLowerCase();
      const deathDate = qeReadDate('death');
      const deathPlace = (document.getElementById('qe-death-place')?.value || '').trim();
      const deathCause = (document.getElementById('qe-death-cause')?.value || '').trim();
      const burialPlace = (document.getElementById('qe-burial-place')?.value || '').trim();
      const unions = [...document.querySelectorAll('#qe-spouses [data-qe-union]')].map((block) => {
        const id = block.getAttribute('data-qe-union');
        const status = normalizeUnionStatus(block.querySelector('[data-qe-union-status]')?.value);
        return {
          id,
          status,
          marriageDate: qeReadDate('marr-' + id),
          marriagePlace: (block.querySelector('[data-qe-union-place]')?.value || '').trim(),
          divorceDate: qeReadDate('div-' + id),
          divorcePlace: (block.querySelector('[data-qe-divorce-place]')?.value || '').trim()
        };
      });
      const linkages = [...document.querySelectorAll('#form-quick-edit [data-qe-linkage]')].map((el) => ({
        famId: el.getAttribute('data-qe-linkage-fam'),
        childId: el.getAttribute('data-qe-linkage-child'),
        linkage: normalizeLinkage(el.value)
      }));
      commitMutation('Updated profile', (s) => {
        const p = s.persons[id];
        if (!p) return;
        p.given = given;
        p.surname = surname;
        p.altName = altName;
        p.prefix = prefix;
        p.suffix = suffix;
        if (!p.prefix) delete p.prefix;
        if (!p.suffix) delete p.suffix;
        p.sex = sex;
        p.livingStatus = livingStatus;
        const birt = qeEnsureEvent(p, 'BIRT');
        birt.date = birthDate;
        birt.place = birthPlace;
        qeClearEmptyEvent(p, 'BIRT');
        if (livingStatus === 'living') {
          if (email) {
            p.emails = p.emails || [];
            if (!p.emails.some((em) => em.toLowerCase() === email)) p.emails.unshift(email);
            else p.emails = [email, ...p.emails.filter((em) => em.toLowerCase() !== email)];
          }
        } else {
          const deat = qeEnsureEvent(p, 'DEAT');
          deat.date = deathDate;
          deat.place = deathPlace;
          if (deathCause) deat.cause = deathCause; else delete deat.cause;
          if (burialPlace) {
            const buri = qeEnsureEvent(p, 'BURI');
            buri.place = burialPlace;
          } else {
            qeClearEmptyEvent(p, 'BURI');
          }
          qeClearEmptyEvent(p, 'DEAT');
        }
        unions.forEach((row) => {
          const fam = s.families[row.id];
          if (!fam) return;
          fam.status = row.status;
          fam.marriageDate = row.marriageDate;
          fam.marriagePlace = row.marriagePlace;
          if (unionShowsDivorceFields(row.status)) {
            fam.divorceDate = row.divorceDate;
            fam.divorcePlace = row.divorcePlace;
          }
        });
        linkages.forEach((row) => {
          const family = s.families[row.famId];
          if (!family || !row.childId) return;
          family.children = family.children || [];
          const rec = family.children.find((c) => c.personId === row.childId);
          if (rec) rec.linkage = row.linkage;
          else family.children.push({ personId: row.childId, linkage: row.linkage });
        });
      });
      closeQuickEditModal();
      renderAll();
    }

    function qeInviteToSite() {
      if (!canEditTree()) return;
      const id = quickEditPersonId || appState.selectedPersonId;
      const person = id && appState.persons[id];
      const newEmail = (document.getElementById('qe-email')?.value || '').trim().toLowerCase();
      if (!person) return;
      if (!newEmail) { showToast('Enter an email address first.'); return; }
      const manage = canManageAccess();
      const emailRole = manage ? 'view' : null;
      const summary = manage
        ? `Linked Google user ${newEmail} (${emailRole})`
        : `Added email ${newEmail} (sign-in access is granted only by the Super Admin)`;
      commitMutation(summary, (s) => {
        const p = s.persons[id];
        if (!p) return;
        p.emails = p.emails || [];
        if (!p.emails.some((em) => em.toLowerCase() === newEmail)) p.emails.push(newEmail);
        if (!canManageAccess(s)) return;
        const perms = s.accessControl.permissions || [];
        const existing = perms.find((pm) => pm.email.toLowerCase() === newEmail);
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
      const origin = location.origin;
      const subject = encodeURIComponent('Invitation to ' + getSiteTitle());
      const body = encodeURIComponent(`You are invited to view our family tree.\n\n${origin}\n`);
      const link = document.createElement('a');
      link.href = `mailto:${encodeURIComponent(newEmail)}?subject=${subject}&body=${body}`;
      link.rel = 'noopener';
      link.click();
      showToast('Email saved. A mail draft opened; nothing was sent automatically.');
    }

    function initQuickEdit() {
      const modal = document.getElementById('modal-quick-edit');
      const form = document.getElementById('form-quick-edit');
      if (!modal || !form || modal.dataset.qeReady) return;
      modal.dataset.qeReady = '1';
      modal.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('[data-qe-cancel]')) {
          e.preventDefault();
          closeQuickEditModal();
        }
      });
      document.getElementById('btn-qe-close')?.addEventListener('click', (e) => {
        e.preventDefault();
        closeQuickEditModal();
      });
      document.getElementById('btn-qe-more')?.addEventListener('click', (e) => {
        e.preventDefault();
        const id = quickEditPersonId || appState.selectedPersonId;
        closeQuickEditModal();
        if (!id) return;
        openInspector(id, 'edit');
      });
      document.getElementById('btn-qe-invite')?.addEventListener('click', (e) => {
        e.preventDefault();
        qeInviteToSite();
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        saveQuickEdit();
      });
      form.addEventListener('change', (e) => {
        const t = e.target;
        if (!t) return;
        if (t.name === 'qeLiving') qeSyncLivingUi();
        if (t.hasAttribute && t.hasAttribute('data-qe-union-status')) {
          const block = t.closest('[data-qe-union]');
          if (block) {
            const st = normalizeUnionStatus(t.value);
            const head = block.querySelector('[data-qe-union-heading]');
            if (head) head.textContent = unionSpouseHeading(st);
            block.querySelector('[data-qe-divorce-fields]')?.classList.toggle('hidden', !unionShowsDivorceFields(st));
          }
        }
        const dateBox = t.closest && t.closest('[data-qe-date]');
        if (dateBox) {
          if (t.hasAttribute('data-qe-mode')) qeSyncDateUi(dateBox);
          if (dateBox.getAttribute('data-qe-date') === 'birth') qeSyncBirthHidden();
        }
      });
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

    const TOAST_BANNER_CLASS = 'hidden fixed bottom-14 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-xs font-medium px-4 py-2 rounded-full shadow-lg z-50 max-w-[calc(100vw-24px)]';
    function showToast(msg) {
      const banner = document.getElementById('toast-banner');
      if (!banner) return;
      banner.replaceChildren();
      banner.className = TOAST_BANNER_CLASS;
      banner.textContent = msg;
      banner.classList.remove('hidden');
      clearTimeout(banner._timer);
      banner._timer = setTimeout(() => {
        banner.classList.add('hidden');
      }, 4000);
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
      inspectorTab: 'profile', // 'profile' | 'edit' | 'add'
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

    function readMainPayloadJson(mainData) {
      if (!mainData) return null;
      if (typeof mainData.payloadJson === 'string') return mainData.payloadJson;
      return null;
    }
    function prepareMainFields(baseMeta, json, _storedMain) {
      const reserved = reservedSizeForFields(baseMeta, 'payloadJson', getArchiveDocPath());
      const fit = jsonFitsInDoc(json, reserved);
      return { fields: { ...baseMeta, payloadJson: json }, total: fit.total, rulesOk: fit.rulesOk, ok: fit.ok, compressed: false };
    }

    let addBarHoverId = null;
    let addBarHideTimer = null;
    function isMouseLikePointer(e) {
      const t = e.pointerType;
      if (t) return t === 'mouse' || t === 'pen';
      return e.type === 'mouseover' || e.type === 'mouseout';
    }
    function clearAddBarOpen() {
      addBarHoverId = null;
      document.querySelectorAll('.person-card.add-bar-open').forEach((el) => el.classList.remove('add-bar-open'));
    }
    function openAddBarOnCard(card) {
      if (addBarHideTimer) {
        clearTimeout(addBarHideTimer);
        addBarHideTimer = null;
      }
      if (!card || !canEditTree() || !card.querySelector('.canvas-add-bar')) return;
      const id = card.dataset.personCard;
      if (addBarHoverId === id && card.classList.contains('add-bar-open')) return;
      document.querySelectorAll('.person-card.add-bar-open').forEach((el) => {
        if (el !== card) el.classList.remove('add-bar-open');
      });
      addBarHoverId = id || null;
      card.classList.add('add-bar-open');
    }
    function scheduleHideAddBar() {
      if (addBarHideTimer) clearTimeout(addBarHideTimer);
      addBarHideTimer = setTimeout(() => {
        addBarHideTimer = null;
        clearAddBarOpen();
      }, 180);
    }

    function canAccessAdminPanel() {
      if (!firebaseUser || !firebaseUser.email) return false;
      const role = getEffectiveSessionRole();
      return role === 'super_admin' || role === 'admin';
    }


    function yearFromPersonEvent(person, type) {
      const ev = (person && person.events || []).find(e => e && e.type === type && e.date);
      if (!ev) return null;
      if (typeof parseFlexibleDateParts === 'function') {
        const parsed = parseFlexibleDateParts(ev.date);
        if (parsed && parsed.year) return Number(parsed.year);
      }
      const m = String(ev.date).match(/\b((?:1[5-9]|20)\d{2})\b/);
      return m ? Number(m[1]) : null;
    }

    function normalizePersonName(text) {
      return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function personFullName(person) {
      if (!person) return '';
      return `${person.given || ''} ${person.surname || ''}`.trim() || 'Unnamed individual';
    }

    function personNameKey(person) {
      return normalizePersonName(`${person.given || ''} ${person.surname || ''} ${person.altName || ''}`);
    }

    function parentIdsOf(personId, families) {
      const ids = [];
      Object.values(families || {}).forEach(fam => {
        const kids = fam && fam.children || [];
        const hit = kids.some(c => (c && (c.personId || c)) === personId);
        if (!hit) return;
        if (fam.partner1Id) ids.push(fam.partner1Id);
        if (fam.partner2Id) ids.push(fam.partner2Id);
      });
      return [...new Set(ids)].sort();
    }

    function arePartners(personA, personB, families) {
      return Object.values(families || {}).some(fam => {
        const ids = [fam.partner1Id, fam.partner2Id];
        return ids.includes(personA) && ids.includes(personB);
      });
    }

    function scoreDuplicatePair(a, b, families) {
      if (!a || !b || a.id === b.id) return 0;
      const na = personNameKey(a);
      const nb = personNameKey(b);
      if (!na || !nb) return 0;
      let score = 0;
      if (na === nb) score += 40;
      else if (na.includes(nb) || nb.includes(na)) score += 24;
      else {
        const ta = new Set(na.split(' ').filter(t => t.length > 1));
        const tb = new Set(nb.split(' ').filter(t => t.length > 1));
        const inter = [...ta].filter(t => tb.has(t));
        if (!inter.length) return 0;
        score += inter.length >= 2 ? 32 : 10;
      }
      const byA = yearFromPersonEvent(a, 'BIRT');
      const byB = yearFromPersonEvent(b, 'BIRT');
      if (byA && byB) {
        const d = Math.abs(byA - byB);
        if (d === 0) score += 25;
        else if (d <= 1) score += 15;
        else if (d <= 3) score += 6;
        else if (d > 15) score -= 20;
      }
      const dyA = yearFromPersonEvent(a, 'DEAT');
      const dyB = yearFromPersonEvent(b, 'DEAT');
      if (dyA && dyB) {
        const d = Math.abs(dyA - dyB);
        if (d === 0) score += 12;
        else if (d > 15) score -= 10;
      }
      const pa = parentIdsOf(a.id, families);
      const pb = parentIdsOf(b.id, families);
      if (pa.length && pb.length) {
        const shared = pa.filter(id => pb.includes(id));
        if (shared.length && pa.join(',') === pb.join(',')) score += 25;
        else if (shared.length) score += 12;
      }
      if (a.sex && b.sex && a.sex !== 'U' && b.sex !== 'U' && a.sex !== b.sex) score -= 8;
      return score;
    }

    const DUPLICATE_SCORE_MIN = 55;

    function findDuplicatePairs(stateObj, minScore) {
      const floor = typeof minScore === 'number' ? minScore : DUPLICATE_SCORE_MIN;
      const persons = Object.values((stateObj || appState).persons || {});
      const families = (stateObj || appState).families || {};
      const pairs = [];
      for (let i = 0; i < persons.length; i++) {
        for (let j = i + 1; j < persons.length; j++) {
          const score = scoreDuplicatePair(persons[i], persons[j], families);
          if (score >= floor) {
            pairs.push({
              a: persons[i].id,
              b: persons[j].id,
              score,
              partners: arePartners(persons[i].id, persons[j].id, families)
            });
          }
        }
      }
      pairs.sort((x, y) => y.score - x.score || String(x.a).localeCompare(String(y.a)));
      return pairs;
    }

    function eventDedupeKey(ev) {
      return `${ev && ev.type || ''}|${ev && ev.date || ''}|${ev && ev.place || ''}`;
    }

    function mergePeopleIntoState(stateObj, primaryId, secondaryId, opts) {
      const state = stateObj || appState;
      const primary = state.persons && state.persons[primaryId];
      const secondary = state.persons && state.persons[secondaryId];
      if (!primary || !secondary) return { ok: false, error: 'Both people must still exist.' };
      if (primaryId === secondaryId) return { ok: false, error: 'Cannot merge a person with themselves.' };
      if (arePartners(primaryId, secondaryId, state.families)) {
        return { ok: false, error: 'These two people are partners in a union. Unlink that relationship before merging.' };
      }
      const choices = (opts && opts.fields) || {};
      const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
      const pick = (field, a, b) => {
        if (choices[field] === 'secondary') return b;
        if (choices[field] === 'primary') return a;
        return isEmpty(a) ? b : a;
      };
      const scalarFields = ['given', 'surname', 'altName', 'prefix', 'suffix', 'sex', 'livingStatus', 'bio', 'photoUrl', 'village'];
      scalarFields.forEach(field => { primary[field] = pick(field, primary[field], secondary[field]); });
      const emails = [...new Set([...(primary.emails || []), ...(secondary.emails || [])]
        .map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
      primary.emails = emails;
      const events = [...(primary.events || [])];
      const seenEv = new Set(events.map(eventDedupeKey));
      (secondary.events || []).forEach(ev => {
        const key = eventDedupeKey(ev);
        if (seenEv.has(key)) return;
        seenEv.add(key);
        events.push({ ...ev, id: ev.id || ('ev_mrg_' + Math.random().toString(36).slice(2, 8)) });
      });
      primary.events = events;
      const media = [...(primary.media || [])];
      const mediaKeys = new Set(media.map(m => m && (m.id || m.url || JSON.stringify(m))));
      (secondary.media || []).forEach(item => {
        const key = item && (item.id || item.url || JSON.stringify(item));
        if (mediaKeys.has(key)) return;
        mediaKeys.add(key);
        media.push(item);
      });
      primary.media = media;
      const assertions = [...(primary.assertions || []), ...(secondary.assertions || [])];
      primary.assertions = assertions;
      if (secondary.customTags && typeof secondary.customTags === 'object') {
        primary.customTags = { ...(secondary.customTags || {}), ...(primary.customTags || {}) };
      }
      Object.values(state.families || {}).forEach(fam => {
        if (!fam) return;
        if (fam.partner1Id === secondaryId) fam.partner1Id = primaryId;
        if (fam.partner2Id === secondaryId) fam.partner2Id = primaryId;
        if (!Array.isArray(fam.children)) return;
        const hasPrimary = fam.children.some(c => (c && (c.personId || c)) === primaryId);
        fam.children = fam.children.map(c => {
          const id = c && (c.personId || c);
          if (id !== secondaryId) return c;
          if (hasPrimary) return null;
          if (c && typeof c === 'object') return { ...c, personId: primaryId };
          return { personId: primaryId, linkage: 'biological' };
        }).filter(Boolean);
      });
      ((state.accessControl && state.accessControl.permissions) || []).forEach(pm => {
        if (pm && pm.personId === secondaryId) pm.personId = primaryId;
      });
      if (state.centralPersonId === secondaryId) state.centralPersonId = primaryId;
      if (state.selectedPersonId === secondaryId) state.selectedPersonId = primaryId;
      delete state.persons[secondaryId];
      return { ok: true, primaryId, secondaryId };
    }


    let mergeCompareState = null;

    function canRunMergeTool() {
      if (typeof canEditTree === 'function') return canEditTree();
      if (typeof isAdminAuthorized === 'function') return isAdminAuthorized();
      return false;
    }

    function openMergeDuplicatesDialog() {
      if (!canRunMergeTool()) {
        showToast('Sign in with an Editor or Admin account to merge people.');
        return;
      }
      const modal = document.getElementById('merge-duplicates-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      mergeCompareState = null;
      renderMergeDuplicatesModal();
      const first = modal.querySelector('button, [href], input, select, textarea');
      if (first) first.focus();
    }

    function closeMergeDuplicatesDialog() {
      const modal = document.getElementById('merge-duplicates-modal');
      if (modal) modal.classList.add('hidden');
      mergeCompareState = null;
    }

    function personCompareFacts(person, stateObj) {
      const families = (stateObj || appState).families || {};
      const birth = (person.events || []).find(e => e.type === 'BIRT');
      const death = (person.events || []).find(e => e.type === 'DEAT');
      const parentIds = parentIdsOf(person.id, families);
      const parentNames = parentIds.map(id => personFullName((stateObj || appState).persons[id])).filter(Boolean);
      let partnerCount = 0;
      let childCount = 0;
      Object.values(families).forEach(fam => {
        if (fam.partner1Id === person.id || fam.partner2Id === person.id) {
          partnerCount += 1;
          childCount += (fam.children || []).length;
        } else if ((fam.children || []).some(c => (c && (c.personId || c)) === person.id)) {
          /* listed as a child only */
        }
      });
      return {
        name: personFullName(person),
        given: person.given || '',
        surname: person.surname || '',
        altName: person.altName || '',
        sex: person.sex || '',
        livingStatus: person.livingStatus || '',
        village: person.village || '',
        bio: person.bio || '',
        photoUrl: person.photoUrl || '',
        emails: (person.emails || []).join(', '),
        birth: birth ? `${birth.date || ''} ${birth.place || ''}`.trim() : '',
        death: death ? `${death.date || ''} ${death.place || ''}`.trim() : '',
        parents: parentNames.join(' · ') || '—',
        unions: String(partnerCount),
        children: String(childCount),
        eventCount: String((person.events || []).length)
      };
    }

    const MERGE_COMPARE_FIELDS = [
      ['given', 'Given name'],
      ['surname', 'Surname'],
      ['altName', 'Also known as'],
      ['sex', 'Sex'],
      ['livingStatus', 'Living status'],
      ['birth', 'Birth'],
      ['death', 'Death'],
      ['village', 'Place / village'],
      ['emails', 'Emails'],
      ['bio', 'Notes'],
      ['photoUrl', 'Photo'],
      ['parents', 'Parents'],
      ['unions', 'Unions'],
      ['children', 'Children in unions'],
      ['eventCount', 'Recorded events']
    ];

    function renderMergeDuplicatesModal() {
      const listEl = document.getElementById('merge-dup-list');
      const compareEl = document.getElementById('merge-dup-compare');
      const statusEl = document.getElementById('merge-dup-status');
      if (!listEl || !compareEl) return;
      if (mergeCompareState) {
        listEl.classList.add('hidden');
        compareEl.classList.remove('hidden');
        renderMergeCompare(compareEl);
        if (statusEl) statusEl.textContent = 'Compare the two records, choose who to keep, then merge.';
        return;
      }
      listEl.classList.remove('hidden');
      compareEl.classList.add('hidden');
      const pairs = findDuplicatePairs(appState);
      if (statusEl) {
        statusEl.textContent = pairs.length
          ? `Found ${pairs.length} likely duplicate pair${pairs.length === 1 ? '' : 's'}.`
          : 'No likely duplicates found (same or very similar name, plus a matching date or shared parents).';
      }
      if (!pairs.length) {
        listEl.innerHTML = '<p class="text-sm text-slate-600 px-1 py-6 text-center">Nothing to merge right now. You can still open this later if a person was entered twice.</p>';
        return;
      }
      listEl.innerHTML = pairs.slice(0, 80).map(pair => {
        const a = appState.persons[pair.a];
        const b = appState.persons[pair.b];
        const partnerNote = pair.partners
          ? '<span class="text-[10px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Partners — unlink first</span>'
          : '';
        return `<button type="button" class="merge-dup-row w-full text-left rounded-xl border border-parchment-300 bg-parchment-50 hover:bg-white hover:border-archival-indigo px-3 py-2.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3" data-merge-a="${escapeHtml(pair.a)}" data-merge-b="${escapeHtml(pair.b)}">
          <span class="flex-1 min-w-0">
            <span class="block text-sm font-semibold text-slate-900 truncate">${escapeHtml(personFullName(a))}</span>
            <span class="block text-xs text-slate-600 truncate">${escapeHtml(personFullName(b))}</span>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            ${partnerNote}
            <span class="text-[10px] font-mono text-slate-500">score ${pair.score}</span>
          </span>
        </button>`;
      }).join('');
    }

    function renderMergeCompare(compareEl) {
      const { a, b, keep } = mergeCompareState;
      const personA = appState.persons[a];
      const personB = appState.persons[b];
      if (!personA || !personB) {
        compareEl.innerHTML = '<p class="text-sm text-rose-700">One of these people is no longer in the tree.</p>';
        return;
      }
      const factsA = personCompareFacts(personA, appState);
      const factsB = personCompareFacts(personB, appState);
      const partnerBlock = arePartners(a, b, appState.families)
        ? '<p class="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">These two people are partners in a union. Unlink that relationship before merging.</p>'
        : '';
      const fieldRows = MERGE_COMPARE_FIELDS.map(([key, label]) => {
        const left = key === 'photoUrl' ? (factsA.photoUrl ? 'Has a photo' : '—') : (factsA[key] || '—');
        const right = key === 'photoUrl' ? (factsB.photoUrl ? 'Has a photo' : '—') : (factsB[key] || '—');
        const differ = String(factsA[key] || '') !== String(factsB[key] || '');
        return `<tr class="${differ ? 'bg-amber-50/60' : ''}">
          <th class="text-left text-[11px] font-semibold text-slate-600 px-2 py-1.5 align-top whitespace-nowrap">${escapeHtml(label)}</th>
          <td class="text-xs text-slate-800 px-2 py-1.5 align-top break-words">${escapeHtml(left)}</td>
          <td class="text-xs text-slate-800 px-2 py-1.5 align-top break-words">${escapeHtml(right)}</td>
        </tr>`;
      }).join('');
      compareEl.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <button type="button" id="merge-dup-back" class="text-xs font-semibold text-archival-indigo hover:underline">← All matches</button>
        </div>
        ${partnerBlock}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="border rounded-xl p-3 cursor-pointer ${keep === a ? 'border-archival-indigo bg-indigo-50/40' : 'border-parchment-300'}">
            <input type="radio" name="merge-keep" value="${escapeHtml(a)}" ${keep === a ? 'checked' : ''} class="mr-2 align-middle" />
            <span class="text-sm font-semibold text-slate-900">Keep this person</span>
            <div class="mt-1 text-sm text-slate-800">${escapeHtml(factsA.name)}</div>
            <div class="text-[10px] font-mono text-slate-500">${escapeHtml(a)}</div>
          </label>
          <label class="border rounded-xl p-3 cursor-pointer ${keep === b ? 'border-archival-indigo bg-indigo-50/40' : 'border-parchment-300'}">
            <input type="radio" name="merge-keep" value="${escapeHtml(b)}" ${keep === b ? 'checked' : ''} class="mr-2 align-middle" />
            <span class="text-sm font-semibold text-slate-900">Keep this person</span>
            <div class="mt-1 text-sm text-slate-800">${escapeHtml(factsB.name)}</div>
            <div class="text-[10px] font-mono text-slate-500">${escapeHtml(b)}</div>
          </label>
        </div>
        <div class="overflow-auto max-h-[42vh] border border-parchment-200 rounded-xl">
          <table class="w-full text-left">
            <thead class="bg-parchment-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr><th class="px-2 py-1.5">Field</th><th class="px-2 py-1.5">Left</th><th class="px-2 py-1.5">Right</th></tr>
            </thead>
            <tbody>${fieldRows}</tbody>
          </table>
        </div>
        <p class="text-[11px] text-slate-500">The kept person receives the other record’s relationships, emails, events, and notes. Empty fields on the kept person are filled from the other. This is written to the change log and can be reverted.</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="merge-dup-close px-3 py-2 text-xs font-semibold rounded-xl border border-parchment-300 text-slate-700">Cancel</button>
          <button type="button" id="merge-dup-apply" class="px-3 py-2 text-xs font-semibold rounded-xl bg-archival-indigo text-white disabled:opacity-40">Merge into the kept person</button>
        </div>`;
    }

    function applySelectedMerge() {
      if (!mergeCompareState) return;
      const primaryId = mergeCompareState.keep;
      const secondaryId = primaryId === mergeCompareState.a ? mergeCompareState.b : mergeCompareState.a;
      if (arePartners(primaryId, secondaryId, appState.families)) {
        showToast('These two people are partners in a union. Unlink that relationship before merging.');
        return;
      }
      const summary = `Merged duplicate person ${secondaryId} into ${primaryId}`;
      const run = (state) => {
        const result = mergePeopleIntoState(state, primaryId, secondaryId);
        if (!result.ok) throw new Error(result.error || 'Merge failed.');
      };
      const finish = (ok) => {
        if (ok === false) return;
        mergeCompareState = null;
        renderMergeDuplicatesModal();
      };
      if (typeof commitMutation === 'function') {
        finish(commitMutation(summary, run, 'Tree Data'));
      } else if (typeof commitTreeDataMutation === 'function') {
        Promise.resolve(commitTreeDataMutation(summary, run)).then(finish);
      } else {
        showToast('Merge is unavailable on this page.');
      }
    }

    function bindMergeDuplicatesUi() {
      const modal = document.getElementById('merge-duplicates-modal');
      if (!modal || modal.dataset.bound === '1') return;
      modal.dataset.bound = '1';
      modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.id === 'merge-dup-cancel' || event.target.closest('.merge-dup-close') || event.target.id === 'merge-dup-backdrop') {
          closeMergeDuplicatesDialog();
          return;
        }
        const row = event.target.closest('.merge-dup-row');
        if (row) {
          mergeCompareState = { a: row.dataset.mergeA, b: row.dataset.mergeB, keep: row.dataset.mergeA };
          renderMergeDuplicatesModal();
          return;
        }
        if (event.target.id === 'merge-dup-back') {
          mergeCompareState = null;
          renderMergeDuplicatesModal();
          return;
        }
        if (event.target.id === 'merge-dup-apply') applySelectedMerge();
      });
      modal.addEventListener('change', (event) => {
        if (event.target && event.target.name === 'merge-keep' && mergeCompareState) {
          mergeCompareState.keep = event.target.value;
          renderMergeDuplicatesModal();
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeMergeDuplicatesDialog();
      });
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
      stopEditLocks();
    }

    /* =====================================================================
     * PER-PERSON EDIT LOCKS (prototype, src/edit-locks.js)
     * Off until the lock rules are deployed (EDIT_LOCKS_ENABLED). When on,
     * opening an edit form for a person takes a lock under the configured archive;
     * others see "X is editing" live and their edit form for that person is
     * paused. If locks cannot be used (rules missing, offline), editing goes on
     * and the revision guard still refuses a conflicting save.
     * ===================================================================== */
    const EDIT_LOCKS_ENABLED = false;
    let editLockManager = null;
    const heldLockIds = new Set();
    function startEditLocks() {
      if (!EDIT_LOCKS_ENABLED || editLockManager || !db || !firebaseUser) return;
      editLockManager = createEditLockManager({
        db,
        fsApi: { doc, collection, onSnapshot, runTransaction, deleteDoc, serverTimestamp, Timestamp },
        user: { uid: firebaseUser.uid, email: firebaseUser.email, name: (sessionAuth && sessionAuth.displayName) || firebaseUser.email },
        onChange: () => applyEditLockUi(),
        onError: (err) => console.warn('Edit locks unavailable:', err && err.code)
      });
      editLockManager.watch();
    }
    function stopEditLocks() {
      if (editLockManager) { try { editLockManager.stop(); } catch (e) {} }
      editLockManager = null;
      heldLockIds.clear();
    }
    window.addEventListener('pagehide', () => { if (editLockManager) editLockManager.releaseAll(); heldLockIds.clear(); });
    function personEditFormOpen() {
      return Boolean(quickEditIsOpen() || (uiState.inspectorOpen && canEditTree()
        && (uiState.inspectorTab === 'edit' || uiState.inspectorTab === 'add' || uiState.editingFactItem || uiState.showFactAddForm)));
    }
    function formatLockClock(ts) {
      const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : Number(ts) || 0;
      if (!ms) return '';
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    function applyEditLockUi() {
      const roots = [];
      const insp = document.getElementById('inspector-body');
      if (insp) roots.push(insp);
      const qeSlot = document.getElementById('qe-lock-slot');
      const qeModal = document.getElementById('modal-quick-edit');
      if (qeSlot && qeModal && !qeModal.classList.contains('hidden')) roots.push(qeSlot);
      if (!roots.length) return;
      for (const body of roots) {
        body.querySelectorAll('[data-edit-lock-banner]').forEach(el => el.remove());
        const scope = body.id === 'qe-lock-slot' ? qeModal : body;
        scope.querySelectorAll('[data-lock-disabled]').forEach(el => { el.disabled = false; el.removeAttribute('data-lock-disabled'); });
      }
      const pid = appState.selectedPersonId;
      if (!editLockManager) return;
      const editing = Boolean(pid) && personEditFormOpen();
      for (const id of [...heldLockIds]) {
        if (id !== pid || !editing) { heldLockIds.delete(id); editLockManager.release(id); }
      }
      if (!pid) return;
      const lock = editLockManager.lockFor(pid);
      const other = lock && lock.live && !lock.mine ? lock : null;
      if (editing && !other && !heldLockIds.has(pid)) {
        heldLockIds.add(pid);
        editLockManager.acquire(pid).then((r) => { if (!r.ok) { heldLockIds.delete(pid); applyEditLockUi(); } }).catch(() => { heldLockIds.delete(pid); });
      }
      if (!other) return;
      const who = escapeHtml(other.holderName || other.holderEmail || 'Someone');
      const until = formatLockClock(other.expiresAt);
      for (const body of roots) {
        const banner = document.createElement('div');
        banner.setAttribute('data-edit-lock-banner', pid);
        banner.setAttribute('role', 'status');
        banner.className = 'mx-4 mt-3 mb-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900';
        banner.innerHTML = `<div class="font-semibold">🔒 ${who} is editing this person right now.</div>`
          + `<div class="mt-0.5">${editing ? 'Your edit form is paused so the two of you do not overwrite each other. It unlocks as soon as they finish' : 'You can view; editing unlocks when they finish'}${until ? ` (at the latest about ${escapeHtml(until)} if their page closes)` : ''}.</div>`
          + (canAccessAdminPanel() ? `<button type="button" data-force-release-lock="${escapeAttr(pid)}" class="mt-1.5 text-[11px] font-semibold text-rose-700 hover:underline">Force release (admin)</button>` : '');
        body.prepend(banner);
        if (editing) {
          const scope = body.id === 'qe-lock-slot' ? qeModal : body;
          scope.querySelectorAll('input, select, textarea, button[type="submit"], #btn-qe-ok, #btn-qe-invite').forEach(el => {
            if (el.closest('[data-edit-lock-banner]') || el.disabled) return;
            el.disabled = true;
            el.setAttribute('data-lock-disabled', '1');
          });
        }
      }
    }
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-force-release-lock]');
      if (!btn || !editLockManager || !canAccessAdminPanel()) return;
      const id = btn.getAttribute('data-force-release-lock');
      editLockManager.forceRelease(id)
        .then(() => showToast('Edit lock released. The other person\'s unsaved changes will be refused if they conflict.'))
        .catch((err) => showToast('Could not release the lock: ' + ((err && err.code) || 'error')));
    });




    function assembleStateFromDocs(mainData, logData) {
      if (!mainData && !logData) return null;
      let parsed = null;
      const mainJson = mainData ? readMainPayloadJson(mainData) : null; // plain or gzip; throws on an unknown encoding
      if (mainJson) {
        parsed = JSON.parse(mainJson);
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
     * - The family tree is written to the configured archive document. The change log
     *   (history and revert snapshots) is written to the configured log document
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


    /* =====================================================================
     * COMPACT CHANGE LOG (osr-diff-v1)
     * Each entry stores a diff of only the touched people, families, title
     * and permissions. At most LOG_CHECKPOINT_LIMIT full snapshots are kept
     * as checkpoints so a revert can be rebuilt and checked.
     * ===================================================================== */
























    function estimateAllStorage(stateObj, metaExtras) {
      const split = splitStateForWrite(stateObj);
      const mainMeta = buildMainDocFields(split.tree, '', metaExtras);
      delete mainMeta.payloadJson;
      // Same shape a save would write (compressed when the stored document is).
      const mainFields = prepareMainFields(mainMeta, JSON.stringify(split.tree), latestMainData).fields;
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
      const json = JSON.stringify(treeState);
      // Plain payloadJson, or gzip when switched on / the stored document is already compressed.
      const fit = prepareMainFields(baseMeta, json, latestMainData);
      const fields = fit.fields;
      const estimate = describeMainStorage(fields, treeState);
      return { ok: fit.ok, json, fields, estimate, bytes: fit.total, compressed: fit.compressed, reason: fit.ok ? null : (fit.rulesOk ? 'document' : (fit.compressed ? 'payloadGzip' : 'payloadJson')) };
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





    async function runQueuedSave() {
      const hooks = treeSaveHooks();
      const stateObj = pendingSaveState;
      pendingSaveState = null;
      if (!stateObj) return { ok: true, skipped: true };
      if (stateObj !== appState) {
        hooks.onStale();
        return { ok: false, stale: true, error: { code: 'aborted', message: 'Someone else saved first. Their latest version is shown — please repeat your last change.' } };
      }
      if (typeof testWriteImpl !== 'function' && typeof navigator !== 'undefined' && navigator.onLine === false) {
        const err = { code: 'unavailable', offline: true, message: OFFLINE_SAVE_MESSAGE, userMessage: OFFLINE_SAVE_MESSAGE };
        if (typeof hooks.onOffline === 'function') hooks.onOffline(err);
        else hooks.onError(err);
        return { ok: false, offline: true, error: err };
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
          if (formatted.offline) {
            setCloudSyncIndicator('offline', 'Offline — save when you reconnect');
          } else {
            setCloudSyncIndicator('offline', 'Firestore Write Blocked');
          }
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
        try { firebaseStorage = getStorage(firebaseApp); } catch (storageErr) { firebaseStorage = null; }
        startAppCheckIfConfigured(firebaseApp);

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
                showToast('This archive has not been created yet. Sign in as the Super Admin to set it up.');
                appState = normalizeAppState(createBlankDataset());
                purgeLocalCachedRecords();
                setCloudSyncIndicator('offline', 'Setup required');
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
          startEditLocks();
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
      const previousPortraitUrls = collectOurPortraitUrlsFromState(appState);
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
      const write = persistState(appState);
      scheduleOrphanPortraitCleanup(previousPortraitUrls, write);
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
    const CARD_W = 188;
    const CARD_H = 104;
    const PARTNER_GAP = 52;
    const MIN_UNIT_GAP = 52;
    // 104px card + 96px gutter: room for the hover pill (~27px) and staggered union buses.
    const LAYER_HEIGHT = 200;
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
        appState.tree && appState.tree.revision || 0,
        Object.keys(appState.persons || {}).length,
        Object.keys(appState.families || {}).length,
        layoutCache.epoch || 0
      ].join('|');
      if (layoutCache.key === key && layoutCache.value) return layoutCache.value;
      const value = computeTreeLayoutUncached();
      layoutCache = { key, value, epoch: layoutCache.epoch || 0 };
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
          familyGutterMap[f.id] = gutterTop + 36 + (idx % 5) * 11;
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
      ensureLanguageSwitcher();
      applyI18n(document);
      applyEditLockUi();
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


    let lastRenderedLayout = null;
    let recullFrame = 0;
    let forceFullCanvasDraw = false;
    const DRAW_OVERSCAN_PX = 420;

    function invalidateTreeLayoutCache() {
      layoutCache = { key: null, value: null, epoch: (layoutCache && layoutCache.epoch || 0) + 1 };
      lastRenderedLayout = null;
    }

    function getTreeViewportRect() {
      const viewport = document.getElementById('canvas-viewport');
      const width = (viewport && viewport.clientWidth) || 960;
      const height = (viewport && viewport.clientHeight) || 640;
      const zoom = uiState.zoom || 1;
      const overscan = DRAW_OVERSCAN_PX / zoom;
      const x0 = ((-uiState.panX) / zoom) - overscan;
      const y0 = ((-uiState.panY) / zoom) - overscan;
      const x1 = ((-uiState.panX + width) / zoom) + overscan;
      const y1 = ((-uiState.panY + height) / zoom) + overscan;
      return { x0, y0, x1, y1, width, height, zoom };
    }

    function shouldCullCanvas(layout) {
      if (forceFullCanvasDraw) return false;
      if (document.body.classList.contains('printing')) return false;
      if (document.body.getAttribute('data-print-scope')) return false;
      const count = layout && layout.nodes ? Object.keys(layout.nodes).length : 0;
      return count >= 40;
    }

    function overlapsView(x, y, w, h, view) {
      if (!view) return true;
      return (x + w) >= view.x0 && x <= view.x1 && (y + h) >= view.y0 && y <= view.y1;
    }

    function segmentOverlapsView(x1, y1, x2, y2, view) {
      if (!view) return true;
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      return overlapsView(minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY), view);
    }

    function scheduleVisibleCanvasRefresh() {
      if (recullFrame) return;
      recullFrame = requestAnimationFrame(() => {
        recullFrame = 0;
        const layout = lastRenderedLayout || computeTreeLayout();
        renderVisualCanvas(layout, { fromRecull: true });
      });
    }

    function measureCanvasRender(opts) {
      const options = opts || {};
      const prevForce = forceFullCanvasDraw;
      if (options.forceFull) forceFullCanvasDraw = true;
      const start = performance.now();
      const layout = computeTreeLayout();
      renderVisualCanvas(layout, { skipRecull: true });
      const ms = performance.now() - start;
      const cards = document.querySelectorAll('[data-person-card]').length;
      const layoutCount = Object.keys(layout.nodes || {}).length;
      forceFullCanvasDraw = prevForce;
      return {
        ms: Math.round(ms * 10) / 10,
        cards,
        layoutCount,
        culled: cards < layoutCount,
        virtualized: shouldCullCanvas(layout) && !options.forceFull
      };
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

    function renderVisualCanvas(layout, renderOpts) {
      renderOpts = renderOpts || {};
      lastRenderedLayout = layout;
      const view = shouldCullCanvas(layout) ? getTreeViewportRect() : null;
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

      const swimKey = `${layout.maxGen}|${totalWidth}|${LAYER_HEIGHT}`;
      if (canvasSwimlanesKey !== swimKey) {
        let swimlanesHtml = '';
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
        }
        swimlanesLayer.innerHTML = swimlanesHtml;
        canvasSwimlanesKey = swimKey;
      }

      const jumpKey = String(layout.maxGen);
      if (canvasJumpKey !== jumpKey) {
        let jumpPillsHtml = '';
        for (let g = 0; g <= layout.maxGen; g++) {
          const roman = toRomanNumeral(g + 1);
          jumpPillsHtml += `
          <button type="button" data-jump-gen="${g}" class="px-2 py-1 rounded-lg hover:bg-parchment-100 text-slate-700 hover:text-archival-indigo transition">
            Gen ${roman}
          </button>
        `;
        }
        document.getElementById('gen-jump-bar').innerHTML = jumpPillsHtml;
        canvasJumpKey = jumpKey;
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

      Object.values(appState.families).forEach(fam => {
        const pos1 = fam.partner1Id ? layout.nodes[fam.partner1Id] : null;
        const pos2 = fam.partner2Id ? layout.nodes[fam.partner2Id] : null;
        if (!pos1 && !pos2) return;
        if (view) {
          const xs = [];
          const ys = [];
          if (pos1) { xs.push(pos1.x, pos1.x + CARD_W); ys.push(pos1.y, pos1.y + CARD_H); }
          if (pos2) { xs.push(pos2.x, pos2.x + CARD_W); ys.push(pos2.y, pos2.y + CARD_H); }
          (fam.children || []).forEach(c => {
            const cPos = layout.nodes[c.personId];
            if (!cPos) return;
            xs.push(cPos.x, cPos.x + CARD_W);
            ys.push(cPos.y, cPos.y + CARD_H);
          });
          if (xs.length && !overlapsView(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), view)) return;
        }

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

          const lineStyle = unionLineStyle(fam.status);

          if (Math.abs(x2 - x1) <= PARTNER_GAP + 8) {
            const key = 'union-line:' + fam.id;
            usedEdges.add(key);
            syncSvgEdge(key, svgEl, 'line', {
              x1, y1: unionY, x2, y2: unionY,
              stroke: lineStyle.stroke,
              'stroke-width': '1.75',
              'stroke-dasharray': lineStyle.dash,
              class: isKinFamily ? 'kinship-edge-active' : ''
            });
          } else {
            const c1x = leftPos.x + CARD_W / 2;
            const c2x = rightPos.x + CARD_W / 2;
            const archY = leftPos.y - 16;
            unionX = (c1x + c2x) / 2;
            unionY = archY;
            const key = 'union-arch:' + fam.id;
            usedEdges.add(key);
            syncSvgEdge(key, svgEl, 'path', {
              d: `M ${c1x} ${leftPos.y} L ${c1x} ${archY} L ${c2x} ${archY} L ${c2x} ${rightPos.y}`,
              fill: 'none',
              stroke: lineStyle.stroke,
              'stroke-width': '1.6',
              'stroke-dasharray': lineStyle.dash,
              class: isKinFamily ? 'kinship-edge-active' : ''
            });
          }

          const mYear = extractYearLabel(fam.marriageDate);
          const unionSt = normalizeUnionStatus(fam.status);
          const unionTitle = unionSt === 'married'
            ? (mYear ? `Married ${mYear}` : 'Union')
            : unionStatusLabel(unionSt);

          usedUnions.add(fam.id);
          let unionEl = canvasDom.unions.get(fam.id);
          const unionStyle = `left:${unionX - 15}px; top:${unionY - 15}px; width:30px; height:30px;`;
          if (!unionEl) {
            unionEl = document.createElement('div');
            unionEl.setAttribute('data-union-marker', fam.id);
            unionEl.className = 'absolute rounded-full bg-amber-50/95 border border-amber-200 shadow-2xs flex items-center justify-center text-amber-700 z-10 pointer-events-none';
            unionEl.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
                <circle cx="9.2" cy="12.5" r="4.3" />
                <circle cx="14.8" cy="12.5" r="4.3" />
              </svg>`;
            nodesLayer.appendChild(unionEl);
            canvasDom.unions.set(fam.id, unionEl);
          }
          if (unionEl.getAttribute('style') !== unionStyle) unionEl.setAttribute('style', unionStyle);
          if (unionEl.getAttribute('title') !== unionTitle) unionEl.setAttribute('title', unionTitle);
        } else {
          const singlePos = pos1 || pos2;
          unionX = singlePos.x + CARD_W / 2;
          unionY = singlePos.y + CARD_H;
        }

        const validChildren = (fam.children || []).filter(c => layout.nodes[c.personId]);
        if (validChildren.length > 0) {
          const busY = layout.familyGutterMap[fam.id] || (unionY + 48);
          const stemKey = 'stem:' + fam.id;
          usedEdges.add(stemKey);
          syncSvgEdge(stemKey, svgEl, 'line', {
            x1: unionX, y1: unionY, x2: unionX, y2: busY,
            stroke: '#94A3B8',
            'stroke-width': '1.75'
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
            const busKey = 'bus:' + fam.id;
            usedEdges.add(busKey);
            syncSvgEdge(busKey, svgEl, 'line', {
              x1: minBusX, y1: busY, x2: maxBusX, y2: busY,
              stroke: '#94A3B8',
              'stroke-width': '1.75'
            });
          }

          childConnectors.forEach(cc => {
            const lineStyle = linkageLineStyle(cc.linkage);
            const isKinChild = activePersonIds.has(cc.childId) && (activePersonIds.has(fam.partner1Id) || activePersonIds.has(fam.partner2Id));
            const childKey = 'child:' + fam.id + ':' + cc.childId;
            usedEdges.add(childKey);
            syncSvgEdge(childKey, svgEl, 'line', {
              x1: cc.cx, y1: busY, x2: cc.cx, y2: cc.topY,
              stroke: lineStyle.color,
              'stroke-width': '1.75',
              'stroke-dasharray': lineStyle.dashed ? '5,4' : '',
              class: isKinChild ? 'kinship-edge-active' : ''
            });
          });
        }
      });

      pruneCanvasMap(canvasDom.edges, usedEdges);
      pruneCanvasMap(canvasDom.unions, usedUnions);

      const usedNodes = new Set();
      personIds.forEach(id => {
        const p = appState.persons[id];
        const pos = layout.nodes[id];
        if (!pos) return;
        const isSelected = appState.selectedPersonId === id;
        if (view && !isSelected && id !== appState.centralPersonId && !overlapsView(pos.x, pos.y, CARD_W, CARD_H, view)) return;

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
        const className = `person-card absolute bg-white border-[1.5px] ${cardBorder} rounded-xl shadow-2xs cursor-pointer flex items-center z-10 ${isSelected ? 'selected' : ''} ${isCentral ? 'central-person' : ''} ${isKin ? 'kinship-highlight' : ''}`;
        const style = `left:${pos.x}px; top:${pos.y}px; width:${CARD_W}px; height:${CARD_H}px;`;
        const sig = [displayName, lifespanStr, deceasedLabel, cardAria, isSelected ? '1' : '0', isCentral ? '1' : '0', isKin ? '1' : '0', hasParentBranch ? '1' : '0', isFocusPerson ? '1' : '0', isBranchCollapsed ? '1' : '0', branchTitle, cardBorder, avatarRing, portraitUrl, p.sex || '', canEditTree() ? '1' : '0'].join('\u0001');
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

            <div class="card-avatar rounded-full border ${avatarRing} flex items-center justify-center overflow-hidden shrink-0">
              ${portraitUrl
                ? `<img src="${escapeAttr(portraitUrl)}" alt="" class="w-full h-full object-cover" />`
                : `<svg class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">${getSilhouetteSvgInner(p.sex)}</svg>`
              }
            </div>

            <div class="card-text w-full min-w-0">
              <div class="card-name font-sans font-semibold text-slate-900">
                ${escapeHtml(displayName)}
              </div>
              <div class="card-lifespan text-slate-500">
                ${escapeHtml(lifespanStr)}
              </div>
            </div>

            ${canEditTree() ? `
              <button type="button" data-canvas-quick-edit="${escapeAttr(id)}" class="canvas-card-pencil no-print" aria-label="Edit profile" title="Edit profile">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 20h9"></path><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
              </button>
            ` : ''}
            ${canEditTree() ? `
              <div class="canvas-add-bar no-print" role="group" aria-label="Add relative">
                <div class="canvas-add-bar-inner">
                  <button type="button" data-quick-rel="parent">+Parent</button>
                  <span class="canvas-add-bar-sep" aria-hidden="true">·</span>
                  <button type="button" data-quick-rel="spouse">+Spouse</button>
                  <span class="canvas-add-bar-sep" aria-hidden="true">·</span>
                  <button type="button" data-quick-rel="child">+Child</button>
                  <span class="canvas-add-bar-sep" aria-hidden="true">·</span>
                  <button type="button" data-quick-rel="sibling">+Sibling</button>
                </div>
              </div>
            ` : ''}
          `;

        usedNodes.add(id);
        let el = canvasDom.nodes.get(id);
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-person-card', id);
          el.setAttribute('tabindex', '0');
          el.setAttribute('role', 'button');
          nodesLayer.appendChild(el);
          canvasDom.nodes.set(id, el);
          el.dataset.canvasSig = '';
        }
        const appliedClass = className + (canEditTree() && addBarHoverId === id ? ' add-bar-open' : '');
        if (el.className !== appliedClass) el.className = appliedClass;
        if (el.getAttribute('style') !== style) el.setAttribute('style', style);
        if (el.getAttribute('aria-label') !== cardAria) el.setAttribute('aria-label', cardAria);
        if (el.dataset.canvasSig !== sig) {
          el.innerHTML = inner;
          el.dataset.canvasSig = sig;
        }
      });

      pruneCanvasMap(canvasDom.nodes, usedNodes);
      applyCanvasTransform({ skipRecull: true });
    }


    function applyCanvasTransform(opts) {
      const stage = document.getElementById('canvas-stage');
      if (!stage) return;
      stage.style.transform = `translate(${uiState.panX}px, ${uiState.panY}px) scale(${uiState.zoom})`;
      const zoomLabel = document.getElementById('btn-zoom-reset');
      if (zoomLabel) zoomLabel.textContent = `${Math.round(uiState.zoom * 100)}%`;
      if (!opts || !opts.skipRecull) scheduleVisibleCanvasRefresh();
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

      // Evidence & Citations UI is hidden; assertions on the person record are kept.
      if (uiState.inspectorTab === 'evidence') uiState.inspectorTab = 'profile';

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
            const unionStatus = normalizeUnionStatus(f.status);
            if (spPerson) {
              spouses.push({
                person: spPerson,
                role: unionSpouseHeading(unionStatus),
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
            spouse: null,
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
            title: unionFactTitle(fam.status),
            dateRaw: fam.marriageDate || '',
            dateFormatted: fam.marriageDate ? formatDisplayDate(fam.marriageDate, 'short') : '',
            place: fam.marriagePlace || '',
            unionStatus: normalizeUnionStatus(fam.status),
            divorceDateRaw: fam.divorceDate || '',
            divorceDateFormatted: fam.divorceDate ? formatDisplayDate(fam.divorceDate, 'short') : '',
            divorcePlace: fam.divorcePlace || '',
            spouse,
          });
        });

        spouses.sort((a, b) => comparePersonUnions(appState.families[a.famId], appState.families[b.famId]));
        spouses.forEach((item, index) => {
          item.unionIndex = index;
          item.unionTotal = spouses.length;
          item.orderLabel = spouses.length > 1 ? ordinalUnionLabel(index, item.status) : '';
          if (item.orderLabel && item.role === 'Spouse') item.role = item.orderLabel;
          if (item.orderLabel && item.role === 'Former spouse') item.role = 'Former spouse · ' + item.orderLabel;
        });
        spouseUnions.sort((a, b) => comparePersonUnions(a.fam, b.fam));
        timelineEntries.sort((a, b) => {
          const famA = appState.families[a.id];
          const famB = appState.families[b.id];
          if (a.kind === 'marriage' && b.kind === 'marriage' && famA && famB) return comparePersonUnions(famA, famB);
          return a.sortYear - b.sortYear;
        });
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
                      <div class="flex flex-wrap gap-1.5">
                        <button type="button" class="js-photo-camera px-3 py-2 min-h-[44px] rounded-lg bg-white border border-stone-300 text-xs font-semibold text-slate-800" data-i18n="takePhoto">Take photo</button>
                        <button type="button" class="js-photo-gallery px-3 py-2 min-h-[44px] rounded-lg bg-white border border-stone-300 text-xs font-semibold text-slate-800" data-i18n="chooseGallery">Choose from gallery</button>
                      </div>
                      <p class="text-[11px] text-slate-500 leading-relaxed">The photo is resized on this device, then stored in Firebase Storage (you must enable Storage in the Firebase console once). You can still paste an https:// link below.</p>
                      <input type="url" name="photoUrl" placeholder="https://example.com/portrait.jpg" title="https:// links only" class="w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
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

                  ${(isBlockedImageUrl(person.photoUrl) || mediaItems.some(m => isBlockedImageUrl(m.url))) ? `
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
                            <div class="text-[11px] text-slate-500">${escapeHtml(item.role)}${getCardLifespanLabel(item.person) ? ' · ' + escapeHtml(getCardLifespanLabel(item.person)) : ''}</div>
                          </div>
                        </div>
                        <span class="text-slate-400 text-xs">›</span>
                      </button>
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
                                ${item.kind === 'marriage' && item.unionStatus && item.unionStatus !== 'married' ? `<div class="text-xs text-slate-600">${escapeHtml(unionStatusLabel(item.unionStatus))}${item.divorceDateFormatted ? ' · ' + escapeHtml(item.divorceDateFormatted) : ''}${item.divorcePlace ? ' · ' + escapeHtml(item.divorcePlace) : ''}</div>` : ''}
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
                                      ${unionStatusOptionsHtml(item.unionStatus)}
                                    </select>
                                  </label>
                                  <label class="block text-[11px] font-medium text-slate-700">End date
                                    <input name="divorceDate" type="text" value="${escapeAttr(item.divorceDateRaw || '')}" placeholder="Date (e.g. July 4 1977)" class="mt-1 w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
                                  </label>
                                  <label class="block text-[11px] font-medium text-slate-700">End place
                                    <input name="divorcePlace" type="text" value="${escapeAttr(item.divorcePlace || '')}" placeholder="Place" class="mt-1 w-full px-2.5 py-1.5 text-xs bg-white border border-stone-300 rounded-lg" />
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
                  ${editable ? `<div class="flex flex-wrap gap-1.5 mb-1.5">
                    <button type="button" class="js-photo-camera px-3 py-2 min-h-[40px] rounded-lg bg-white border border-stone-300 text-xs font-semibold text-slate-800" data-i18n="takePhoto">Take photo</button>
                    <button type="button" class="js-photo-gallery px-3 py-2 min-h-[40px] rounded-lg bg-white border border-stone-300 text-xs font-semibold text-slate-800" data-i18n="chooseGallery">Choose from gallery</button>
                  </div>` : ''}
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
                      <option value="foster_child">Add Existing Person as Foster Child</option>
                      <option value="guardian_child">Add Existing Person as Ward (guardian)</option>
                      ${allFamiliesArr.length > 0 ? `<option value="adoptive_parents">Assign Adoptive Parents to This Person</option>` : ''}
                      ${allFamiliesArr.length > 0 ? `<option value="step_parents">Assign Step-Parents to This Person</option>` : ''}
                      ${allFamiliesArr.length > 0 ? `<option value="foster_parents">Assign Foster Parents to This Person</option>` : ''}
                      ${allFamiliesArr.length > 0 ? `<option value="guardian_parents">Assign Guardians to This Person</option>` : ''}
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
      return (linkage === 'adoptive' || linkage === 'step' || linkage === 'foster' || linkage === 'guardian') ? linkage : 'biological';
    }

    function childRoleLabel(linkage) {
      if (linkage === 'adoptive') return 'Adopted child';
      if (linkage === 'step') return 'Stepchild';
      if (linkage === 'foster') return 'Foster child';
      if (linkage === 'guardian') return 'Ward';
      return 'Child';
    }

    function parentRoleLabel(linkage) {
      if (linkage === 'adoptive') return 'Adoptive parent';
      if (linkage === 'step') return 'Step-parent';
      if (linkage === 'foster') return 'Foster parent';
      if (linkage === 'guardian') return 'Guardian';
      return 'Parent';
    }

    function linkageLineStyle(linkage) {
      const kind = normalizeLinkage(linkage);
      if (kind === 'adoptive' || kind === 'step') return { color: '#0284C7', dashed: true };
      if (kind === 'foster') return { color: '#0F766E', dashed: true };
      if (kind === 'guardian') return { color: '#7C3AED', dashed: true };
      return { color: '#94A3B8', dashed: false };
    }

    function parentIdsOfPerson(personId, stateObj) {
      const state = stateObj || appState;
      const ids = [];
      Object.values(state.families || {}).forEach(fam => {
        (fam.children || []).forEach(c => {
          if ((c && (c.personId || c)) !== personId) return;
          if (fam.partner1Id) ids.push(fam.partner1Id);
          if (fam.partner2Id) ids.push(fam.partner2Id);
        });
      });
      return [...new Set(ids)];
    }

    function sharedParentIds(personA, personB, stateObj) {
      const a = new Set(parentIdsOfPerson(personA, stateObj));
      return parentIdsOfPerson(personB, stateObj).filter(id => a.has(id));
    }

    function familyMarriageYear(fam) {
      if (!fam || !fam.marriageDate) return 9999;
      if (typeof parseFlexibleDateParts === 'function') {
        const parsed = parseFlexibleDateParts(fam.marriageDate);
        if (parsed && parsed.year) return Number(parsed.year);
      }
      const m = String(fam.marriageDate).match(/\b((?:1[5-9]|20)\d{2})\b/);
      return m ? Number(m[1]) : 9999;
    }

    function comparePersonUnions(a, b) {
      const ao = Number.isFinite(Number(a.unionOrder)) ? Number(a.unionOrder) : null;
      const bo = Number.isFinite(Number(b.unionOrder)) ? Number(b.unionOrder) : null;
      if (ao != null || bo != null) return (ao == null ? 9999 : ao) - (bo == null ? 9999 : bo) || String(a.id).localeCompare(String(b.id));
      return familyMarriageYear(a) - familyMarriageYear(b) || String(a.id).localeCompare(String(b.id));
    }

    function unionsForPerson(personId, stateObj) {
      const state = stateObj || appState;
      return Object.values(state.families || {})
        .filter(fam => fam && (fam.partner1Id === personId || fam.partner2Id === personId))
        .sort(comparePersonUnions);
    }

    function ordinalUnionLabel(index, status) {
      const n = index + 1;
      const end = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
      const union = unionIsFormer(status) ? 'union' : 'marriage';
      return n + end + ' ' + union;
    }

    function applyUnionOrderSwap(stateObj, personId, famId, direction) {
      const list = unionsForPerson(personId, stateObj);
      const idx = list.findIndex(fam => fam.id === famId);
      const next = idx + direction;
      if (idx < 0 || next < 0 || next >= list.length) return false;
      const ordered = list.slice();
      const tmp = ordered[idx];
      ordered[idx] = ordered[next];
      ordered[next] = tmp;
      ordered.forEach((fam, i) => { stateObj.families[fam.id].unionOrder = i + 1; });
      return true;
    }

    function qualifyKinTitle(title, linkages) {
      const kinds = (linkages || []).filter(l => l === 'step' || l === 'adoptive' || l === 'foster' || l === 'guardian');
      if (!kinds.length || !title) return title;
      if (kinds.includes('foster')) {
        const exactFoster = {
          Son: 'Foster son', Daughter: 'Foster daughter', Child: 'Foster child',
          Father: 'Foster father', Mother: 'Foster mother', Parent: 'Foster parent',
          Brother: 'Foster brother', Sister: 'Foster sister', Sibling: 'Foster sibling'
        };
        return exactFoster[title] || ('Foster ' + title);
      }
      if (kinds.includes('guardian')) {
        const exactGuard = {
          Son: 'Ward', Daughter: 'Ward', Child: 'Ward',
          Father: 'Guardian', Mother: 'Guardian', Parent: 'Guardian'
        };
        return exactGuard[title] || title;
      }
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
          if ((title === 'Brother' || title === 'Sister' || title === 'Sibling') && sharedParentIds(fromId, toId).length === 1) {
            title = title === 'Brother' ? 'Half-brother' : title === 'Sister' ? 'Half-sister' : 'Half-sibling';
          }
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
      forceFullCanvasDraw = true;
      if (wanted === 'full') {
        uiState.focusMode = false;
        if (caption) caption.textContent = treeTitle + ' — Full tree';
        renderAll();
        fitTreeToScreen();
        renderVisualCanvas(computeTreeLayout(), { skipRecull: true });
      } else {
        const pid = getFocusPersonId() || appState.selectedPersonId || appState.centralPersonId;
        if (pid) setFocusPerson(pid, { enableFocus: true, render: false });
        else uiState.focusMode = true;
        if (caption) caption.textContent = treeTitle + ' — Current branch';
        renderAll();
        fitTreeToScreen();
        renderVisualCanvas(computeTreeLayout(), { skipRecull: true });
      }
      document.body.classList.add('printing');
      document.body.setAttribute('data-print-scope', wanted);
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        forceFullCanvasDraw = false;
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
      const currentId = current && current.getAttribute && current.getAttribute('data-person-card');
      const layout = lastRenderedLayout || computeTreeLayout();
      const curPos = currentId && layout.nodes ? layout.nodes[currentId] : null;
      if (curPos) {
        const cx = curPos.x + CARD_W / 2;
        const cy = curPos.y + CARD_H / 2;
        let bestId = null;
        let bestScore = Infinity;
        Object.keys(layout.nodes).forEach(id => {
          if (id === currentId) return;
          const pos = layout.nodes[id];
          const dx = (pos.x + CARD_W / 2) - cx;
          const dy = (pos.y + CARD_H / 2) - cy;
          let aligned = false;
          let primary = 0;
          let secondary = 0;
          if (key === 'ArrowRight') { aligned = dx > 8; primary = dx; secondary = Math.abs(dy); }
          else if (key === 'ArrowLeft') { aligned = dx < -8; primary = -dx; secondary = Math.abs(dy); }
          else if (key === 'ArrowDown') { aligned = dy > 8; primary = dy; secondary = Math.abs(dx); }
          else if (key === 'ArrowUp') { aligned = dy < -8; primary = -dy; secondary = Math.abs(dx); }
          if (!aligned) return;
          const score = primary + secondary * 1.6;
          if (score < bestScore) { bestScore = score; bestId = id; }
        });
        if (bestId) {
          const bestPos = layout.nodes[bestId];
          const viewport = document.getElementById('canvas-viewport');
          const vw = (viewport && viewport.clientWidth) || 960;
          const vh = (viewport && viewport.clientHeight) || 640;
          uiState.panX = vw / 2 - (bestPos.x + CARD_W / 2) * uiState.zoom;
          uiState.panY = vh / 2 - (bestPos.y + CARD_H / 2) * uiState.zoom;
          renderVisualCanvas(layout, { skipRecull: true });
          const best = document.querySelector('[data-person-card="' + CSS.escape(bestId) + '"]');
          if (best) {
            best.focus();
            return best;
          }
        }
      }
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

      document.getElementById('btn-google-account')?.addEventListener('click', openGoogleAuthModal);
      document.getElementById('btn-banner-signin')?.addEventListener('click', openGoogleAuthModal);
      document.getElementById('btn-unauth-signin')?.addEventListener('click', () => signInWithGooglePopup(false));
      document.getElementById('btn-unauth-redirect')?.addEventListener('click', signInWithGoogleRedirectFlow);
      document.getElementById('btn-trigger-google-oauth')?.addEventListener('click', () => {
        signInWithGooglePopup(Boolean(getActiveUserEmail()));
      });
      document.getElementById('btn-trigger-google-redirect')?.addEventListener('click', signInWithGoogleRedirectFlow);
      document.getElementById('btn-google-signout')?.addEventListener('click', signOutGoogleUser);

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
      document.getElementById('btn-view-canvas')?.addEventListener('click', () => {
        uiState.viewMode = 'canvas';
        renderAll();
      });
      document.getElementById('btn-view-list')?.addEventListener('click', () => {
        uiState.viewMode = 'list';
        renderAll();
      });

      // Undo / Redo
      document.getElementById('btn-undo')?.addEventListener('click', undo);
      document.getElementById('btn-redo')?.addEventListener('click', redo);
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
      document.getElementById('btn-close-gen-depth')?.addEventListener('click', () => {
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
      document.getElementById('btn-center-on-main')?.addEventListener('click', () => {
        const mainId = resolveCentralPersonIdForUser() || appState.centralPersonId;
        if (mainId && uiState.focusMode) setFocusPerson(mainId);
        else if (mainId) centerOnPerson(mainId, true);
        document.getElementById('popover-gen-depth').classList.add('hidden');
      });

      // Rename Tree Dialog
      document.getElementById('btn-rename-tree')?.addEventListener('click', () => {
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
      document.getElementById('dialog-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('dialog-confirm').click();
        }
      });
      document.getElementById('dialog-cancel')?.addEventListener('click', () => {
        document.getElementById('modal-dialog').classList.add('hidden');
      });
      document.getElementById('dialog-confirm')?.addEventListener('click', () => {
        const val = document.getElementById('dialog-input').value.trim();
        if (val && val !== appState.tree.title) {
          commitMutation(`Renamed tree to "${val}"`, s => { s.tree.title = val; });
        }
        document.getElementById('modal-dialog').classList.add('hidden');
      });

      // Empty Tree Add First Person
      document.getElementById('btn-empty-add-first')?.addEventListener('click', () => {
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
      document.getElementById('btn-toggle-inspector')?.addEventListener('click', () => {
        if (uiState.inspectorOpen) closeInspector();
        else openInspector(appState.selectedPersonId || appState.centralPersonId, 'profile');
      });
      document.getElementById('btn-close-inspector')?.addEventListener('click', closeInspector);
      document.getElementById('btn-insp-circle-profile')?.addEventListener('click', () => {
        uiState.inspectorTab = 'profile';
        renderAll();
      });
      document.getElementById('btn-insp-circle-edit')?.addEventListener('click', () => {
        const id = appState.selectedPersonId || appState.centralPersonId;
        if (id) openQuickEditModal(id);
      });
      document.getElementById('btn-insp-circle-add')?.addEventListener('click', () => {
        uiState.inspectorTab = 'add';
        renderAll();
      });
      document.getElementById('btn-avatar-camera')?.addEventListener('click', () => {
        uiState.inspectorTab = 'profile';
        uiState.accordions.photos = true;
        uiState.showPhotoAddForm = true;
        renderAll();
        if (typeof canEditTree === 'function' && canEditTree()) {
          document.getElementById('input-photo-camera')?.click();
        }
      });
      document.getElementById('btn-insp-circle-more')?.addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('insp-more-menu').classList.toggle('hidden');
      });
      document.getElementById('btn-set-as-central')?.addEventListener('click', () => {
        const pid = appState.selectedPersonId;
        if (pid && appState.persons[pid]) {
          appState.centralPersonId = pid;
          document.getElementById('insp-more-menu').classList.add('hidden');
          renderAll();
          centerOnPerson(pid, true);
          showToast(`Centered tree on ${getDisplayName(appState.persons[pid])}`);
        }
      });
      document.getElementById('btn-trace-to-central')?.addEventListener('click', () => {
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
      document.getElementById('btn-delete-person')?.addEventListener('click', () => {
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
      document.getElementById('btn-open-kinship')?.addEventListener('click', () => {
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

      document.getElementById('kinship-from-select')?.addEventListener('change', updateKinshipModalPreview);
      document.getElementById('kinship-to-select')?.addEventListener('change', updateKinshipModalPreview);
      document.getElementById('btn-highlight-kinship')?.addEventListener('click', () => {
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
      document.getElementById('btn-clear-kinship')?.addEventListener('click', () => {
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
      document.getElementById('search-input')?.addEventListener('keydown', (e) => {
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
      viewport.addEventListener('pointerover', (e) => {
        if (!isMouseLikePointer(e)) return;
        const card = e.target.closest && e.target.closest('.person-card');
        if (card) openAddBarOnCard(card);
      });
      viewport.addEventListener('pointerout', (e) => {
        if (!isMouseLikePointer(e)) return;
        const card = e.target.closest && e.target.closest('.person-card');
        if (!card) return;
        const next = e.relatedTarget;
        if (next && (card === next || card.contains(next))) return;
        scheduleHideAddBar();
      });
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
          if (pressedCard && dragMoved) scheduleVisibleCanvasRefresh();
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

      document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomAroundCentre(1.15));
      document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomAroundCentre(0.87));
      document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
        const rect = viewport.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, 1);
      });
      document.getElementById('btn-fit-screen')?.addEventListener('click', fitTreeToScreen);
      document.getElementById('btn-toggle-full-tree')?.addEventListener('click', () => setFullTreeMode(uiState.focusMode));
      const openPrint = () => openPrintTreeDialog();
      document.getElementById('btn-print-tree')?.addEventListener('click', openPrint);
      document.getElementById('btn-print-tree-menu')?.addEventListener('click', openPrint);
      document.getElementById('btn-merge-duplicates-menu')?.addEventListener('click', () => openMergeDuplicatesDialog());
      bindMergeDuplicatesUi();
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
          const card = quickRelBtn.closest('[data-person-card]');
          const pid = (card && card.dataset.personCard) || appState.selectedPersonId;
          addNewRelativeToPerson(pid, quickRelBtn.dataset.quickRel);
          return;
        }

        const canvasEditBtn = e.target.closest && e.target.closest('[data-canvas-quick-edit]');
        if (canvasEditBtn) {
          e.stopPropagation();
          const pid = canvasEditBtn.getAttribute('data-canvas-quick-edit');
          if (pid) {
            closeInspector();
            openQuickEditModal(pid);
          }
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
          const status = normalizeUnionStatus(unionSel.value);
          const fam = appState.families[famId];
          if (!fam) return;
          commitMutation(`Marked union as ${status}`, s => {
            if (s.families[famId]) s.families[famId].status = status;
          }, 'Relationship');
          return;
        }
        if (e.target.id === 'prov-link-type') {
          const val = e.target.value;
          const assignParents = val === 'adoptive_parents' || val === 'step_parents' || val === 'foster_parents' || val === 'guardian_parents';
          document.getElementById('prov-target-person-wrap')?.classList.toggle('hidden', assignParents);
          document.getElementById('prov-adoptive-fam-wrap')?.classList.toggle('hidden', !assignParents);
          const famLabel = document.querySelector('#prov-adoptive-fam-wrap label');
          if (famLabel) {
            famLabel.textContent = val === 'step_parents' ? 'Select Step Couple / Family Unit'
              : val === 'foster_parents' ? 'Select Foster Couple / Family Unit'
              : val === 'guardian_parents' ? 'Select Guardian Couple / Family Unit'
              : 'Select Adoptive Couple / Family Unit';
          }
          document.getElementById('prov-marriage-meta-wrap')?.classList.toggle('hidden', val !== 'marriage');
        }
      });


      document.addEventListener('change', (e) => {
        if (e.target && (e.target.id === 'ui-language-select' || e.target.id === 'ui-language-select-menu')) {
          setUiLanguage(e.target.value);
        }
      });
      document.addEventListener('click', (e) => {
        const moveUnion = e.target.closest && e.target.closest('[data-move-union]');
        if (moveUnion) {
          if (!canEditTree()) return;
          const famId = moveUnion.dataset.moveUnionFam;
          const personId = moveUnion.dataset.moveUnionPerson;
          const direction = moveUnion.dataset.moveUnion === 'up' ? -1 : 1;
          commitMutation('Reordered marriages', s => {
            applyUnionOrderSwap(s, personId, famId, direction);
          }, 'Relationship');
          return;
        }
        if (e.target && e.target.closest && e.target.closest('.js-photo-camera')) {
          document.getElementById('input-photo-camera')?.click();
        }
        if (e.target && e.target.closest && e.target.closest('.js-photo-gallery')) {
          document.getElementById('input-photo-gallery')?.click();
        }
      });
      document.addEventListener('change', (e) => {
        if (!e.target || (e.target.id !== 'input-photo-camera' && e.target.id !== 'input-photo-gallery')) return;
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        const personId = (typeof appState !== 'undefined' && appState.selectedPersonId) || '';
        if (!file || !personId) {
          if (file && !personId) showToast('Select a person first, then add a photo.');
          return;
        }
        const captionInput = document.querySelector('#form-add-person-photo input[name="caption"]');
        const avatarInput = document.querySelector('#form-add-person-photo input[name="setAsAvatar"]');
        const caption = captionInput ? captionInput.value.trim() : '';
        const setAsAvatar = avatarInput ? avatarInput.checked : true;
        showToast('Resizing and uploading the photo…');
        saveUploadedPortrait(personId, file, { caption, setAsAvatar })
          .then(() => {
            if (typeof uiState !== 'undefined') uiState.showPhotoAddForm = false;
            if (typeof renderAll === 'function') renderAll();
            showToast('Photo uploaded.');
          })
          .catch(err => {
            console.error(err);
            showToast(err && err.message ? err.message : 'Could not upload that photo.');
          });
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
            const ev = { id: generateId('ev'), type, date, place };
            p.events.push(ev);
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
                const status = normalizeUnionStatus(fd.get('unionStatus'));
                fam.status = status;
                if (unionShowsDivorceFields(status)) {
                  fam.divorceDate = (fd.get('divorceDate') || '').trim();
                  fam.divorcePlace = (fd.get('divorcePlace') || '').trim();
                }
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
          } else if (linkType === 'adopt_child' || linkType === 'step_child' || linkType === 'foster_child' || linkType === 'guardian_child') {
            const childId = fd.get('targetPersonId');
            const linkage = linkType === 'step_child' ? 'step' : linkType === 'foster_child' ? 'foster' : linkType === 'guardian_child' ? 'guardian' : 'adoptive';
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
          } else if (linkType === 'adoptive_parents' || linkType === 'step_parents' || linkType === 'foster_parents' || linkType === 'guardian_parents') {
            const famId = fd.get('targetFamilyId');
            const fam = appState.families[famId];
            const linkage = linkType === 'step_parents' ? 'step' : linkType === 'foster_parents' ? 'foster' : linkType === 'guardian_parents' ? 'guardian' : 'adoptive';
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
    initQuickEdit();
    initHeaderOverflowMenu('btn-header-more', 'header-more-menu', 'app-header');

    initAccessibleModals(['modal-dialog', 'modal-kinship'], () => {
      if (quickEditIsOpen()) { closeQuickEditModal(); return; }
      const menu = document.getElementById('insp-more-menu');
      const search = document.getElementById('search-results-dropdown');
      const pop = document.getElementById('popover-gen-depth');
      if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
      if (search && !search.classList.contains('hidden')) { search.classList.add('hidden'); return; }
      if (pop && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
      if (uiState.inspectorOpen) closeInspector();
    });
    // Test-only hook: compiled in only for `vite build --mode test` (dist-test/).
    // Production builds define __OSR_TEST_HOOKS__ as false, so this block is dropped.
    if (__OSR_TEST_HOOKS__) {
      window.__TREE = {
        getState: () => appState,
        getUi: () => uiState,
        // Swap in a lock manager (tests pass a fake that mimics src/edit-locks.js).
        setEditLockManager(manager) { stopEditLocks(); editLockManager = manager; if (manager && manager.watch) manager.watch(); renderAll(); },
        applyEditLockUi: () => applyEditLockUi(),
        assembleStateFromDocs,
        prepareMainWrite,
        setLatestMainData: (d) => { latestMainData = d; },
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
          invalidateTreeLayoutCache();
          renderAll();
          return { people: Object.keys(appState.persons).length };
        },
        renderAll,
        openInspector,
        openQuickEditModal,
        closeQuickEditModal,
        dateStringToQe,
        qeToDateString,
        normalizeUnionStatus,
        unionLineStyle,
        unionSpouseHeading,
        unionStatusLabel,
        undo,
        redo,
        setView(mode) { uiState.viewMode = mode; renderAll(); },
        setZoom(z) { uiState.zoom = z; applyCanvasTransform(); },
        fitTreeToScreen,
        measureCanvasRender,
        invalidateTreeLayoutCache,
        normalizeLinkage,
        childRoleLabel,
        parentRoleLabel,
        qualifyKinTitle,
        computeKinship,
        sharedParentIds,
        unionsForPerson,
        applyUnionOrderSwap,
        comparePersonUnions,
        getUiLanguage,
        setUiLanguage,
        t,
        applyI18n,
        getCardLifespanLabel,
        getVitalSummary,
        getHeaderVitalLine,
        getDisplayName,
        isDeceased,
        getDeceasedLabel,
        deceasedCornerHtml,
        commitMutation,
        findDuplicatePairs,
        mergePeopleIntoState,
        openMergeDuplicatesDialog,
        compressImageBlob,
        collectInlinePhotos,
        setTestStorageUpload,
        setTestStorageDelete,
        isOurStoragePortraitUrl,
        storagePathFromPortraitUrl,
        collectOurPortraitUrlsFromState,
        cleanupOrphanStoragePortraits,
        deleteOurStoragePortrait,
        isOfflineWriteError,
        formatFirestoreError,
        OFFLINE_SAVE_MESSAGE,
        openFirestoreDatabase,

        isAppCheckConfigured,
        getAppCheckOptions,
        startAppCheckIfConfigured,
        migrateInlinePhotos,
        saveUploadedPortrait,
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
    ensureLanguageSwitcher();
    applyI18n(document);
    registerPwa();

    const params = new URLSearchParams(location.search);
    if (__OSR_TEST_HOOKS__ && params.get('test') === '1') {
      renderAll();
    } else {
      renderAll();
      initFirebaseAndPersistence();
    }
  