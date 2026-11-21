// Shared save / storage / change-log core used by both the tree page (tree.js)
// and the admin page (admin.js). Extracted verbatim from the two pages, which
// carried identical copies. Page-owned state that some helpers need (the
// Firestore handle and the signed-in user) is supplied via configureSaveCore().
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, runTransaction } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let saveCoreEnv = { getDb: () => null, getFirebaseUser: () => null };
export function configureSaveCore(env) {
  saveCoreEnv = Object.assign({}, saveCoreEnv, env || {});
}

    export function getOsConfig() {
      return (window.OSR_CONFIG && typeof window.OSR_CONFIG === 'object') ? window.OSR_CONFIG : {};
    }
    export function getArchiveId() {
      const id = String(getOsConfig().archiveId || 'familytree').trim();
      return id || 'familytree';
    }
    export function getArchiveLogId() {
      const raw = getOsConfig().archiveLogId;
      if (raw && String(raw).trim()) return String(raw).trim();
      return getArchiveId() + '_log';
    }
    export function getArchiveDocPath() { return 'archives/' + getArchiveId(); }
    export function getArchiveLogDocPath() { return 'archives/' + getArchiveLogId(); }
    export function generateId(prefix = 'id') {
      return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
    }
    export function deepClone(obj) {
      return JSON.parse(JSON.stringify(obj));
    }
    export function escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    // Pull a legacy in-payload change log out of a parsed main document, if one is still there.
    export function extractEmbeddedLog(parsed) {
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
    export function logStateFromLogDoc(data) {
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
    export function mergeLogStates(embeddedLog, docLog) {
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
    export const FIRESTORE_DOC_LIMIT_BYTES = 1048576; // official 1 MiB cap
    export const FIRESTORE_SAFE_DOC_BYTES = 1040000;  // block writes a little under the cap
    export const PAYLOAD_JSON_RULES_MAX = 1000000;    // firestore.rules: payloadJson / changeLogJson size
    export const ownWriteStamps = new Set(); // updatedAt values written by THIS tab
    export function rememberOwnStamp(stamp) {
      if (!stamp) return;
      ownWriteStamps.add(stamp);
    }
    export function isOwnEchoSnapshot(data) {
      return Boolean(data && data.updatedAt && ownWriteStamps.has(data.updatedAt));
    }
    export function utf8ByteLength(str) {
      try { return new TextEncoder().encode(String(str ?? '')).length; } catch (e) { return String(str ?? '').length * 3; }
    }
    // Firestore string size = UTF-8 bytes + 1. Used for collection IDs, document IDs, field names and string values.
    // See https://firebase.google.com/docs/firestore/storage-size
    export function firestoreStringSize(str) {
      return utf8ByteLength(str) + 1;
    }
    export function firestoreDocumentNameSize(path) {
      return String(path || '').split('/').filter(Boolean).reduce((sum, part) => sum + firestoreStringSize(part), 0) + 16;
    }
    export function isFirestoreTimestamp(value) {
      if (!value || typeof value !== 'object') return false;
      if (value instanceof Date) return true;
      if (typeof value.toMillis === 'function' && (typeof value.seconds === 'number' || typeof value._seconds === 'number')) return true;
      const seconds = value.seconds ?? value._seconds;
      const nanos = value.nanoseconds ?? value._nanoseconds;
      const keys = Object.keys(value);
      return keys.length <= 2 && typeof seconds === 'number' && typeof nanos === 'number';
    }
    export function firestoreValueSize(value) {
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
    export function firestoreMapSize(map) {
      let size = 32;
      if (!map) return size;
      for (const key of Object.keys(map)) {
        size += firestoreStringSize(key) + firestoreValueSize(map[key]);
      }
      return size;
    }
    export function firestoreDocumentSize(fields, path) {
      return firestoreDocumentNameSize(path) + firestoreMapSize(fields);
    }
    export function formatStorageKb(bytes) {
      const n = Math.max(0, Number(bytes) || 0);
      const kb = n / 1024;
      if (kb < 10) {
        const rounded = Math.round(kb * 10) / 10;
        return `${String(rounded.toFixed(1)).replace(/\.0$/, '')} KB`;
      }
      return `${Math.round(kb)} KB`;
    }
    export function reservedSizeForFields(fieldsWithoutPayload, payloadFieldName, path) {
      return firestoreDocumentNameSize(path) + 32
        + Object.keys(fieldsWithoutPayload).reduce((s, k) => s + firestoreStringSize(k) + firestoreValueSize(fieldsWithoutPayload[k]), 0)
        + firestoreStringSize(payloadFieldName);
    }
    export function jsonFitsInDoc(json, reserved, maxJsonChars = PAYLOAD_JSON_RULES_MAX) {
      const total = reserved + firestoreStringSize(json);
      const rulesOk = json.length < maxJsonChars && utf8ByteLength(json) < maxJsonChars;
      return { total, rulesOk, ok: rulesOk && total <= FIRESTORE_SAFE_DOC_BYTES };
    }
    export function describeMainStorage(fields, treeState) {
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
    export const LOG_CHECKPOINT_LIMIT = 3;
    export const LOG_EVENT_CAP = 60;
    export const CHANGE_DIFF_VERSION = 1;
    export function stableStringify(value) {
      if (value === undefined) return 'null';
      if (value === null) return 'null';
      const t = typeof value;
      if (t !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
      const keys = Object.keys(value).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
    }
    export function recordsEqual(a, b) {
      return stableStringify(a ?? null) === stableStringify(b ?? null);
    }
    export function emptyChangeDiff() {
      return { v: CHANGE_DIFF_VERSION, persons: {}, families: {} };
    }
    export function computeDomainDiff(beforeSnap, afterSnap) {
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
    export function changeDiffIsEmpty(diff) {
      if (!diff) return true;
      return Object.keys(diff.persons || {}).length === 0
        && Object.keys(diff.families || {}).length === 0
        && !diff.tree
        && !diff.permissions;
    }
    export function countDiffTouches(diff) {
      if (!diff) return 0;
      return Object.keys(diff.persons || {}).length
        + Object.keys(diff.families || {}).length
        + (diff.tree ? 1 : 0)
        + (diff.permissions ? 1 : 0);
    }
    export function hasLegacySnapshots(ev) {
      return Boolean(ev && ev.beforeSnapshot && ev.afterSnapshot);
    }
    export function hasUsableDiff(ev) {
      return Boolean(ev && ev.changeDiff && ev.changeDiff.v && !changeDiffIsEmpty(ev.changeDiff));
    }
    export function getEntryDiff(ev) {
      if (hasUsableDiff(ev)) return ev.changeDiff;
      if (hasLegacySnapshots(ev)) return computeDomainDiff(ev.beforeSnapshot, ev.afterSnapshot);
      return null;
    }
    export function entryIsRevertible(ev) {
      return Boolean(ev && !ev.reverted && !ev.resetMarker && (hasUsableDiff(ev) || hasLegacySnapshots(ev)));
    }
    export function miniSnapFromDiff(diff, side) {
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
    export function cloneDomainSnap(snap) {
      return deepClone({
        tree: (snap && snap.tree) || {},
        persons: (snap && snap.persons) || {},
        families: (snap && snap.families) || {},
        accessControl: { permissions: (snap && snap.accessControl && snap.accessControl.permissions) || [] }
      });
    }
    export function applyDomainDiffToSnap(snap, diff, inverse) {
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
    export function findRevertConflictsFromDiff(diff, currentSnap) {
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
    export function reconstructStateBeforeEntry(events, target, currentSnap) {
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
    export function isCheckpointCandidate(ev) {
      return Boolean(ev && !ev.resetMarker);
    }
    export function assignLogCheckpoints(events, latestAfterSnap, limit) {
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
    export function compactChangeLogEvents(events, currentSnap, limit) {
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
    export function countLogCheckpoints(events) {
      return (events || []).filter(ev => ev && ev.checkpointSnapshot).length;
    }
    export function countLegacySnapshots(events) {
      return (events || []).filter(ev => ev && (ev.beforeSnapshot || ev.afterSnapshot)).length;
    }
    export function appendChangeLogEntry(stateObj, summary, category, beforeSnap, afterSnap, actorStr) {
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
    export function trimChangeLogToFit(logState, pack, jsonFitsInDoc, reserved) {
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
    export function describeLogStorage(fields, logState) {
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
    export function storageTone(percent) {
      if (percent >= 90) return 'rose';
      if (percent >= 70) return 'amber';
      return 'emerald';
    }
    export function paintStorageRow(prefix, estimate, opts = {}) {
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
    export const APP_ERROR_LOG_KEY = 'osr_app_error_log_v1';
    export const APP_ERROR_LOG_CAP = 50;
    export function redactPii(text) {
      return String(text ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    }
    export function classifyAppError(err, context) {
      if (context) return context;
      const code = String((err && err.code) || '');
      const msg = String((err && (err.message || err.userMessage)) || '');
      if (code === 'permission-denied' || /security rules|insufficient permissions/i.test(msg)) return 'rules';
      if (code === 'unauthenticated' || /not signed in|auth/i.test(code + ' ' + msg)) return 'auth';
      if (code === 'resource-exhausted') return 'save';
      if (/parse|GEDCOM|JSON syntax/i.test(msg) || (err && err.name === 'SyntaxError')) return 'parse';
      return 'save';
    }
    export function loadAppErrorLog() {
      try {
        const raw = localStorage.getItem(APP_ERROR_LOG_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    }
    export function recordAppError(err, context, extra) {
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
    export function clearAppErrorLog() {
      try { localStorage.removeItem(APP_ERROR_LOG_KEY); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('osr-app-error-log')); } catch (e2) {}
    }
    export function downloadAppErrorLog() {
      const list = loadAppErrorLog();
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), errors: list }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = getArchiveId() + '-error-log.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    export async function canUseIndexedDbCache() {
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
    export async function openFirestoreDatabase(app) {
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
    export const OFFLINE_SAVE_MESSAGE = 'You appear to be offline. Saves need a network connection because they check that nobody else has edited the tree. Your change is still on this page — reconnect and try again.';
    export function isOfflineWriteError(err) {
      if (err && err.offline) return true;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
      const code = String((err && (err.code || err.name)) || '');
      const msg = String((err && (err.message || err.userMessage)) || '');
      if (/Someone else saved first|Another session saved first/i.test(msg)) return false;
      if (/client is offline|Failed to get document because the client is offline|network error|ERR_INTERNET_DISCONNECTED|Failed to fetch|the connection dropped/i.test(msg)) return true;
      if ((code === 'unavailable' || code === 'internal' || code === 'unknown') && /offline|network|internet|backend/i.test(msg)) return true;
      return false;
    }
    export function formatFirestoreError(err) {
      const code = (err && (err.code || err.name)) || 'unknown';
      const message = (err && err.message) ? String(err.message) : (err ? String(err) : 'Unknown error');
      const hints = [];
      if (code === 'permission-denied') hints.push('the deployed security rules refused this write');
      if (typeof saveCoreEnv.getFirebaseUser() !== 'undefined' && saveCoreEnv.getFirebaseUser() && saveCoreEnv.getFirebaseUser().emailVerified === false) {
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
    export function remoteStampIsForeign(remoteStamp, baseStamp) {
      return Boolean(baseStamp && remoteStamp && remoteStamp !== baseStamp && !ownWriteStamps.has(remoteStamp));
    }
    export function remoteRevisionIsForeign(remoteRevision, baseRevision) {
      if (baseRevision == null || remoteRevision == null || remoteRevision === '') return false;
      return Number(remoteRevision) !== Number(baseRevision);
    }
    export function remoteMainIsForeign(remoteMain, baseStamp, baseRevision) {
      if (!remoteMain) return false;
      return remoteStampIsForeign(remoteMain.updatedAt, baseStamp)
        || remoteRevisionIsForeign(remoteMain.revision, baseRevision);
    }
    export async function writeArchiveAndLog(mainRef, logRef, mainPayload, logPayload, baseMain, baseLog, baseMainRevision) {
      // Never fall back to a blind batch write: that could overwrite someone
      // else's save. Re-read updatedAt and revision inside a transaction and
      // retry a few times if the transaction itself fails.
      const maxAttempts = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let conflict = null;
        try {
          await runTransaction(saveCoreEnv.getDb(), async (tx) => {
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
