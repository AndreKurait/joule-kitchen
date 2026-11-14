import type { ConnectionKind, JouleStatus, Recording, Sample } from '../types.ts';
import { uuid } from '../uuid.ts';

const DATABASE = 'joule-kitchen';
const VERSION = 1;
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Browser storage failed.'));
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Browser storage transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage failed.'));
  });
}

export class HistoryStore {
  private database: Promise<IDBDatabase>;
  constructor(name = DATABASE) {
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not provide local history storage.'));
        return;
      }
      const open = indexedDB.open(name, VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('recordings', { keyPath: 'id' });
        const samples = db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
        samples.createIndex('sessionId', 'sessionId');
      };
      open.onsuccess = () => {
        open.result.onversionchange = () => open.result.close();
        resolve(open.result);
      };
      open.onerror = () => reject(open.error ?? new Error('Local history could not be opened.'));
      open.onblocked = () =>
        reject(new Error('Close other Joule Kitchen tabs to update local history.'));
    });
    // Storage can be unavailable before the UI is ready to await it.
    void this.database.catch(() => {});
  }
  async begin(kind: ConnectionKind): Promise<Recording> {
    const recording: Recording = {
      id: uuid(),
      startedAt: Date.now(),
      endedAt: null,
      kind,
      label: kind === 'mock' ? 'Simulated Joule' : 'Joule Turbo',
      sampleCount: 0,
    };
    const db = await this.database;
    const tx = db.transaction('recordings', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('recordings').add(recording);
    await done;
    return recording;
  }
  async append(recordingId: string, status: JouleStatus, gapBefore: boolean): Promise<Sample> {
    const db = await this.database;
    const tx = db.transaction(['samples', 'recordings'], 'readwrite');
    const done = transactionDone(tx);
    const sample: Sample = {
      sessionId: recordingId,
      at: status.at,
      temperatureC: status.temperatureC,
      targetC: status.targetC,
      state: status.state,
      nativeMode: status.nativeMode,
      recipeUuid: status.recipeUuid,
      remainingSeconds: status.remainingSeconds,
      gapBefore,
    };
    tx.objectStore('samples').add(sample);
    const records = tx.objectStore('recordings');
    const lookup = records.get(recordingId);
    lookup.onsuccess = () => {
      const previous = lookup.result as Recording | undefined;
      if (!previous) {
        tx.abort();
        return;
      }
      records.put({ ...previous, sampleCount: previous.sampleCount + 1 });
    };
    await done;
    return sample;
  }
  async finish(recordingId: string) {
    const db = await this.database;
    const tx = db.transaction('recordings', 'readwrite');
    const done = transactionDone(tx);
    const records = tx.objectStore('recordings');
    const lookup = records.get(recordingId);
    lookup.onsuccess = () => {
      const record = lookup.result as Recording | undefined;
      if (record) records.put({ ...record, endedAt: Date.now() });
    };
    await done;
  }
  async recordings(): Promise<Recording[]> {
    const db = await this.database;
    const records = (await request(
      db.transaction('recordings').objectStore('recordings').getAll(),
    )) as Recording[];
    return records.sort((a, b) => b.startedAt - a.startedAt);
  }
  async samples(recordingId: string): Promise<Sample[]> {
    const db = await this.database;
    const samples = (await request(
      db.transaction('samples').objectStore('samples').index('sessionId').getAll(recordingId),
    )) as Sample[];
    return samples.sort((a, b) => a.at - b.at);
  }
  async remove(recordingId: string) {
    const db = await this.database;
    const tx = db.transaction(['samples', 'recordings'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('recordings').delete(recordingId);
    const cursor = tx
      .objectStore('samples')
      .index('sessionId')
      .openCursor(IDBKeyRange.only(recordingId));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      cursor.result.delete();
      cursor.result.continue();
    };
    await done;
  }
  async close() {
    (await this.database).close();
  }
}

/** User-controlled strings are quoted and spreadsheet formulas neutralized. */
function csvCell(value: unknown) {
  const string = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(string) && typeof value !== 'number' ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportCsv(recording: Recording, samples: Sample[]): string {
  const rows: unknown[][] = [
    [
      'timestamp_utc',
      'temperature_c',
      'target_c',
      'state',
      'native_mode',
      'remaining_seconds',
      'gap_before',
      'source',
      'recording_id',
    ],
    ...samples.map((sample) => [
      new Date(sample.at).toISOString(),
      sample.temperatureC,
      sample.targetC,
      sample.state,
      sample.nativeMode,
      sample.remainingSeconds,
      sample.gapBefore,
      recording.kind === 'mock' ? 'SIMULATED' : 'bluetooth',
      recording.id,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
