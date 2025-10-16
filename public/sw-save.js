// public/sw-save.js
/* global self, clients, registration, indexedDB */

const DB_NAME = 'save-queue-db';
const STORE = 'queue';
const VERSION = 1;

/* ------------ tiny IndexedDB helpers ------------ */
function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function pushJob(job) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({ ...job, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function takeJobs() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    const req = st.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      st.clear();
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

/* ------------ receive queue requests from the page ------------ */
// Expect: { type:'queue-save', endpoint, payload }
self.addEventListener('message', (evt) => {
  const data = evt.data || {};
  if (data.type === 'queue-save' && data.endpoint && data.payload) {
    pushJob({ endpoint: data.endpoint, payload: data.payload })
      .then(async () => {
        if ('sync' in registration) {
          try { await registration.sync.register('flush-save-queue'); } catch {}
        } else {
          flushNow(); // immediate attempt if Background Sync not available
        }
      })
      .catch(() => {});
  }
});

/* ------------ Background Sync handler ------------ */
self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-save-queue') {
    event.waitUntil(flushNow());
  }
});

async function flushNow() {
  const jobs = await takeJobs();
  if (!jobs.length) return;

  for (const j of jobs) {
    try {
      await fetch(j.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(j.payload),
        keepalive: true, // extra hint on compatible browsers
      });
    } catch {
      // Put it back for a later retry
      await pushJob(j);
    }
  }
}

/* ------------ lifecycle ------------ */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
