import type { JouleStatus, ManualSettings } from '../types.ts';
import { uuid as newUuid } from '../uuid.ts';

const prefix = 'c6f2d9e3-49e7-4125-9014-bfc6d669';
export const UUID = Object.freeze({
  advertisement: '6e404321-b5a3-f393-e0a9-e50e24dcca9f',
  service: `${prefix}ff00`,
  serial: `${prefix}ff01`,
  proximity: `${prefix}ff05`,
  serverAddress: `${prefix}ff07`,
  message: `${prefix}ff08`,
  request: `${prefix}ff09`,
  incoming: `${prefix}ff0a`,
  outgoing: `${prefix}ff0b`,
  infoService: '8a7f1168-48af-4efb-83b5-e679f932ff00',
  broker: '8a7f1168-48af-4efb-83b5-e679f932ff02',
  platform: '8a7f1168-48af-4efb-83b5-e679f932ff04',
  networkService: 'a9d7166a-d72e-40a9-a002-48044cc30100',
  networkControl: 'a9d7166a-d72e-40a9-a002-48044cc30101',
});

export const Message = Object.freeze({
  ShadowStart: 1,
  ShadowEnd: 2,
  LoadStart: 3,
  LoadEnd: 4,
  ModeRequest: 5,
  ModeReply: 6,
  TimelineStart: 7,
  TimelineEnd: 8,
  Stop: 9,
  Heartbeat: 14,
  HeartbeatAck: 15,
  ShadowRequest: 16,
  ShadowReply: 17,
  VariablesStart: 18,
  VariablesEnd: 19,
  TimeRequest: 20,
  TimeReply: 21,
});
export const MAX_FRAME_BYTES = 256 * 1024;
export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });
export const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A packet is valid only after a matching End and the EXACT advertised byte
 * count. Decode UTF-8 after reassembly: multibyte characters may span packets.
 * Heartbeats can arrive between fragments without disturbing the frame.
 */
export class FrameDecoder {
  private pending: {
    start: number;
    end: number;
    size: number;
    bytes: number;
    chunks: Uint8Array[];
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private complete: (type: number, value: unknown) => void;
  private fail: (message: string) => void;
  constructor(complete: (type: number, value: unknown) => void, fail: (message: string) => void) {
    this.complete = complete;
    this.fail = fail;
  }
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
  message(value: JsonObject): void {
    const type = value.type;
    if (
      type === Message.ShadowStart ||
      type === Message.TimelineStart ||
      type === Message.VariablesStart
    ) {
      if (this.pending) this.fail('An incomplete Bluetooth frame was replaced.');
      this.reset();
      const size = value.len;
      if (
        !Number.isSafeInteger(size) ||
        (size as number) <= 0 ||
        (size as number) > MAX_FRAME_BYTES
      ) {
        this.fail('The Joule sent an invalid Bluetooth frame length.');
        return;
      }
      this.pending = { start: type, end: type + 1, size: size as number, bytes: 0, chunks: [] };
      this.timer = setTimeout(() => {
        this.reset();
        this.fail('A Bluetooth status frame timed out. Waiting for a fresh reading.');
      }, 8000);
    } else if (
      type === Message.ShadowEnd ||
      type === Message.TimelineEnd ||
      type === Message.VariablesEnd
    ) {
      const frame = this.pending;
      this.reset();
      if (!frame || frame.end !== type || frame.bytes !== frame.size) {
        this.fail('An incomplete Bluetooth frame was discarded.');
        return;
      }
      const bytes = new Uint8Array(frame.size);
      let offset = 0;
      for (const chunk of frame.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        this.complete(frame.start, JSON.parse(decoder.decode(bytes)) as unknown);
      } catch {
        this.fail('The Joule sent an unreadable Bluetooth frame.');
      }
    }
  }
  data(bytes: Uint8Array): void {
    if (!this.pending) return;
    if (this.pending.bytes + bytes.length > this.pending.size) {
      this.reset();
      this.fail('An oversized Bluetooth frame was discarded.');
      return;
    }
    this.pending.chunks.push(bytes.slice());
    this.pending.bytes += bytes.length;
  }
}

/** Only complete shadow snapshots are readings. Heartbeats are never samples. */
export function parseShadow(packet: unknown, at = Date.now()): JouleStatus | null {
  const root = object(packet);
  if (!root) return null;
  const state = object(root.state);
  const reported = object(state?.reported) ?? object(root.reported) ?? state ?? root;
  if (!Object.hasOwn(reported, 'heaters') || typeof reported.state !== 'string') return null;
  const heaters = Array.isArray(reported.heaters) ? reported.heaters : [];
  const heater = object(heaters.find((h) => object(h)?.id === 0)) ?? {};
  const recipe = object(reported.recipe) ?? {};
  const appliance = object(reported.appliance) ?? {};
  const firmware = object(reported.firmware) ?? {};
  const timers = Array.isArray(reported.timers) ? reported.timers : [];
  const timer = object(timers.find((t) => object(t)?.id === 0)) ?? {};
  const temp = numberOrNull(heater.cur_temp);
  const target = numberOrNull(heater.temp_sp);
  return {
    at,
    state: reported.state.slice(0, 80),
    temperatureC: temp !== null && temp >= -5 && temp <= 105 ? temp : null,
    targetC: target !== null && target >= 0 && target <= 100 ? target : null,
    nativeMode: numberOrNull(appliance.mode),
    recipeUuid:
      typeof reported.cookUUID === 'string'
        ? reported.cookUUID.slice(0, 80)
        : typeof recipe.uuid === 'string'
          ? recipe.uuid.slice(0, 80)
          : null,
    remainingSeconds: numberOrNull(timer.remaining) ?? numberOrNull(timer.seconds),
    firmware: {
      commFirmware: typeof firmware.commFirmware === 'string' ? firmware.commFirmware : undefined,
      teFirmware: typeof firmware.teFirmware === 'string' ? firmware.teFirmware : undefined,
    },
    errors: Array.isArray(reported.errors)
      ? reported.errors.slice(0, 20).map((e) => String(object(e)?.code ?? e).slice(0, 80))
      : [],
  };
}

export function validateManual(settings: ManualSettings): void {
  if (
    !Number.isFinite(settings.temperatureC) ||
    settings.temperatureC < 20 ||
    settings.temperatureC > 90
  )
    throw new Error('Choose a bath temperature from 20°C to 90°C.');
  if (
    !Number.isInteger(settings.durationSeconds) ||
    settings.durationSeconds < 10 ||
    settings.durationSeconds > 24 * 60 * 60
  )
    throw new Error('Choose a run time from 10 seconds to 24 hours.');
}

/**
 * BSV600 task-engine manual timed phase, followed by an explicit heater Stop.
 * The appliance owns the timer, even if this page closes. Time starts at Start,
 * not at temperature. This is NOT the vendor Turbo food/geometry algorithm.
 */
export function manualRecipe(settings: ManualSettings, uuid = newUuid()) {
  validateManual(settings);
  return {
    instructions: {
      id: `manual_${uuid.replaceAll('-', '').slice(0, 22)}`,
      uuid,
      stg: [
        {
          stp: [
            {
              instr: [
                { appliance: { mode: 23 } },
                { timer: { id: 0, action_n: 3 } },
                {
                  timer: {
                    id: 0,
                    down_from_n: settings.durationSeconds,
                    action_n: 1,
                    usage: 6,
                    autostart: 0,
                  },
                },
                { heater: { id: 0, temp_sp: settings.temperatureC, preheat: 0, action_n: 1 } },
                { wait: { timer: 0 } },
                { heater: { id: 0, action_n: 0 } },
                { timer: { id: 0, action_n: 3 } },
              ],
            },
          ],
        },
      ],
    },
    initialStep: 0,
    recipeSource: 'manual',
  };
}
