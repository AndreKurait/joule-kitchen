import { describe, expect, it, vi } from 'vitest';
import { decodeRecipe } from '../mock/recipe.ts';
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  Message,
  encode,
  manualRecipe,
  parseShadow,
} from '../src/device/protocol.ts';

describe('Bluetooth wire framing', () => {
  it('reassembles UTF-8 split at every byte, allowing interleaved heartbeats', () => {
    const complete = vi.fn(),
      fail = vi.fn();
    const receiver = new FrameDecoder(complete, fail);
    const packet = { state: { note: '22°C • 水' } };
    const bytes = encode(packet);
    receiver.message({ type: 1, len: bytes.length });
    for (const byte of bytes) {
      receiver.data(new Uint8Array([byte]));
      receiver.message({ type: 14, payload: { status: 4 } });
    }
    expect(complete).not.toHaveBeenCalled();
    receiver.message({ type: 2 });
    expect(complete).toHaveBeenCalledExactlyOnceWith(1, packet);
    expect(fail).not.toHaveBeenCalled();
  });
  it.each([
    ['truncated', 20, encode({ a: 1 }), 2],
    ['oversized', 1, encode({ a: 1 }), 2],
    ['wrong end', 7, encode({ a: 1 }), 8],
    ['invalid length', MAX_FRAME_BYTES + 1, new Uint8Array(), 2],
  ])('discards %s frames instead of recording false temperatures', (_, length, bytes, end) => {
    const complete = vi.fn(),
      fail = vi.fn();
    const receiver = new FrameDecoder(complete, fail);
    receiver.message({ type: 1, len: length });
    receiver.data(bytes);
    receiver.message({ type: end });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });
  it('times out incomplete transfers and recovers on the next complete frame', () => {
    vi.useFakeTimers();
    const complete = vi.fn(),
      fail = vi.fn();
    const receiver = new FrameDecoder(complete, fail);
    receiver.message({ type: 1, len: 50 });
    vi.advanceTimersByTime(8001);
    expect(fail).toHaveBeenCalledOnce();
    const bytes = encode({ good: true });
    receiver.message({ type: 1, len: bytes.length });
    receiver.data(bytes);
    receiver.message({ type: 2 });
    expect(complete).toHaveBeenCalledExactlyOnceWith(1, { good: true });
    vi.useRealTimers();
  });
});

describe('real shadow shape and cook program', () => {
  it('keeps measured temperature separate from target and native Turbo mode', () => {
    expect(
      parseShadow(
        {
          state: {
            reported: {
              state: 'cooking',
              heaters: [{ id: 0, cur_temp: 62.3, temp_sp: 68 }],
              appliance: { mode: 24 },
              recipe: { uuid: 'test-cook' },
              firmware: { commFirmware: '1.9.23', teFirmware: '2.5.2' },
              timers: [],
              errors: [],
            },
          },
        },
        123,
      ),
    ).toMatchObject({
      at: 123,
      temperatureC: 62.3,
      targetC: 68,
      nativeMode: 24,
      recipeUuid: 'test-cook',
    });
  });
  it('never turns heartbeats, timeline events or partial shadows into readings', () => {
    expect(parseShadow({ type: Message.Heartbeat, payload: { status: 4 } })).toBeNull();
    expect(parseShadow({ events: [{ temperature: 55 }], uuid: 'timeline' })).toBeNull();
    expect(parseShadow({ state: { reported: { heaters: [{ id: 0, temp_sp: 55 }] } } })).toBeNull();
  });
  it('keeps missing target null and rejects implausible measured temperatures', () => {
    const parsed = parseShadow({ state: { heaters: [{ id: 0, cur_temp: 300 }], state: 'idle' } });
    expect(parsed).toMatchObject({ temperatureC: null, targetC: null });
  });
  it('compiles a bounded program with a device-owned timer and explicit heater-off', () => {
    const settings = { temperatureC: 55, durationSeconds: 1800 };
    const recipe = manualRecipe(settings);
    expect(decodeRecipe(recipe)).toEqual({
      uuid: recipe.instructions.uuid,
      temperature: 55,
      duration: 1800,
    });
    const altered = structuredClone(recipe);
    altered.instructions.stg[0]!.stp[0]!.instr.pop();
    expect(() => decodeRecipe(altered)).toThrow();
  });
  it.each([
    { temperatureC: 0, durationSeconds: 10 },
    { temperatureC: 91, durationSeconds: 10 },
    { temperatureC: NaN, durationSeconds: 10 },
    { temperatureC: 55, durationSeconds: Infinity },
    { temperatureC: 55, durationSeconds: 0 },
    { temperatureC: 55, durationSeconds: 86401 },
  ])('rejects invalid manual settings: %j', (settings) => {
    expect(() => manualRecipe(settings)).toThrow();
  });
});
