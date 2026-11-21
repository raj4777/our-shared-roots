window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

import { applyHostingAuthDomain } from './firebase-config.js';

    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
    import {
      getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence, browserSessionPersistence,
      GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut
    } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
    import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

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
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyConfigToDom);
    else applyConfigToDom();


        const FIRESTORE_DOC_LIMIT_BYTES = 1048576;
    const FIRESTORE_SAFE_DOC_BYTES = 1040000;
    const PAYLOAD_JSON_RULES_MAX = 1000000;
    
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

    let firebaseApp = null, auth = null, db = null, firebaseUser = null;
    let demoMode = false;
    let mainSnapData = null, logSnapData = null, logSnapExists = false;
    let lastPlan = null;
    let backupDownloaded = false;
    let dryRunOk = false;

    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }

    function formatFirestoreError(err) {
      const code = (err && (err.code || err.name)) || 'unknown';
      const message = (err && err.message) ? String(err.message) : (err ? String(err) : 'Unknown error');
      const hints = [];
      if (code === 'permission-denied') hints.push('the deployed security rules refused this write — confirm you are signed in as the Super Admin, and that the latest rules have been deployed');
      if (code === 'resource-exhausted' || code === 'invalid-argument') hints.push('a document may be over Firestore’s 1 MB limit');
      if (code === 'unavailable' || code === 'deadline-exceeded') hints.push('the network or Firestore service was unavailable — try again');
      if (code === 'unauthenticated' || code === 'not-authorized') hints.push('sign in again with the Super Admin Google account');
      if (firebaseUser && firebaseUser.emailVerified === false) hints.push('this Google account is not marked email-verified');
      const hint = hints.length ? ' Hint: ' + hints.join('. ') + '.' : '';
      return { code, message, text: 'Firestore error (' + code + '): ' + message + hint };
    }

    function showError(err) {
      const formatted = formatFirestoreError(err);
      const el = $('mig-error');
      el.classList.remove('hidden');
      el.setAttribute('data-error-code', formatted.code);
      el.textContent = formatted.text;
      addLog('Error: ' + formatted.text, true);
      return formatted;
    }

    function clearError() {
      const el = $('mig-error');
      el.classList.add('hidden');
      el.textContent = '';
      el.removeAttribute('data-error-code');
    }

    function addLog(text, isError) {
      const ol = $('mig-log');
      const li = document.createElement('li');
      li.textContent = text;
      if (isError) li.className = 'text-rose-800 font-medium';
      ol.appendChild(li);
      return li;
    }

    function normEmail(e) { return String(e || '').trim().toLowerCase(); }

    function isSuperAdminUser(user) {
      return Boolean(user && user.email && normEmail(user.email) === getConfiguredSuperAdminEmail());
    }

    // Prefer the current *.web.app host for Auth so sign-in uses /__/auth/handler
    // on this origin instead of <project>.firebaseapp.com from /__/firebase/init.json.
    async function resolveFirebaseConfig() {
      let config = null;
      if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) config = window.FIREBASE_CONFIG;
      else if (typeof __firebase_config !== 'undefined' && __firebase_config) config = JSON.parse(__firebase_config);
      else {
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

    function parsePayload(mainData) {
      if (!mainData || typeof mainData.payloadJson !== 'string') return null;
      try { return JSON.parse(mainData.payloadJson); }
      catch (e) { throw new Error('payloadJson is not valid JSON'); }
    }

    // Single source of truth for the state card, size meters, dry run, and the actual move.
    // Never treat a missing or unloaded document as "already migrated".
    function inspectArchive(mainData, logData, logExists) {
      if (!mainData || typeof mainData.payloadJson !== 'string') {
        return {
          loaded: false, alreadyMigrated: false, needsMove: false,
          extracted: null, merged: { changeEvents: [], changeSequence: 0 }, tree: {},
          nextMain: null, nextLog: null,
          people: 0, families: 0, events: 0, snapshots: 0, embeddedCount: 0, logDocCount: 0,
          logExists: Boolean(logExists), currentMainBytes: 0, currentLogBytes: 0,
          projectedMain: 0, projectedLog: 0, mainFits: false, logFits: false,
          hadEmbeddedShape: false, extraMainKeys: [],
          unloadReason: 'The tree document has not been loaded yet.'
        };
      }
      const parsed = parsePayload(mainData);
      if (!parsed || typeof parsed !== 'object') {
        return {
          loaded: false, alreadyMigrated: false, needsMove: false,
          extracted: null, merged: { changeEvents: [], changeSequence: 0 }, tree: {},
          nextMain: null, nextLog: null,
          people: 0, families: 0, events: 0, snapshots: 0, embeddedCount: 0, logDocCount: 0,
          logExists: Boolean(logExists), currentMainBytes: 0, currentLogBytes: 0,
          projectedMain: 0, projectedLog: 0, mainFits: false, logFits: false,
          hadEmbeddedShape: false, extraMainKeys: [],
          unloadReason: 'payloadJson is missing or is not an object.'
        };
      }
      const extracted = extractEmbeddedLog(parsed);
      const docLog = logStateFromLogDoc(logData);
      const merged = mergeLogStates(extracted.embeddedLog, docLog);
      const tree = extracted.tree || {};
      const people = Object.keys(tree.persons || {}).length;
      const families = Object.keys(tree.families || {}).length;
      const events = merged.changeEvents || [];
      const snapshots = events.filter(ev => ev && (ev.beforeSnapshot || ev.afterSnapshot)).length;
      const embeddedCount = ((extracted.embeddedLog && extracted.embeddedLog.changeEvents) || []).length;
      const logDocCount = ((docLog && docLog.changeEvents) || []).length;

      const mainFieldsCurrent = { ...(mainData || {}) };
      const currentMainBytes = firestoreDocumentSize(mainFieldsCurrent, getArchiveDocPath());
      const currentLogBytes = logExists && logData ? firestoreDocumentSize(logData, getArchiveLogDocPath()) : 0;

      const nextMain = {
        title: (mainData && mainData.title) || tree.tree?.title || getSiteTitle(),
        // The rules accept only stored revision + 1 on every write.
        revision: (mainData && typeof mainData.revision === 'number') ? mainData.revision + 1 : (tree.tree?.revision || 1),
        superAdminEmail: (mainData && mainData.superAdminEmail) || getConfiguredSuperAdminEmail(),
        authorizedEmails: Array.isArray(mainData && mainData.authorizedEmails) ? mainData.authorizedEmails : [],
        editorEmails: Array.isArray(mainData && mainData.editorEmails) ? mainData.editorEmails : [],
        updatedAt: new Date().toISOString(),
        updatedByEmail: firebaseUser ? normEmail(firebaseUser.email) : '',
        updatedByUid: (firebaseUser && firebaseUser.uid) || '',
        payloadJson: JSON.stringify(tree)
      };
      const nextLog = {
        changeLogJson: JSON.stringify({ changeEvents: events, changeSequence: merged.changeSequence || 0 }),
        updatedAt: nextMain.updatedAt,
        updatedByEmail: nextMain.updatedByEmail,
        updatedByUid: nextMain.updatedByUid
      };
      const projectedMain = firestoreDocumentSize(nextMain, getArchiveDocPath());
      const projectedLog = firestoreDocumentSize(nextLog, getArchiveLogDocPath());
      const mainFits = projectedMain <= FIRESTORE_SAFE_DOC_BYTES && nextMain.payloadJson.length <= PAYLOAD_JSON_RULES_MAX;
      const logFits = projectedLog <= FIRESTORE_SAFE_DOC_BYTES && nextLog.changeLogJson.length <= PAYLOAD_JSON_RULES_MAX;
      const needsMove = extracted.hadEmbeddedLog;
      const alreadyMigrated = !extracted.hadEmbeddedLog;
      return {
        loaded: true, extracted, merged, tree, nextMain, nextLog,
        people, families, events: events.length, snapshots, embeddedCount, logDocCount, logExists: Boolean(logExists),
        currentMainBytes, currentLogBytes, projectedMain, projectedLog, mainFits, logFits,
        alreadyMigrated, needsMove, hadEmbeddedShape: extracted.hadEmbeddedLog,
        extraMainKeys: Object.keys(mainData || {}).filter(k => !['title','revision','superAdminEmail','authorizedEmails','editorEmails','updatedAt','updatedByEmail','updatedByUid','payloadJson'].includes(k))
      };
    }

    function meterHtml(label, bytes, note) {
      const pct = Math.min(100, (bytes / FIRESTORE_DOC_LIMIT_BYTES) * 100);
      const color = pct >= 90 ? 'bg-rose-600' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-600';
      return `<div class="p-3 rounded-xl bg-parchment-50 border border-parchment-200 space-y-1.5">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">${escapeHtml(label)}</p>
          <p class="text-xs font-semibold text-slate-800">${escapeHtml(formatStorageKb(bytes))} of 1 MB (${Math.round(pct)}%)</p>
        </div>
        <div class="h-2 rounded-full bg-parchment-200 overflow-hidden"><div class="h-full ${color}" style="width:${pct}%"></div></div>
        ${note ? `<p class="text-[11px] text-slate-500">${escapeHtml(note)}</p>` : ''}
      </div>`;
    }

    function renderSizes(plan) {
      if (!plan || !plan.loaded) {
        $('mig-size-grid').innerHTML = '<p class="text-xs text-slate-500">Sizes will appear once the tree document has loaded.</p>';
        return;
      }
      $('mig-size-grid').innerHTML = [
        meterHtml('Tree document now', plan.currentMainBytes, plan.needsMove ? 'Includes the embedded change log' : getArchiveDocPath()),
        meterHtml('Log document now', plan.currentLogBytes, plan.logExists ? getArchiveLogDocPath() : 'Not created yet'),
        meterHtml('Tree after the move', plan.projectedMain, 'payloadJson without the change log'),
        meterHtml('Log after the move', plan.projectedLog, `${plan.events} entries · ${plan.snapshots} with snapshots`)
      ].join('');
    }

    function dryRunIssues(plan) {
      const issues = [];
      if (!plan || !plan.loaded) return issues;
      if (!plan.mainFits) issues.push('The projected tree document is too large (over about 1,040,000 bytes or the payloadJson rules cap).');
      if (!plan.logFits) issues.push('The projected log document is too large. The move would need to trim oldest snapshots first — do that from the admin Change log tab after a successful move, or contact support if this blocks the first move.');
      if (plan.extraMainKeys.length) issues.push('The live tree document has extra fields (' + plan.extraMainKeys.join(', ') + '). The move updates known fields only and leaves extras in place.');
      if (firebaseUser && firebaseUser.emailVerified === false) issues.push('This Google account is not marked email-verified. The Super Admin is still allowed by the latest rules, but older deployed rules would refuse the write.');
      if (plan.needsMove && plan.embeddedCount > 0 && plan.events < plan.embeddedCount) {
        issues.push('The merged log would have fewer entries than the embedded log. The move is blocked so history cannot be lost.');
      }
      return issues;
    }

    function renderDryRun(plan) {
      const body = $('mig-dry-body');
      const card = $('mig-dry-card');
      card.classList.remove('hidden');
      if (!plan || !plan.loaded) {
        dryRunOk = false;
        body.innerHTML = `<p>No write will be planned until the tree document has finished loading. This is not the same as “already moved”.</p>`;
        addLog('Dry run: documents are not loaded yet — not treated as already migrated.');
        return { plan, issues: [], ok: false };
      }
      const issues = dryRunIssues(plan);
      if (plan.alreadyMigrated) {
        dryRunOk = true;
        body.innerHTML = `<p>No write is needed. The log is already in its own document (${plan.logDocCount} entries).</p>`;
        addLog('Dry run: already migrated; no write needed.');
      } else {
        const blocked = issues.some(i => i.startsWith('The projected') || i.includes('fewer entries than the embedded log'));
        dryRunOk = !blocked;
        body.innerHTML = `
          <p>Would write <code class="font-mono" data-archive-log-path>archives/familytree_log</code> first (${escapeHtml(formatStorageKb(plan.projectedLog))}, ${plan.events} entries), then update <code class="font-mono" data-archive-path>archives/familytree</code> (${escapeHtml(formatStorageKb(plan.projectedMain))}) with payloadJson that no longer contains changeEvents or changeSequence.</p>
          <p>Revision goes to <strong>${escapeHtml(String(plan.nextMain.revision))}</strong>. ${plan.people} people and ${plan.families} families are unchanged. ${plan.embeddedCount} embedded entries and ${plan.snapshots} revert snapshots will be copied.</p>
          ${issues.length ? `<ul class="list-disc list-inside text-amber-900">${issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '<p class="text-emerald-800 font-medium">Dry run looks safe to proceed after you download a backup.</p>'}
        `;
        addLog('Dry run: projected tree ' + formatStorageKb(plan.projectedMain) + ', log ' + formatStorageKb(plan.projectedLog) + ', ' + plan.events + ' merged entries (from ' + plan.embeddedCount + ' embedded).');
      }
      return { plan, issues, ok: dryRunOk };
    }

    function renderState(plan) {
      const badge = $('mig-state-badge');
      const summary = $('mig-state-summary');
      if (!plan || !plan.loaded) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-slate-100 text-slate-700';
        badge.textContent = 'Loading';
        summary.textContent = (plan && plan.unloadReason) || 'Loading documents…';
        $('mig-counts').textContent = '—';
      } else if (plan.alreadyMigrated) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800';
        badge.textContent = 'Already moved';
        summary.textContent = 'The change log is already in ' + getArchiveLogDocPath() + '. Running this page again will not change the tree. You can still download a backup.';
        $('mig-counts').textContent = `${plan.people} people · ${plan.families} families · ${plan.embeddedCount} embedded log entries · ${plan.logDocCount} entries already in the log document · ${plan.events} after merge · ${plan.snapshots} with revert snapshots`;
      } else if (plan.logExists && plan.needsMove) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-200/80 text-amber-950';
        badge.textContent = 'Needs merge';
        summary.textContent = 'The tree document still has an embedded change log, and a log document already exists. A move will merge both (keeping snapshots) so history is not lost, then remove the log from the tree document.';
        $('mig-counts').textContent = `${plan.people} people · ${plan.families} families · ${plan.embeddedCount} embedded log entries · ${plan.logDocCount} entries already in the log document · ${plan.events} after merge · ${plan.snapshots} with revert snapshots`;
      } else {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-200/80 text-amber-950';
        badge.textContent = 'Needs move';
        summary.textContent = 'The change history is still stored inside payloadJson on ' + getArchiveDocPath() + '. This page will copy it to ' + getArchiveLogDocPath() + ', then remove it from the tree document.';
        $('mig-counts').textContent = `${plan.people} people · ${plan.families} families · ${plan.embeddedCount} embedded log entries · ${plan.logDocCount} entries already in the log document · ${plan.events} after merge · ${plan.snapshots} with revert snapshots`;
      }
      renderSizes(plan);
    }

    // Always rebuild from the current documents, then refresh every card from that same plan.
    function inspectAndRender(opts = {}) {
      const plan = inspectArchive(mainSnapData, logSnapData, logSnapExists);
      lastPlan = plan;
      renderState(plan);
      if (opts.includeDryRun || !$('mig-dry-card').classList.contains('hidden')) {
        renderDryRun(plan);
      }
      updateMoveEnabled();
      return plan;
    }

    function updateMoveEnabled() {
      const btn = $('btn-mig-move');
      const hint = $('btn-mig-hint');
      if (lastPlan && lastPlan.loaded && lastPlan.alreadyMigrated) {
        btn.disabled = true;
        btn.textContent = 'Already complete';
        hint.textContent = 'Nothing left to move. You can still download a backup.';
        return;
      }
      const ready = Boolean(dryRunOk && backupDownloaded && lastPlan && lastPlan.loaded && lastPlan.mainFits && lastPlan.logFits);
      btn.disabled = !ready;
      btn.textContent = 'Move change log';
      if (!lastPlan || !lastPlan.loaded) hint.textContent = 'Wait for the tree document to load, then run a dry run and download a backup.';
      else if (!dryRunOk) hint.textContent = 'Run a dry run and download a backup before the move is unlocked.';
      else if (!backupDownloaded) hint.textContent = 'Download a JSON backup to unlock the move.';
      else if (lastPlan && (!lastPlan.mainFits || !lastPlan.logFits)) hint.textContent = 'The dry run found a size problem — the move stays locked.';
      else hint.textContent = 'Backup saved. You can move the change log now.';
    }

    function runDryRun() {
      clearError();
      const plan = inspectAndRender({ includeDryRun: true });
      return { plan, issues: dryRunIssues(plan), ok: dryRunOk };
    }

    function downloadBackup() {
      const plan = inspectAndRender();
      if (!plan.loaded) throw new Error('The tree document has not finished loading, so a backup was not created.');
      const parsed = parsePayload(mainSnapData);
      const bundle = {
        exportedAt: new Date().toISOString(),
        note: 'Readable backup of ' + getSiteTitle() + '. The family tree is the JSON that is stored in the payloadJson string field of ' + getArchiveDocPath() + '. The change log is stored in changeLogJson on ' + getArchiveLogDocPath() + ' (or still embedded in payloadJson before this move).',
        documents: {
          [getArchiveDocPath()]: {
            title: mainSnapData && mainSnapData.title,
            revision: mainSnapData && mainSnapData.revision,
            superAdminEmail: mainSnapData && mainSnapData.superAdminEmail,
            authorizedEmails: mainSnapData && mainSnapData.authorizedEmails,
            editorEmails: mainSnapData && mainSnapData.editorEmails,
            updatedAt: mainSnapData && mainSnapData.updatedAt,
            payloadJson_parsed: parsed
          },
          [getArchiveLogDocPath()]: logSnapExists ? { changeLogJson_parsed: logStateFromLogDoc(logSnapData), updatedAt: logSnapData && logSnapData.updatedAt } : null
        },
        mergedChangeLogAfterMove: plan.merged,
        treeAfterMove: plan.tree
      };
      const pretty = JSON.stringify(bundle, null, 2);
      const blob = new Blob([pretty], { type: 'application/json' });
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(blob);
      a.download = `${getArchiveId()}-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      backupDownloaded = true;
      addLog('Downloaded JSON backup (' + formatStorageKb(utf8ByteLength(pretty)) + ').');
      updateMoveEnabled();
      return { fileName: a.download, bytes: utf8ByteLength(pretty) };
    }

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    let testLogWriteCount = null;

    function verifyWrittenLog(logData, plan) {
      const verified = logStateFromLogDoc(logData);
      const got = (verified && verified.changeEvents || []).length;
      const gotSnaps = (verified && verified.changeEvents || []).filter(ev => ev && (ev.beforeSnapshot || ev.afterSnapshot)).length;
      const wantMerged = (plan.merged && plan.merged.changeEvents || []).length;
      const wantEmbedded = plan.embeddedCount;
      const wantSnaps = plan.snapshots;
      if (!verified || got < wantEmbedded) {
        throw { code: 'aborted', message: `Log document read-back had ${got} entries, which is fewer than the ${wantEmbedded} embedded entries counted before the write. The tree document was not changed.` };
      }
      if (got < wantMerged) {
        throw { code: 'aborted', message: `Log document read-back had ${got} entries, expected at least ${wantMerged}. The tree document was not changed.` };
      }
      if (gotSnaps < wantSnaps) {
        throw { code: 'aborted', message: `Log document read-back had ${gotSnaps} snapshots, expected at least ${wantSnaps}. The tree document was not changed.` };
      }
      return { got, gotSnaps };
    }

    function plannedLogPayload(plan) {
      if (typeof testLogWriteCount === 'number') {
        const parsed = JSON.parse(plan.nextLog.changeLogJson);
        parsed.changeEvents = (parsed.changeEvents || []).slice(0, testLogWriteCount);
        return { ...plan.nextLog, changeLogJson: JSON.stringify({ changeEvents: parsed.changeEvents, changeSequence: parsed.changeSequence || 0 }) };
      }
      return plan.nextLog;
    }

    async function performMove() {
      clearError();
      if (!dryRunOk || !backupDownloaded) {
        return { ok: false, error: { code: 'failed-precondition', message: 'Run a dry run and download a backup first.' } };
      }
      const btn = $('btn-mig-move');
      btn.disabled = true;
      btn.textContent = 'Moving…';
      try {
        addLog('Step 1 of 4: Re-reading ' + getArchiveDocPath() + ' and ' + getArchiveLogDocPath() + '.');
        if (!demoMode) {
          const mainRef = doc(db, 'archives', getArchiveId());
          const logRef = doc(db, 'archives', getArchiveLogId());
          const [mainSnap, logSnap] = await Promise.all([getDoc(mainRef), getDoc(logRef)]);
          if (!mainSnap.exists()) throw { code: 'not-found', message: 'The tree document ' + getArchiveDocPath() + ' was not found.' };
          mainSnapData = mainSnap.data();
          logSnapExists = logSnap.exists();
          logSnapData = logSnapExists ? logSnap.data() : null;
        }
        const plan = inspectAndRender();
        if (!plan.loaded) throw { code: 'failed-precondition', message: 'The tree document has not been loaded, so the move was not started.' };
        if (plan.alreadyMigrated) {
          if (plan.embeddedCount > 0) throw { code: 'aborted', message: 'Inspection disagreed with itself (marked already moved but still has embedded entries). Nothing was written.' };
          addLog('Re-read shows the log is already in its own document. Nothing to write.');
          updateMoveEnabled();
          return { ok: true, already: true };
        }
        if (plan.embeddedCount > 0 && plan.events < plan.embeddedCount) {
          throw { code: 'aborted', message: `The merged log would have ${plan.events} entries, fewer than the ${plan.embeddedCount} embedded entries. Nothing was written.` };
        }
        if (plan.needsMove && plan.embeddedCount === 0 && plan.events === 0) {
          // Keys are present but empty — still safe to strip after writing an empty log doc.
          addLog('Embedded log keys are present but there are no entries to copy.');
        }
        if (plan.embeddedCount > 0 && plan.events === 0) {
          throw { code: 'aborted', message: 'A move with 0 entries was refused because the tree still has an embedded change log. Nothing was written.' };
        }
        if (!plan.mainFits || !plan.logFits) throw { code: 'resource-exhausted', message: 'After re-reading, the projected documents no longer fit.' };

        const embeddedBefore = plan.embeddedCount;
        const writtenLog = plannedLogPayload(plan);
        addLog('Step 2 of 4: Writing the merged change log to ' + getArchiveLogDocPath() + ' (history is copied here first, so it cannot be lost). ' + embeddedBefore + ' embedded entries will be copied.');
        if (!demoMode) {
          const logRef = doc(db, 'archives', getArchiveLogId());
          await setDoc(logRef, writtenLog, { merge: true });
          const verifyLog = await getDoc(logRef);
          const check = verifyWrittenLog(verifyLog.exists() ? verifyLog.data() : null, plan);
          logSnapData = verifyLog.data();
          logSnapExists = true;
          addLog('Step 2 complete: log document is in place with ' + check.got + ' entries.');
        } else {
          await delay(200);
          const check = verifyWrittenLog(writtenLog, plan);
          logSnapData = writtenLog;
          logSnapExists = true;
          addLog('Step 2 complete: log document is in place with ' + check.got + ' entries.');
        }

        addLog('Step 3 of 4: Updating ' + getArchiveDocPath() + ' to remove changeEvents and changeSequence from payloadJson.');
        if (!demoMode) {
          const mainRef = doc(db, 'archives', getArchiveId());
          await setDoc(mainRef, plan.nextMain, { merge: true });
          const verifyMain = await getDoc(mainRef);
          mainSnapData = verifyMain.data();
        } else {
          await delay(200);
          mainSnapData = plan.nextMain;
        }
        addLog('Step 3 complete: tree document updated.');

        addLog('Step 4 of 4: Verifying the move.');
        const after = inspectAndRender({ includeDryRun: true });
        if (!after.alreadyMigrated) throw { code: 'aborted', message: 'Verification still found an embedded log in payloadJson. The log document was written; you can retry the last step.' };
        if (after.logDocCount < embeddedBefore) throw { code: 'aborted', message: `Verification found only ${after.logDocCount} log-document entries, fewer than the ${embeddedBefore} embedded entries counted before the move.` };
        addLog('Move complete. The change log now lives in ' + getArchiveLogDocPath() + ' (' + after.logDocCount + ' entries).');
        dryRunOk = true;
        updateMoveEnabled();
        return { ok: true, moved: after.logDocCount, embeddedBefore };
      } catch (err) {
        const formatted = showError(err);
        inspectAndRender();
        updateMoveEnabled();
        return { ok: false, error: err, formatted };
      } finally {
        if (lastPlan && lastPlan.loaded && lastPlan.alreadyMigrated) {
          btn.disabled = true;
          btn.textContent = 'Already complete';
        } else {
          btn.textContent = 'Move change log';
        }
      }
    }

    function demoDocuments() {
      const persons = {
        p1: { id: 'p1', given: 'Alex', surname: 'Rivera', emails: [getConfiguredSuperAdminEmail()] },
        p2: { id: 'p2', given: 'Sam', surname: 'Rivera', emails: [] }
      };
      const families = { f1: { id: 'f1', partners: ['p1'], children: ['p2'] } };
      const snap = { tree: { title: getSiteTitle(), revision: 3 }, persons, families, accessControl: { permissions: [] } };
      const changeEvents = [5,4,3,2,1].map(i => ({
        id: 'chg_' + i, sequence: i, timestamp: '2026-11-0' + i + ' 10:00',
        actorRole: 'Super Admin', category: i === 1 ? 'Access Control' : 'Tree',
        summary: 'Edit ' + i, reverted: false, beforeSnapshot: snap, afterSnapshot: snap
      }));
      const state = {
        tree: { id: getDefaultTreeId(), title: getSiteTitle(), revision: 3 },
        superAdminEmail: getConfiguredSuperAdminEmail(), persons, families,
        accessControl: { permissions: [{ email: getConfiguredSuperAdminEmail(), role: 'super_admin' }], auditLog: [] },
        changeEvents, changeSequence: 5
      };
      return {
        main: {
          title: getSiteTitle(), revision: 3, superAdminEmail: getConfiguredSuperAdminEmail(),
          authorizedEmails: [getConfiguredSuperAdminEmail()], editorEmails: [getConfiguredSuperAdminEmail()],
          updatedAt: '2026-11-19T10:00:00.000Z', updatedByEmail: getConfiguredSuperAdminEmail(), updatedByUid: 'demo',
          payloadJson: JSON.stringify(state)
        },
        log: null
      };
    }

    function showWorkspace(user) {
      $('mig-lock').classList.add('hidden');
      $('mig-main').classList.remove('hidden');
      $('mig-role-pill').classList.remove('hidden');
      $('mig-role-pill').textContent = 'Super Admin: ' + getConfiguredSuperAdminEmail();
      $('mig-status-pill').textContent = demoMode ? 'Demo data' : ('Signed in: ' + normEmail(user && user.email));
    }

    function showLock(reason) {
      $('mig-lock').classList.remove('hidden');
      $('mig-main').classList.add('hidden');
      $('mig-role-pill').classList.add('hidden');
      if (reason) $('mig-lock-reason').innerHTML = reason;
    }

    async function loadDocuments() {
      clearError();
      if (demoMode) {
        const demo = demoDocuments();
        mainSnapData = demo.main;
        logSnapData = demo.log;
        logSnapExists = false;
        firebaseUser = firebaseUser || { email: getConfiguredSuperAdminEmail(), uid: 'demo', emailVerified: true };
        const plan = inspectAndRender();
        addLog('Loaded demo documents (no Firestore writes will be made).');
        return plan;
      }
      const mainRef = doc(db, 'archives', getArchiveId());
      const logRef = doc(db, 'archives', getArchiveLogId());
      const [mainSnap, logSnap] = await Promise.all([getDoc(mainRef), getDoc(logRef)]);
      if (!mainSnap.exists()) throw { code: 'not-found', message: 'The tree document ' + getArchiveDocPath() + ' was not found.' };
      mainSnapData = mainSnap.data();
      logSnapExists = logSnap.exists();
      logSnapData = logSnapExists ? logSnap.data() : null;
      const plan = inspectAndRender();
      addLog('Loaded ' + getArchiveDocPath() + '' + (logSnapExists ? ' and ' + getArchiveLogDocPath() + '.' : '. The log document does not exist yet.'));
      return plan;
    }

    function loadFixture(main, log, exists) {
      demoMode = true;
      firebaseUser = firebaseUser || { email: getConfiguredSuperAdminEmail(), uid: 'demo', emailVerified: true };
      mainSnapData = main;
      logSnapData = log || null;
      logSnapExists = Boolean(exists);
      backupDownloaded = false;
      dryRunOk = false;
      testLogWriteCount = null;
      $('mig-dry-card').classList.add('hidden');
      $('mig-dry-body').innerHTML = '';
      $('mig-log').innerHTML = '';
      showWorkspace({ email: getConfiguredSuperAdminEmail() });
      const plan = inspectAndRender();
      addLog('Loaded fixture documents (no Firestore writes will be made).');
      return plan;
    }

    function unloadDocumentsForTest() {
      mainSnapData = null;
      logSnapData = null;
      logSnapExists = false;
      lastPlan = null;
      backupDownloaded = false;
      dryRunOk = false;
      const plan = inspectAndRender({ includeDryRun: true });
      return plan;
    }

    async function startDemo() {
      demoMode = true;
      showWorkspace({ email: getConfiguredSuperAdminEmail() });
      await loadDocuments();
    }

    function resetDryRunCard() {
      $('mig-dry-card').classList.add('hidden');
      $('mig-dry-body').innerHTML = '';
      lastPlan = null;
      dryRunOk = false;
      backupDownloaded = false;
    }

    async function initLive() {
      const config = await resolveFirebaseConfig();
      if (!config) {
        showLock('This page could not load Firebase config from <code>/__/firebase/init.json</code>. Open it on the hosted site, or use the demo preview.');
        $('mig-status-pill').textContent = 'Firebase Config Missing';
        return;
      }
      firebaseApp = initializeApp(config);
      auth = getAuth(firebaseApp);
      db = getFirestore(firebaseApp);
      try { await setPersistence(auth, browserLocalPersistence); } catch (e) {
        try { await setPersistence(auth, browserSessionPersistence); } catch (e2) {}
      }
      getRedirectResult(auth).catch(() => {});
      onAuthStateChanged(auth, async (user) => {
        firebaseUser = user;
        resetDryRunCard();
        $('mig-log').innerHTML = '';
        if (!user || !user.email) {
          $('mig-status-pill').textContent = 'Sign In Required';
          showLock('Only the Super Admin can move the change log. Sign in with the Google account that owns this archive.');
          return;
        }
        if (!isSuperAdminUser(user)) {
          $('mig-status-pill').textContent = 'Access Restricted';
          showLock('Signed in as <strong>' + escapeHtml(normEmail(user.email)) + '</strong>, which is not the Super Admin (<span class="font-mono">' + getConfiguredSuperAdminEmail() + '</span>). Switch accounts to continue.');
          return;
        }
        showWorkspace(user);
        try { await loadDocuments(); }
        catch (err) { showError(err); }
      });
    }

    function startGoogleSignIn(redirect) {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      if (redirect) signInWithRedirect(auth, provider);
      else signInWithPopup(auth, provider).catch(err => showError(err));
    }

    $('btn-mig-signin').addEventListener('click', () => startGoogleSignIn(false));
    $('btn-mig-redirect').addEventListener('click', () => startGoogleSignIn(true));
    $('btn-mig-dry').addEventListener('click', () => { try { runDryRun(); } catch (e) { showError(e); } });
    $('btn-mig-backup').addEventListener('click', () => { try { downloadBackup(); } catch (e) { showError(e); } });
    $('btn-mig-move').addEventListener('click', () => { performMove(); });

    // Test-only hook: compiled in only for `vite build --mode test` (dist-test/).
    // Production builds define __OSR_TEST_HOOKS__ as false, so this block is dropped.
    if (__OSR_TEST_HOOKS__) {
      window.__MIGRATE = {
        startDemo,
        loadDocuments,
        loadFixture,
        unloadDocumentsForTest,
        inspectArchive,
        inspectAndRender,
        runDryRun,
        downloadBackup,
        performMove,
        formatError: formatFirestoreError,
        getPlan: () => lastPlan,
        isBackupDownloaded: () => backupDownloaded,
        isDryRunOk: () => dryRunOk,
        forceBackupDownloaded: () => { backupDownloaded = true; updateMoveEnabled(); },
        setTestLogWriteCount: (n) => { testLogWriteCount = n; },
        errorText: () => $('mig-error').textContent || '',
        errorCode: () => $('mig-error').getAttribute('data-error-code') || '',
        stateText: () => $('mig-state-summary').textContent || '',
        countsText: () => $('mig-counts').textContent || '',
        badgeText: () => $('mig-state-badge').textContent || '',
        logText: () => $('mig-log').innerText || '',
        dryText: () => $('mig-dry-body').innerText || '',
        sizeText: () => $('mig-size-grid').innerText || '',
        showError
      };
    }

    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1' || (__OSR_TEST_HOOKS__ && params.get('test') === '1')) {
      startDemo();
    } else {
      initLive();
    }
  