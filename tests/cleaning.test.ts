import { describe, expect, it, vi } from 'vitest';
import { JouleClient } from '../src/device/client.ts';
import { DemoGatt } from '../src/device/mock.ts';
import { Message } from '../src/device/protocol.ts';
import { CLEANING_SETTINGS, observeCleaning } from '../src/cleaning/session.ts';
import type { CleaningRun } from '../src/cleaning/session.ts';
import type { ConnectionSnapshot } from '../src/types.ts';

const run: CleaningRun = {
  uuid: '00000000-0000-4000-8000-000000000001',
  deviceId: 'test-joule',
  kind: 'mock',
  startedAt: 1000,
  seenRunning: false,
  peakTemperatureC: null,
  stoppedAt: null,
  interrupted: false,
  stopRequested: false,
};
function snapshot(): ConnectionSnapshot {
  return {
    phase: 'connected',
    kind: 'mock',
    identity: {
      id: run.deviceId,
      name: 'Test Joule',
      model: 'BSV600',
      serial: 'TEST',
      commFirmware: '1.9.23',
    },
    status: {
      at: 2000,
      state: 'cooking',
      temperatureC: 60,
      targetC: 60,
      nativeMode: 23,
      recipeUuid: run.uuid,
      remainingSeconds: 1799,
      firmware: { commFirmware: '1.9.23', teFirmware: '2.5.2' },
      errors: [],
    },
    proximity: 2,
    lastHeartbeat: 2000,
    error: null,
    command: null,
    message: null,
  };
}

describe('cleaning observations', () => {
  it('waits for its actual program, then a fresh idle report, before showing rinse steps', () => {
    const state = snapshot();
    state.status!.state = 'idle';
    state.status!.recipeUuid = null;
    expect(observeCleaning(run, state, 2000)).toEqual(run);
    const active = observeCleaning(run, snapshot(), 2000);
    expect(active).toMatchObject({ seenRunning: true, peakTemperatureC: 60, stoppedAt: null });
    expect(observeCleaning(active, state, 2000).stoppedAt).toBe(2000);
  });

  it.each(['disconnected', 'stale', 'another-device', 'another-transport', 'error'] as const)(
    'does not infer completion from %s data or elapsed time',
    (condition) => {
      const active = { ...run, seenRunning: true };
      const state = snapshot();
      state.status!.state = 'idle';
      let now = 2000;
      if (condition === 'disconnected') state.phase = 'disconnected';
      if (condition === 'stale') now += 31 * 60000;
      if (condition === 'another-device') state.identity!.id = 'other-joule';
      if (condition === 'another-transport') state.kind = 'bluetooth';
      if (condition === 'error') state.status!.errors = ['motor'];
      expect(observeCleaning(active, state, now)).toEqual(active);
    },
  );

  it('stops tracking when a different program appears, including after the rinse screen', () => {
    const state = snapshot();
    state.status!.recipeUuid = 'another-program';
    const changed = observeCleaning({ ...run, seenRunning: true, stoppedAt: 1500 }, state, 2000);
    expect(changed.interrupted).toBe(true);
    state.status!.state = 'idle';
    expect(observeCleaning(changed, state, 2000).interrupted).toBe(true);
  });

  it('can confirm a requested Stop after an unconfirmed Start, without claiming heating was seen', () => {
    const state = snapshot();
    state.status!.state = 'idle';
    state.status!.recipeUuid = null;
    const stopped = observeCleaning({ ...run, stopRequested: true }, state, 2000);
    expect(stopped).toMatchObject({ stoppedAt: 2000, seenRunning: false, peakTemperatureC: null });
  });

  it('keeps the confirmed end available after unplugging for rinsing', () => {
    const stopped = { ...run, seenRunning: true, stoppedAt: 2000 };
    const state = snapshot();
    state.phase = 'disconnected';
    expect(observeCleaning(stopped, state, 3000)).toEqual(stopped);
  });
});

it('sends a 60°C / 30-minute program that the independent device ends without a browser Stop', async () => {
  vi.useFakeTimers();
  const client = new JouleClient();
  const wire = new DemoGatt();
  try {
    await client.connect(wire);
    await client.requestControl();
    await wire.action('button');
    const uuid = await client.start(CLEANING_SETTINGS);
    expect(typeof uuid).toBe('string');
    expect(client.getSnapshot().status).toMatchObject({
      state: 'cooking',
      targetC: 60,
      remainingSeconds: 1800,
      recipeUuid: uuid,
    });
    vi.setSystemTime(Date.now() + 30 * 60000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getSnapshot().status).toMatchObject({ state: 'idle', targetC: null });
    expect(wire.device.commands.filter((command) => command.type === Message.Stop)).toEqual([]);
  } finally {
    await client.disconnect();
    vi.useRealTimers();
  }
});
