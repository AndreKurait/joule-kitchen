import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { HistoryStore, exportCsv } from '../src/history/store.ts';
import { Recorder } from '../src/history/recorder.ts';
import type { JouleStatus, Sample } from '../src/types.ts';

const status = (at: number, temperatureC = 22): JouleStatus => ({
  at,
  state: 'idle',
  temperatureC,
  targetC: null,
  nativeMode: null,
  recipeUuid: null,
  remainingSeconds: null,
  firmware: {},
  errors: [],
});
describe('browser recordings', () => {
  it('survives reopening the database, retaining measured values, source and gaps', async () => {
    const name = `history-${crypto.randomUUID()}`;
    const store = new HistoryStore(name);
    const record = await store.begin('bluetooth');
    await store.append(record.id, status(1000), true);
    await store.append(record.id, status(2000, 22.1), false);
    await store.finish(record.id);
    await store.close();
    const reopened = new HistoryStore(name);
    expect((await reopened.recordings())[0]).toMatchObject({ sampleCount: 2, kind: 'bluetooth' });
    expect(await reopened.samples(record.id)).toMatchObject([
      { at: 1000, temperatureC: 22, targetC: null, gapBefore: true },
      { at: 2000, temperatureC: 22.1, targetC: null, gapBefore: false },
    ]);
    await reopened.remove(record.id);
    expect(await reopened.samples(record.id)).toEqual([]);
    expect(await reopened.recordings()).toEqual([]);
    await reopened.close();
  });
  it('separates mock and real sessions and marks a suspension as a recording gap', async () => {
    const store = new HistoryStore(`recorder-${crypto.randomUUID()}`);
    const samples: Sample[] = [],
      errors: string[] = [];
    const recorder = new Recorder(
      store,
      (_, sample) => samples.push(sample),
      (error) => errors.push(error),
    );
    recorder.record('mock', status(1000));
    recorder.record('mock', status(2000));
    await recorder.settled();
    recorder.markGap();
    recorder.record('mock', status(3000));
    recorder.record('bluetooth', status(4000));
    await recorder.end();
    expect(errors).toEqual([]);
    expect(samples.map((p) => p.gapBefore)).toEqual([true, false, true, true]);
    expect(samples[2]!.sessionId).not.toBe(samples[3]!.sessionId);
    expect((await store.recordings()).map((r) => r.kind).sort()).toEqual(['bluetooth', 'mock']);
    await store.close();
  });
  it('exports all readings with units and simulation labels, neutralizing formulas', async () => {
    const store = new HistoryStore(`export-${crypto.randomUUID()}`);
    const recording = await store.begin('mock');
    await store.append(recording.id, { ...status(1000), state: '=DANGEROUS()' }, true);
    const csv = exportCsv(recording, await store.samples(recording.id));
    expect(csv).toContain('"temperature_c"');
    expect(csv).toContain('"SIMULATED"');
    expect(csv).toContain(`"'=DANGEROUS()"`);
    expect(csv).not.toMatch(/serial|token|password/i);
    await store.close();
  });
});
