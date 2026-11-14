import type { ConnectionSnapshot, DeviceIdentity, JouleStatus, ManualSettings } from '../types.ts';
import { errorMessage } from '../types.ts';
import {
  decoder,
  encode,
  encoder,
  FrameDecoder,
  manualRecipe,
  Message,
  object,
  parseShadow,
  UUID,
} from './protocol.ts';
import type { GattWire } from './wire.ts';
import { claimDeviceLock } from './lock.ts';

const INITIAL: ConnectionSnapshot = {
  phase: 'disconnected',
  kind: null,
  identity: null,
  status: null,
  proximity: 0,
  lastHeartbeat: null,
  error: null,
  command: null,
  message: null,
};
const timeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
class Cancelled extends Error {
  constructor() {
    super('Start was cancelled.');
  }
}

/** One GATT operation at a time. Stop and heartbeat replies jump queued work. */
class WriteQueue {
  private jobs: { run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void }[] =
    [];
  private running = false;
  private closed = false;
  constructor(private readonly fatal: () => void) {}
  add(run: () => Promise<void>, priority = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Bluetooth disconnected.'));
    return new Promise<void>((resolve, reject) => {
      const job = { run, resolve, reject };
      if (priority) this.jobs.unshift(job);
      else this.jobs.push(job);
      void this.pump();
    });
  }
  close() {
    this.closed = true;
    this.jobs.splice(0).forEach((job) => job.reject(new Error('Bluetooth disconnected.')));
  }
  private async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.jobs.length && !this.closed) {
        const job = this.jobs.shift()!;
        try {
          await timeout(
            job.run(),
            8000,
            'The Bluetooth operation timed out. Command delivery may be uncertain; check the Joule.',
          );
          job.resolve();
        } catch (error) {
          job.reject(error);
          if (!(error instanceof Cancelled)) {
            this.close();
            this.fatal();
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export class JouleClient {
  private snapshot: ConnectionSnapshot = { ...INITIAL };
  private listeners = new Set<() => void>();
  private statusListeners = new Set<(status: JouleStatus) => void>();
  private wire: GattWire | null = null;
  private ownsTransport = false;
  private queue: WriteQueue | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private proximityTimeout: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private commandEpoch = 0;
  private pendingMode: {
    mode: number;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private stopWanted = false;
  private stopTask: Promise<void> | null = null;
  private lastStopAt = 0;
  private pendingStartUuid: string | null = null;
  private startDeadline: ReturnType<typeof setTimeout> | null = null;
  private releaseDeviceLock: (() => void) | null = null;
  private frame = new FrameDecoder(
    (type, packet) => this.frameReceived(type, packet),
    (error) => this.update({ error }),
  );
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  onStatus(listener: (status: JouleStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  private update(change: Partial<ConnectionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  choosing() {
    if (this.wire || this.snapshot.phase === 'choosing')
      throw new Error('Finish the current connection before choosing another.');
    this.update({ phase: 'choosing', error: null, message: null });
  }
  selectionFailed(error: unknown) {
    if (this.wire) return;
    const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
    this.update({ phase: 'disconnected', error: cancelled ? null : errorMessage(error) });
  }
  async connect(wire: GattWire): Promise<void> {
    if (this.wire) throw new Error('A Joule is already connected.');
    const epoch = ++this.epoch;
    this.wire = wire;
    this.stopWanted = false;
    this.update({ ...INITIAL, phase: 'connecting', kind: wire.kind });
    let opened = false;
    const checked = () => {
      if (this.epoch !== epoch || this.wire !== wire) throw new Error('Connection cancelled.');
    };
    try {
      const release = await claimDeviceLock(wire);
      if (this.epoch !== epoch || this.wire !== wire) {
        release();
        throw new Error('Connection cancelled.');
      }
      this.releaseDeviceLock = release;
      checked();
      this.ownsTransport = true;
      opened = true;
      wire.onDisconnect(() => {
        if (this.wire !== wire) return;
        this.lost(
          'Bluetooth disconnected. Reconnect to read the Joule before sending another Start.',
        );
      });
      this.queue = new WriteQueue(() =>
        this.lost('The connection failed. A command may not have arrived; check the Joule.'),
      );
      const opening = wire.connect();
      void opening.then(
        () => {
          if (this.wire !== wire) wire.disconnect();
        },
        () => {},
      );
      await timeout(
        opening,
        15000,
        'Could not connect. Move closer to the Joule and close other Bluetooth connections.',
      );
      checked();
      const serial = decoder
        .decode(
          await timeout(
            wire.read(UUID.service, UUID.serial),
            8000,
            'Could not read Joule identity.',
          ),
        )
        .replace(/\0+$/, '');
      const platform = decoder
        .decode(
          await timeout(
            wire.read(UUID.infoService, UUID.platform),
            8000,
            'Could not read the Joule platform.',
          ),
        )
        .replace(/\0+$/, '')
        .split('|');
      checked();
      if (platform[4] !== 'BSV600' || !serial || serial.length > 64 || platform[6] !== serial)
        throw new Error(
          'This app supports Joule Turbo BSV600. The selected device identity did not match.',
        );
      const identity: DeviceIdentity = {
        id: wire.id,
        name: wire.name,
        serial,
        model: 'BSV600',
        commFirmware: (platform[5] ?? '').replaceAll('x', '.'),
      };
      this.update({ identity });
      // Subscribe to data first so a following control notification can never
      // announce a frame before the bulk channel is ready.
      await timeout(
        wire.subscribe(UUID.service, UUID.incoming, (bytes) => {
          if (this.wire === wire) this.frame.data(bytes);
        }),
        8000,
        'Could not subscribe to Joule status.',
      );
      await timeout(
        wire.subscribe(UUID.service, UUID.message, (bytes) => {
          if (this.wire === wire) this.messageReceived(bytes);
        }),
        8000,
        'Could not subscribe to Joule messages.',
      );
      await timeout(
        wire.subscribe(UUID.service, UUID.proximity, (bytes) => {
          if (this.wire === wire && bytes.length) this.proximityChanged(bytes[0]!);
        }),
        8000,
        'Could not subscribe to the physical button.',
      );
      this.proximityChanged(
        (
          await timeout(
            wire.read(UUID.service, UUID.proximity),
            8000,
            'Could not read button confirmation.',
          )
        )[0] ?? 0,
      );
      checked();
      // 1 = Wi-Fi AND Bluetooth reporting. This does not change Wi-Fi profiles.
      await this.setReportingMode(1);
      checked();
      this.update({
        phase: 'connected',
        error: null,
        message: 'Connected. Waiting for a temperature reading.',
      });
      await this.refresh();
      this.poll = setInterval(() => {
        if (this.snapshot.phase === 'connected')
          void this.refresh().catch((error) => this.update({ error: errorMessage(error) }));
      }, 5000);
    } catch (error) {
      if (this.wire === wire) this.lost(errorMessage(error));
      else if (opened) wire.disconnect();
      throw error;
    }
  }
  private lost(error: string | null) {
    ++this.epoch;
    ++this.commandEpoch;
    if (this.poll) clearInterval(this.poll);
    clearTimeout(this.proximityTimeout ?? undefined);
    clearTimeout(this.startDeadline ?? undefined);
    this.pendingStartUuid = null;
    this.releaseDeviceLock?.();
    this.releaseDeviceLock = null;
    this.poll = null;
    this.frame.reset();
    this.pendingMode?.reject(new Error('Bluetooth disconnected.'));
    this.pendingMode = null;
    this.queue?.close();
    this.queue = null;
    const wire = this.wire;
    this.wire = null;
    const owned = this.ownsTransport;
    this.ownsTransport = false;
    if (owned) wire?.disconnect();
    this.update({
      phase: error ? 'error' : 'disconnected',
      proximity: 0,
      command: null,
      error,
      message: null,
    });
  }
  async disconnect() {
    if (!this.wire || !this.ownsTransport) {
      this.lost(null);
      return;
    }
    if (this.pendingStartUuid) await this.stop().catch(() => {});
    // Finish any requested Stop before relinquishing the transport.
    if (this.stopTask) await this.stopTask.catch(() => {});
    try {
      if (this.snapshot.proximity === 1 && this.snapshot.identity)
        await this.write(
          UUID.proximity,
          encoder.encode(`${this.snapshot.identity.serial}:stop`),
          true,
        );
      await this.setReportingMode(0);
    } finally {
      this.lost(null);
    }
  }
  canDisconnectForDiagnosis(now = Date.now()): string | null {
    const { phase, status, command, error } = this.snapshot;
    if (phase === 'choosing' || phase === 'connecting')
      return 'Finish or cancel the kitchen connection before starting diagnosis.';
    if (phase !== 'connected') return null;
    if (command || this.pendingStartUuid || this.stopTask)
      return 'Wait for the kitchen command to finish before switching to diagnosis.';
    if (!status || now - status.at > 15000 || error)
      return 'Wait for a fresh idle reading in the kitchen before switching to diagnosis.';
    if (status.state !== 'idle')
      return 'Finish or stop the current cook in the kitchen before starting diagnosis.';
    return null;
  }
  async disconnectForDiagnosis() {
    const problem = this.canDisconnectForDiagnosis();
    if (problem) throw new Error(problem);
    await this.disconnect();
  }
  private async write(
    characteristic: string,
    bytes: Uint8Array,
    priority = false,
    commandEpoch?: number,
  ) {
    const wire = this.wire;
    const queue = this.queue;
    if (!wire || !queue) throw new Error('Connect to a Joule first.');
    await queue.add(async () => {
      if (commandEpoch !== undefined && commandEpoch !== this.commandEpoch) throw new Cancelled();
      await wire.write(UUID.service, characteristic, bytes);
    }, priority);
  }
  private send(message: unknown, priority = false, commandEpoch?: number) {
    return this.write(UUID.request, encode(message), priority, commandEpoch);
  }
  private async setReportingMode(mode: 0 | 1) {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const reply = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Attach the timeout before the write; mock and native replies can be immediate.
    const completion = timeout(reply, 6000, 'The Joule did not confirm Bluetooth reporting.');
    void completion.catch(() => {});
    this.pendingMode = { mode, resolve, reject };
    try {
      await this.send({ type: Message.ModeRequest, payload: { mode } });
      await completion;
    } finally {
      this.pendingMode = null;
    }
  }
  async refresh() {
    await this.send({ type: Message.ShadowRequest });
  }
  private messageReceived(bytes: Uint8Array) {
    let message;
    try {
      message = object(JSON.parse(decoder.decode(bytes)) as unknown);
    } catch {
      this.update({ error: 'An unreadable Bluetooth message was discarded.' });
      return;
    }
    if (!message) return;
    if (message.type === Message.Heartbeat) {
      this.update({ lastHeartbeat: Date.now() });
      void this.send({ type: Message.HeartbeatAck }, true).catch(() => {});
    } else if (message.type === Message.ModeReply) {
      if (this.pendingMode && message.mode === this.pendingMode.mode) {
        if (message.result === 0) this.pendingMode.resolve();
        else this.pendingMode.reject(new Error('The Joule rejected Bluetooth reporting.'));
      }
    } else if (message.type === Message.ShadowReply && message.result !== 0) {
      this.update({ error: 'The Joule rejected the status request.' });
    } else if (message.type === Message.TimeRequest) {
      // POSIX UTC is portable and avoids guessing an IANA→POSIX DST mapping.
      void this.send(
        { type: Message.TimeReply, payload: { time: Date.now() / 1000, timezone: 'UTC0' } },
        true,
      ).catch(() => {});
    } else this.frame.message(message);
  }
  private frameReceived(type: number, packet: unknown) {
    if (type !== Message.ShadowStart) return; // Timeline/variables are not temperature samples.
    const status = parseShadow(packet);
    if (!status) {
      this.update({ error: 'The Joule sent an unfamiliar status shape. Cooking is unavailable.' });
      return;
    }
    this.update({
      status,
      error: null,
      message: this.snapshot.command ? this.snapshot.message : null,
    });
    if (
      this.pendingStartUuid &&
      !this.stopWanted &&
      status.recipeUuid === this.pendingStartUuid &&
      status.state !== 'idle'
    ) {
      this.pendingStartUuid = null;
      clearTimeout(this.startDeadline ?? undefined);
      this.update({ command: null, message: 'The Joule reports the submitted cook.' });
    }
    for (const listener of this.statusListeners) listener(status);
    if (this.stopWanted) {
      if (status.state === 'idle') {
        this.update({ command: null, message: 'Joule reports idle.' });
      } else if (!this.stopTask && Date.now() - this.lastStopAt > 2000) {
        // If a late upload is observed after Stop, reassert Stop, never Start.
        void this.stop().catch((error) => this.update({ error: errorMessage(error) }));
      }
    }
  }
  private proximityChanged(value: number) {
    this.update({ proximity: value });
    if (value === 2) {
      clearTimeout(this.proximityTimeout ?? undefined);
      this.update({ message: 'Button confirmed. Cooking controls are ready.' });
    }
  }
  async requestControl() {
    const identity = this.snapshot.identity;
    if (!identity || this.snapshot.phase !== 'connected')
      throw new Error('Connect to the Joule first.');
    await this.write(UUID.proximity, encoder.encode(`${identity.serial}:connect`));
    this.update({ message: 'Press the Joule’s top button once to enable cooking controls.' });
    clearTimeout(this.proximityTimeout ?? undefined);
    this.proximityTimeout = setTimeout(() => {
      if (this.snapshot.proximity !== 2)
        this.update({
          error: 'Button confirmation timed out. Select Enable cooking to try again.',
        });
    }, 60000);
  }
  canStart(now = Date.now()): string | null {
    const { phase, status, proximity, command, kind, identity } = this.snapshot;
    if (phase !== 'connected' || !identity) return 'Connect to your Joule first.';
    if (!status || now - status.at > 15000) return 'Waiting for a fresh temperature reading.';
    if (this.pendingStartUuid)
      return 'The previous Start is not confirmed. Send Stop before trying another cook.';
    if (command) return 'A command is still pending.';
    if (this.snapshot.error) return 'Waiting for a valid Joule status update.';
    if (status.temperatureC === null) return 'Waiting for a valid bath temperature.';
    if (status.state !== 'idle') return 'Stop the current cook before starting another.';
    if (status.errors.length) return 'Resolve the Joule’s reported error before cooking.';
    if (proximity !== 2) return 'Enable cooking and confirm with the Joule’s top button.';
    if (
      kind !== 'mock' &&
      (identity.commFirmware !== '1.9.23' || status.firmware.teFirmware !== '2.5.2')
    )
      return 'Monitoring is available. Manual controls have only been checked against firmware 1.9.23 / 2.5.2.';
    return null;
  }
  async start(settings: ManualSettings) {
    const unavailable = this.canStart();
    if (unavailable) throw new Error(unavailable);
    const recipe = manualRecipe(settings);
    const bytes = encode(recipe);
    const generation = ++this.commandEpoch;
    this.pendingStartUuid = recipe.instructions.uuid;
    this.stopWanted = false;
    this.update({ command: 'starting', error: null, message: 'Sending the timed cook…' });
    try {
      await this.send({ type: Message.LoadStart, len: bytes.length }, false, generation);
      // 20-byte payloads work without an MTU negotiation API in Web Bluetooth.
      for (let offset = 0; offset < bytes.length; offset += 20)
        await this.write(UUID.outgoing, bytes.slice(offset, offset + 20), false, generation);
      await this.send({ type: Message.LoadEnd }, false, generation);
      if (generation === this.commandEpoch && this.pendingStartUuid) {
        this.update({ message: 'Cook submitted. Waiting for the Joule to report its state.' });
        this.startDeadline = setTimeout(() => {
          if (this.pendingStartUuid && generation === this.commandEpoch)
            this.update({
              command: null,
              error:
                'Start has not been confirmed. Check the Joule and send Stop before trying another cook.',
            });
        }, 10000);
      }
      await this.refresh();
    } catch (error) {
      if (error instanceof Cancelled) return;
      if (generation === this.commandEpoch)
        this.update({
          command: null,
          error: `${errorMessage(error)} Start was not retried. Check the Joule before continuing.`,
        });
      throw error;
    }
  }
  async stop(): Promise<void> {
    ++this.commandEpoch; // Invalidate queued and not-yet-queued recipe fragments now.
    this.pendingStartUuid = null;
    clearTimeout(this.startDeadline ?? undefined);
    this.stopWanted = true;
    if (this.stopTask) return this.stopTask;
    this.update({ command: 'stopping', error: null, message: 'Sending Stop…' });
    const task = (async () => {
      try {
        this.lastStopAt = Date.now();
        await this.send({ type: Message.Stop, payload: { reason: 1 } }, true);
        this.update({ message: 'Stop sent. Waiting for the Joule to report idle.' });
        await this.refresh();
      } catch (error) {
        this.update({
          command: null,
          error: `Stop could not be confirmed. Check the Joule; unplug it if it is still running. ${errorMessage(error)}`,
        });
        throw error;
      } finally {
        this.stopTask = null;
      }
    })();
    this.stopTask = task;
    return task;
  }
}
