// Per-person edit locks (prototype).
//
// One small document per person being edited:
//   archives/oursharedroots/locks/{personId}
//   { personId, holderUid, holderEmail, holderName, acquiredAt, renewedAt, expiresAt }
// The holder renews it every HEARTBEAT_MS while the edit form is open and deletes
// it when the form closes or the page is hidden/unloaded. A lock whose
// expiresAt has passed counts as free, so a crashed tab or a lost connection
// frees the person after at most TTL_MS. Admins can force-release. Every page
// listens to the locks collection, so "X is editing" shows live.
// The rules (firestore.rules) enforce who may create, renew or delete a lock;
// the revision guard on the tree document stays the final safety net: a lock
// only avoids wasted work, it never makes a save that would otherwise fail
// succeed.
//
// Firestore functions are passed in (fsApi) so this module runs in the page
// (gstatic SDK) and in Node tests (npm firebase SDK) alike.

export const LOCK_TTL_MS = 2 * 60 * 1000;
export const LOCK_HEARTBEAT_MS = 45 * 1000;

const toMillis = (v) => (v == null ? 0 : typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || 0);

export function lockIsLive(lock, nowMs) {
  return Boolean(lock && toMillis(lock.expiresAt) > nowMs);
}

export function createEditLockManager({
  db, fsApi, archiveId = 'oursharedroots', user, ttlMs = LOCK_TTL_MS, heartbeatMs = LOCK_HEARTBEAT_MS,
  now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, onChange = () => {}, onError = () => {}
}) {
  const { doc, collection, onSnapshot, runTransaction, deleteDoc, serverTimestamp, Timestamp } = fsApi;
  const locksCol = () => collection(db, 'archives', archiveId, 'locks');
  const lockRef = (personId) => doc(db, 'archives', archiveId, 'locks', personId);
  const held = new Map();   // personId -> interval id
  let locks = {};           // personId -> lock data (live view)
  let clockOffsetMs = 0;    // server time - local time, learned from renewedAt echoes
  let unsubscribe = null;
  let unavailable = false;  // rules not deployed / offline: fall back to the revision guard only

  const serverNow = () => now() + clockOffsetMs;

  function snapshotLocks() {
    const out = {};
    const t = serverNow();
    for (const [id, l] of Object.entries(locks)) {
      out[id] = { ...l, live: lockIsLive(l, t), mine: l.holderUid === user.uid };
    }
    return out;
  }

  function watch() {
    if (unsubscribe) return unsubscribe;
    unsubscribe = onSnapshot(locksCol(), (qs) => {
      const next = {};
      qs.forEach((d) => {
        const data = d.data({ serverTimestamps: 'estimate' });
        next[d.id] = data;
        if (data.holderUid === user.uid && data.renewedAt && !d.metadata.hasPendingWrites) {
          clockOffsetMs = toMillis(data.renewedAt) - now(); // rough, good to a few seconds
        }
      });
      locks = next;
      onChange(snapshotLocks());
    }, (err) => { unavailable = true; onError(err); });
    return unsubscribe;
  }

  function lockFields(personId, existing) {
    const expires = Timestamp.fromMillis(serverNow() + ttlMs);
    return {
      personId,
      holderUid: user.uid,
      holderEmail: String(user.email || '').toLowerCase(),
      holderName: String(user.name || user.email || '').slice(0, 200),
      acquiredAt: existing && existing.holderUid === user.uid && existing.acquiredAt ? existing.acquiredAt : serverTimestamp(),
      renewedAt: serverTimestamp(),
      expiresAt: expires
    };
  }

  // Resolves { ok: true } when this user now holds the lock, or
  // { ok: false, holder } when someone else holds a live lock.
  async function acquire(personId) {
    if (unavailable) return { ok: true, unavailable: true };
    try {
      const result = await runTransaction(db, async (tx) => {
        const snap = await tx.get(lockRef(personId));
        const cur = snap.exists() ? snap.data() : null;
        if (cur && cur.holderUid !== user.uid && lockIsLive(cur, serverNow())) return { ok: false, holder: cur };
        tx.set(lockRef(personId), lockFields(personId, cur));
        return { ok: true };
      });
      if (result.ok && !held.has(personId)) {
        held.set(personId, setIntervalFn(() => renew(personId).catch((e) => { onError(e); return false; }), heartbeatMs));
      }
      return result;
    } catch (err) {
      if (err && (err.code === 'permission-denied' || err.code === 'unavailable' || err.code === 'failed-precondition')) {
        // A lock we cannot get is not a reason to block editing: the revision guard still protects the save.
        onError(err);
        if (err.code === 'permission-denied') {
          // Someone else's live lock also ends up here when our clock is far off; re-check what we can see.
          const cur = locks[personId];
          if (cur && cur.holderUid !== user.uid && lockIsLive(cur, serverNow())) return { ok: false, holder: cur };
        }
        return { ok: true, unavailable: true, error: err };
      }
      throw err;
    }
  }

  async function renew(personId) {
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(lockRef(personId));
      const cur = snap.exists() ? snap.data() : null;
      if (cur && cur.holderUid !== user.uid && lockIsLive(cur, serverNow())) {
        stopHeartbeat(personId); // an admin force-released it and someone else took it
        return false;
      }
      tx.set(lockRef(personId), lockFields(personId, cur));
      return true;
    });
  }

  function stopHeartbeat(personId) {
    const id = held.get(personId);
    if (id != null) clearIntervalFn(id);
    held.delete(personId);
  }

  async function release(personId) {
    const wasHeld = held.has(personId);
    stopHeartbeat(personId);
    if (!wasHeld && !(locks[personId] && locks[personId].holderUid === user.uid)) return false;
    try { await deleteDoc(lockRef(personId)); return true; } catch (e) { onError(e); return false; }
  }

  // Admins only (the rules refuse anyone else while the lock is live).
  async function forceRelease(personId) {
    await deleteDoc(lockRef(personId));
    return true;
  }

  // Best effort on pagehide/unload: fire the deletes without waiting. If they
  // do not reach the server, the locks expire after ttlMs anyway.
  function releaseAll() {
    for (const personId of [...held.keys()]) {
      stopHeartbeat(personId);
      try { deleteDoc(lockRef(personId)).catch(() => {}); } catch (e) {}
    }
  }

  function lockFor(personId) {
    const all = snapshotLocks();
    return all[personId] || null;
  }

  function stop() {
    releaseAll();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return { watch, acquire, renew, release, forceRelease, releaseAll, lockFor, locks: snapshotLocks, holds: (id) => held.has(id), stop, isUnavailable: () => unavailable };
}
