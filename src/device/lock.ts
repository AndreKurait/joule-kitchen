import type { GattWire } from './wire.ts';

const heldHere = new Set<string>();
const releasingHere = new Map<string, Promise<void>>();
const occupied = () =>
  new Error('This Joule is open in another connection. Disconnect it there first.');

/** Monitoring and recovery must never use the same appliance concurrently. */
export async function claimDeviceLock(wire: GattWire): Promise<() => void> {
  if (wire.kind === 'mock') return () => {};
  const key = `joule-kitchen-${wire.id}`;
  // Resolving a lock's hold promise does not synchronously release the browser
  // lock. Wait only for our own completed session, never for an active owner.
  const previousRelease = releasingHere.get(key);
  if (previousRelease) await previousRelease;
  if (heldHere.has(key)) throw occupied();
  heldHere.add(key);
  let releaseBrowserLock = () => {};
  let browserFinished: Promise<void> | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    heldHere.delete(key);
    if (browserFinished) {
      const finished = browserFinished;
      releasingHere.set(key, finished);
      void finished.then(() => {
        if (releasingHere.get(key) === finished) releasingHere.delete(key);
      });
    }
    releaseBrowserLock();
  };
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await new Promise<void>((resolve, reject) => {
        const request = navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
          if (!lock) throw occupied();
          await new Promise<void>((unlock) => {
            releaseBrowserLock = unlock;
            resolve();
          });
        });
        browserFinished = request.then(
          () => {},
          () => {},
        );
        void request.catch(reject);
      });
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
