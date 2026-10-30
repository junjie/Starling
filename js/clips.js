/* Finished clips, kept in IndexedDB so a reload does not lose paid-for audio.

   The database name is specific to this app on purpose: everything under
   junjie.github.io is one origin, so this shares storage with any other
   project hosted there. */

const DB_NAME = 'starling';
const STORE = 'clips';

let opened = null;

function db() {
  opened ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opened;
}

async function run(mode, work) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const req = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const saveClip = (clip) => run('readwrite', (s) => s.put(clip));
export const deleteClip = (id) => run('readwrite', (s) => s.delete(id));
export const clearClips = () => run('readwrite', (s) => s.clear());

/* Newest first. Ids start with the creation time, so they sort that way. */
export async function allClips() {
  const clips = await run('readonly', (s) => s.getAll());
  return clips.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/* Browsers may clear origin storage under disk pressure; asking is what keeps
   Chromium and Firefox from doing so. The answer changes nothing here. */
export function askToKeep() {
  return navigator.storage?.persist?.().catch(() => false);
}
