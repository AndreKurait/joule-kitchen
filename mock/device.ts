import { decodeRecipe } from './recipe.ts';
import { decoder, encode, encoder, Message, UUID } from '../src/device/protocol.ts';

export type MockAction =
  | 'button'
  | 'disconnect'
  | 'malformed'
  | 'silence'
  | 'resume'
  | 'turbo'
  | 'idle'
  | 'slow-upload'
  | 'sensor-fault';
export const MOCK_SERIAL = 'SIMULATED000001';
export const MOCK_NAME = 'Joule • simulated';

/**
 * Deterministic fake appliance. Understands the real GATT messages but never
 * imports the client's recipe compiler, shadow parser, or command controller.
 * No Bluetooth, Breville credentials, radio access, or cloud requests.
 */
export class MockDevice {
  private subscribers = new Map<string, Set<(bytes: Uint8Array) => void>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private proximity = 0;
  private reporting = 0;
  private received: { expected: number; chunks: Uint8Array[]; size: number } | null = null;
  private runningUntil: number | null = null;
  private target: number | null = null;
  private temperature = 22;
  private sensorMissing = false;
  private recipeUuid: string | null = null;
  private nativeMode: number | null = null;
  private silenced = false;
  private slowUpload = false;
  private lastTick = 0;
  private disconnectListener: () => void = () => {};
  private connected = false;
  private version = 0;
  readonly commands: { type: number; at: number }[] = [];
  connect() {
    this.connected = true;
    this.silenced = false;
    this.proximity = 0;
    this.lastTick = Date.now();
    this.interval = setInterval(() => this.tick(), 1000);
  }
  disconnect() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.connected = false;
    this.received = null;
    this.subscribers.clear();
    this.disconnectListener();
  }
  onDisconnect(listener: () => void) {
    this.disconnectListener = listener;
  }
  read(service: string, characteristic: string): Uint8Array {
    if (!this.connected) throw new Error('Simulated Bluetooth disconnected.');
    if (service === UUID.infoService && characteristic === UUID.platform)
      return encoder.encode(`APN3|A0|AZ|EX04|BSV600|1x9x23|${MOCK_SERIAL}`);
    if (service !== UUID.service) throw new Error('Unknown GATT service.');
    if (characteristic === UUID.serial) return encoder.encode(MOCK_SERIAL);
    if (characteristic === UUID.proximity) return new Uint8Array([this.proximity]);
    throw new Error('Unknown readable characteristic.');
  }
  subscribe(service: string, characteristic: string, listener: (bytes: Uint8Array) => void) {
    if (
      service !== UUID.service ||
      !new Set<string>([UUID.message, UUID.incoming, UUID.proximity]).has(characteristic)
    )
      throw new Error('Unknown notification characteristic.');
    const listeners = this.subscribers.get(characteristic) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(characteristic, listeners);
  }
  private notify(characteristic: string, bytes: Uint8Array) {
    if (this.silenced) return;
    this.subscribers.get(characteristic)?.forEach((listener) => listener(bytes.slice()));
  }
  private message(value: unknown) {
    this.notify(UUID.message, encode(value));
  }
  async write(service: string, characteristic: string, bytes: Uint8Array) {
    if (!this.connected) throw new Error('Simulated Bluetooth disconnected.');
    if (service !== UUID.service) throw new Error('Unknown writable GATT service.');
    if (characteristic === UUID.proximity) {
      const command = decoder.decode(bytes);
      if (command === `${MOCK_SERIAL}:connect`) this.proximity = 1;
      else if (command === `${MOCK_SERIAL}:stop`) this.proximity = 4;
      else throw new Error('Wrong proximity identity or action.');
      this.notify(UUID.proximity, new Uint8Array([this.proximity]));
      return;
    }
    if (characteristic === UUID.outgoing) {
      if (this.slowUpload) await new Promise((resolve) => setTimeout(resolve, 120));
      if (!this.connected) throw new Error('Simulated Bluetooth disconnected.');
      if (!this.received) throw new Error('No recipe transfer is in progress.');
      if (bytes.length > 20) throw new Error('Mock ATT payload exceeded 20 bytes.');
      this.received.chunks.push(bytes.slice());
      this.received.size += bytes.length;
      if (this.received.size > this.received.expected) throw new Error('Recipe length overflow.');
      return;
    }
    if (characteristic !== UUID.request) throw new Error('Unknown writable characteristic.');
    const message = JSON.parse(decoder.decode(bytes)) as {
      type: number;
      len?: number;
      payload?: { mode?: number; reason?: number };
    };
    this.commands.push({ type: message.type, at: Date.now() });
    if (message.type === Message.ModeRequest) {
      const mode = message.payload?.mode;
      if (mode !== 0 && mode !== 1) throw new Error('Unexpected reporting mode.');
      this.reporting = mode;
      this.message({ type: Message.ModeReply, mode, result: 0 });
    } else if (message.type === Message.ShadowRequest) {
      this.message({ type: Message.ShadowReply, result: 0 });
      this.shadow();
    } else if (message.type === Message.HeartbeatAck || message.type === Message.TimeReply) {
      return;
    } else if (message.type === Message.LoadStart) {
      if (this.proximity !== 2) throw new Error('Press the simulated physical button first.');
      if (!Number.isSafeInteger(message.len) || message.len! <= 0 || message.len! > 4096)
        throw new Error('Invalid recipe length.');
      this.received = { expected: message.len!, chunks: [], size: 0 };
    } else if (message.type === Message.LoadEnd) {
      const frame = this.received;
      this.received = null;
      if (!frame || frame.expected !== frame.size) throw new Error('Truncated recipe.');
      const recipeBytes = new Uint8Array(frame.size);
      let offset = 0;
      for (const chunk of frame.chunks) {
        recipeBytes.set(chunk, offset);
        offset += chunk.length;
      }
      const recipe = decodeRecipe(JSON.parse(decoder.decode(recipeBytes)) as unknown);
      this.target = recipe.temperature;
      this.runningUntil = Date.now() + recipe.duration * 1000;
      this.recipeUuid = recipe.uuid;
      this.nativeMode = 23;
      this.shadow();
    } else if (message.type === Message.Stop) {
      if (message.payload?.reason !== 1) throw new Error('Unexpected Stop reason.');
      this.received = null;
      this.stop();
    } else throw new Error(`Unsupported mock command ${message.type}.`);
  }
  private stop() {
    this.target = null;
    this.runningUntil = null;
    this.recipeUuid = null;
    this.nativeMode = null;
    this.shadow();
  }
  private tick() {
    const now = Date.now();
    const seconds = Math.min(5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.runningUntil && now >= this.runningUntil) this.stop();
    if (this.target !== null)
      this.temperature +=
        Math.sign(this.target - this.temperature) *
        Math.min(Math.abs(this.target - this.temperature), 0.22 * seconds);
    else this.temperature += (22 - this.temperature) * 0.004 * seconds;
    if (!this.silenced) {
      this.message({ type: Message.Heartbeat, payload: { status: 2, sec: 0 } });
      this.shadow();
    }
  }
  shadow(malformed = false) {
    if (this.reporting !== 1 || this.silenced) return;
    const bytes = encode({
      clientToken: 'simulation',
      version: ++this.version,
      state: {
        reported: {
          model: 'BSV600',
          state: this.target === null ? 'idle' : 'cooking',
          firmware: { commFirmware: '1.9.23', teFirmware: '2.5.2' },
          heaters: [
            {
              id: 0,
              cur_temp: this.sensorMissing ? null : Math.round(this.temperature * 10) / 10,
              temp_sp: this.target,
              state: this.target === null ? null : 1,
            },
          ],
          appliance: { mode: this.nativeMode },
          cookUUID: this.recipeUuid,
          recipe: { uuid: this.recipeUuid, state: this.target === null ? 0 : 1 },
          timers: this.runningUntil
            ? [
                {
                  id: 0,
                  state: 1,
                  remaining: Math.max(0, Math.ceil((this.runningUntil - Date.now()) / 1000)),
                },
              ]
            : [],
          errors: [],
          // Deliberately force UTF-8 characters across arbitrary fragment edges.
          note: 'Simulated bath • 22°C',
        },
      },
    });
    this.message({ type: Message.ShadowStart, len: bytes.length + (malformed ? 7 : 0) });
    const sizes = [13, 1, 19, 7, 20];
    let fragment = 0;
    for (let offset = 0; offset < bytes.length;) {
      const size = sizes[fragment++ % sizes.length]!;
      this.notify(UUID.incoming, bytes.slice(offset, offset + size));
      offset += size;
      if (fragment === 3) this.message({ type: Message.Heartbeat, payload: { status: 2, sec: 0 } });
    }
    this.message({ type: Message.ShadowEnd });
  }
  action(action: MockAction) {
    if (action === 'button') {
      if (this.proximity !== 1)
        throw new Error('Select Enable cooking before pressing the simulated button.');
      this.proximity = 2;
      this.notify(UUID.proximity, new Uint8Array([2]));
    } else if (action === 'disconnect') this.disconnect();
    else if (action === 'malformed') this.shadow(true);
    else if (action === 'silence') this.silenced = true;
    else if (action === 'resume') {
      this.silenced = false;
      this.sensorMissing = false;
      this.shadow();
    } else if (action === 'sensor-fault') {
      this.sensorMissing = true;
      this.shadow();
    } else if (action === 'slow-upload') this.slowUpload = true;
    else if (action === 'idle') this.stop();
    else if (action === 'turbo') {
      this.target = 68;
      this.runningUntil = Date.now() + 15 * 60000;
      this.nativeMode = 24;
      this.recipeUuid = '00000000-0000-4000-8000-000000000024';
      this.shadow();
    } else throw new Error('Unknown mock action.');
  }
}
