// src/lib/swClient.ts
/**
 * Service Worker client for reliable “save on close”.
 * - Registers /sw-save.js
 * - Provides queueSave() to hand off a JSON payload to the SW.
 * - Falls back to fetch(..., { keepalive: true }) if SW is unavailable.
 */

const SW_URL = '/sw-save.js';

let registered = false;
let registerPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Call once at app/page load (safe to call multiple times). */
export function ensureSaveWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registered) return registerPromise!;
  if (!('serviceWorker' in navigator)) {
    registerPromise = Promise.resolve(null);
    registered = true;
    return registerPromise!;
  }
  registerPromise = navigator.serviceWorker
    .register(SW_URL, { scope: '/' })
    .then((reg) => {
      registered = true;
      return reg;
    })
    .catch(() => {
      registered = true;
      return null;
    });
  return registerPromise!;
}

/**
 * Queue a save job for the service worker.
 * If SW is missing or not ready, falls back to fetch keepalive (best-effort).
 *
 * @param endpoint Absolute or relative URL of your save endpoint (Edge Function).
 * @param payload  JSON-serializable body.
 */
export async function queueSave(endpoint: string, payload: unknown): Promise<void> {
  const reg = await ensureSaveWorker();
  const sw = navigator.serviceWorker;

  if (reg && sw?.controller) {
    try {
      sw.controller.postMessage({ type: 'queue-save', endpoint, payload });
      return;
    } catch {
      // fall through to keepalive
    }
  }

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // ignore
  }
}

/**
 * Convenience: attach a beforeunload handler that calls queueSave once.
 * Returns an unsubscribe function.
 */
export function attachBeforeUnloadSave(
  endpoint: string,
  payloadProvider: () => unknown | Promise<unknown>
): () => void {
  let fired = false;

  const handler = async () => {
    if (fired) return;
    fired = true;
    try {
      const data = await payloadProvider();
      await queueSave(endpoint, data);
    } catch {
      // ignore
    }
  };

  window.addEventListener('pagehide', handler);
  window.addEventListener('beforeunload', handler);

  return () => {
    window.removeEventListener('pagehide', handler);
    window.removeEventListener('beforeunload', handler);
  };
}
