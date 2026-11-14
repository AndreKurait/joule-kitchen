import type { ConnectionKind } from '../types.ts';
import { errorMessage } from '../types.ts';
import { claimDeviceLock } from './lock.ts';
import { decoder, UUID } from './protocol.ts';
import type { GattWire } from './wire.ts';

export type RecoveryFinding = 'known-fault' | 'correct' | 'unsupported' | 'unrecognized';
export interface RecoveryDiagnosis {
  finding: RecoveryFinding;
  model: string;
  commFirmware: string;
  currentHex: string | null;
  currentHost: string | null;
  referenceHost: string | null;
  networkSetupIdle: boolean | null;
  explanation: string;
  checkedAt: number;
}
export interface RecoverySnapshot {
  phase:
    | 'ready'
    | 'choosing'
    | 'checking'
    | 'checked'
    | 'repairing'
    | 'repaired'
    | 'uncertain'
    | 'error';
  kind: ConnectionKind | null;
  diagnosis: RecoveryDiagnosis | null;
  verification: 'not-written' | 'unconfirmed' | 'readback-matched';
  rechecked: boolean;
  error: string | null;
}
interface Readings {
  serial: Uint8Array;
  platform: Uint8Array;
  broker: Uint8Array | null;
  address: Uint8Array | null;
  networkControl: Uint8Array | null;
  diagnosis: RecoveryDiagnosis;
}
const INITIAL: RecoverySnapshot = {
  phase: 'ready',
  kind: null,
  diagnosis: null,
  verification: 'not-written',
  rechecked: false,
  error: null,
};
const same = (a: Uint8Array | null, b: Uint8Array | null) =>
  a !== null && b !== null && a.length === b.length && a.every((value, i) => value === b[i]);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(' ');
const text = (bytes: Uint8Array) => decoder.decode(bytes).replace(/\0+$/, '');

/**
 * Only the observed BSV600 platform / comm firmware is eligible. Do not turn
 * this into a generic endpoint editor: other firmware may interpret ff07
 * differently. The broker must come from THIS device's read-only ff02.
 */
function supportedPlatform(parts: string[]) {
  return parts.slice(0, 6).join('|') === 'APN3|A0|AZ|EX04|BSV600|1x9x23';
}
function brokerHost(bytes: Uint8Array): string | null {
  try {
    const host = decoder.decode(bytes);
    // Exact ASCII bytes, with no port, path, whitespace, NUL or suffix trick.
    // Only the ATS broker form and region observed during this repair.
    const match = /^[a-z0-9]{1,59}-ats\.iot\.us-west-2\.amazonaws\.com$/.exec(host);
    return match?.[0] === host ? host : null;
  } catch {
    return null;
  }
}
type Operation = <T>(run: () => Promise<T>, message: string, ms?: number) => Promise<T>;

/**
 * Recovery never opens an application/reporting session and never subscribes,
 * sends cooking commands, provisions Wi-Fi, resets, or flashes firmware.
 * Each operation releases Bluetooth, including the read-only first check.
 */
export class ConnectionRecovery {
  private snapshot: RecoverySnapshot = { ...INITIAL };
  private listeners = new Set<() => void>();
  private selected: GattWire | null = null;
  private active: GattWire | null = null;
  private baseline: Readings | null = null;
  private plan: Readings | null = null;
  private epoch = 0;
  private closed = false;
  private busy = false;
  private releaseLock: (() => void) | null = null;
  private interrupt: ((error: Error) => void) | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(change: Partial<RecoverySnapshot>) {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  private available() {
    if (this.closed) throw new Error('Recovery was closed.');
    if (this.busy || this.snapshot.phase === 'choosing')
      throw new Error('Wait for the current Bluetooth check to finish.');
  }
  choosing() {
    this.available();
    this.plan = null;
    this.baseline = null;
    this.selected = null;
    this.update({ ...INITIAL, phase: 'choosing' });
  }
  selectionFailed(error: unknown) {
    const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
    this.update({
      phase: cancelled ? 'ready' : 'error',
      error: cancelled ? null : errorMessage(error),
    });
  }
  private closeTransport() {
    const wire = this.active;
    this.active = null;
    // Clear before disconnect, whose event may be delivered synchronously.
    try {
      wire?.disconnect();
    } finally {
      this.releaseLock?.();
      this.releaseLock = null;
    }
  }
  dispose() {
    this.closed = true;
    ++this.epoch;
    this.plan = null;
    this.baseline = null;
    this.interrupt?.(new Error('Recovery was closed.'));
    this.closeTransport();
  }
  private async withConnection<T>(wire: GattWire, run: (operation: Operation) => Promise<T>) {
    const epoch = ++this.epoch;
    const checked = () => {
      if (this.closed || epoch !== this.epoch) throw new Error('Recovery was cancelled.');
    };
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterrupted = reject;
    });
    // A disconnect between operations must not become an unhandled rejection.
    void interrupted.catch(() => {});
    this.interrupt = rejectInterrupted;
    const operation: Operation = async (work, message, ms = 8000) => {
      checked();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          work(),
          interrupted,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
          }),
        ]);
        checked();
        return result;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const release = await claimDeviceLock(wire);
      if (this.closed || epoch !== this.epoch) {
        release();
        checked();
      }
      this.releaseLock = release;
      checked();
      this.active = wire;
      wire.onDisconnect(() => {
        if (this.active === wire) {
          ++this.epoch;
          rejectInterrupted(new Error('Bluetooth disconnected during the check.'));
        }
      });
      await operation(
        () => {
          const opening = wire.connect();
          void opening.then(
            () => {
              if (this.active !== wire) wire.disconnect();
            },
            () => {},
          );
          return opening;
        },
        'Could not connect. Keep the Joule nearby and close Breville+ or other Bluetooth connections.',
        15000,
      );
      return await run(operation);
    } finally {
      this.interrupt = null;
      this.closeTransport();
    }
  }
  private async read(wire: GattWire, operation: Operation): Promise<Readings> {
    const read = (service: string, uuid: string) =>
      operation(() => wire.read(service, uuid), 'The Joule did not answer a settings read.');
    const serial = await read(UUID.service, UUID.serial);
    const platform = await read(UUID.infoService, UUID.platform);
    if (serial.length > 64 || platform.length > 192)
      throw new Error('The selected device returned an unfamiliar identity.');
    const identifier = text(serial);
    const parts = text(platform).split('|');
    if (!/^[A-Z0-9]{6,64}$/.test(identifier) || parts.length !== 7 || parts[6] !== identifier)
      throw new Error(
        'The Joule identity did not match. No repair is available for this connection.',
      );
    const diagnosis: RecoveryDiagnosis = {
      finding: 'unsupported',
      model: parts[4]!.slice(0, 30),
      commFirmware: parts[5]!.replaceAll('x', '.').slice(0, 30),
      currentHex: null,
      currentHost: null,
      referenceHost: null,
      networkSetupIdle: null,
      explanation:
        'The server-address check supports Joule Turbo BSV600, platform APN3/A0/AZ/EX04, with communication firmware 1.9.23. This device does not match, so its address was not checked.',
      checkedAt: Date.now(),
    };
    if (!supportedPlatform(parts))
      return { serial, platform, broker: null, address: null, networkControl: null, diagnosis };
    const broker = await read(UUID.infoService, UUID.broker);
    const address = await read(UUID.service, UUID.serverAddress);
    const networkControl = await read(UUID.networkService, UUID.networkControl);
    if (broker.length > 253 || address.length > 253)
      throw new Error('The Joule returned an unfamiliar server setting. No repair was attempted.');
    const referenceHost = brokerHost(broker);
    diagnosis.currentHex = hex(address);
    diagnosis.currentHost = brokerHost(address);
    diagnosis.referenceHost = referenceHost;
    diagnosis.networkSetupIdle = networkControl.length === 1 && networkControl[0] === 0;
    if (!referenceHost) {
      diagnosis.explanation =
        'The built-in server address is not in the verified format. There is no known replacement to offer.';
    } else if (same(broker, address)) {
      diagnosis.finding = 'correct';
      diagnosis.explanation =
        'The saved server address already matches the Joule’s built-in address. This particular fault is not present.';
    } else if (!diagnosis.networkSetupIdle) {
      diagnosis.explanation =
        'Network setup is active or returned an unfamiliar status. Close Breville+ and restart the Joule before a new check. No repair is offered during network setup.';
    } else if (address.length === 1 && address[0] === 4) {
      diagnosis.finding = 'known-fault';
      diagnosis.explanation =
        'The saved address is the invalid one-byte value 04. This is the same fault found on the recovered Joule.';
    } else {
      diagnosis.finding = 'unrecognized';
      diagnosis.explanation =
        'The saved address is different, but it does not match the verified fault. This tool will not replace it.';
    }
    return {
      serial: serial.slice(),
      platform: platform.slice(),
      broker: broker.slice(),
      address: address.slice(),
      networkControl: networkControl.slice(),
      diagnosis,
    };
  }
  async inspect(wire: GattWire) {
    // Called after the user-gesture chooser, or with an explicitly chosen demo.
    if (this.snapshot.phase === 'choosing') this.update({ phase: 'ready' });
    this.available();
    this.busy = true;
    this.selected = wire;
    this.plan = null;
    this.baseline = null;
    this.update({ ...INITIAL, phase: 'checking', kind: wire.kind });
    try {
      const readings = await this.withConnection(wire, (operation) => this.read(wire, operation));
      this.baseline = readings;
      this.plan = readings.diagnosis.finding === 'known-fault' ? readings : null;
      this.update({ phase: 'checked', diagnosis: readings.diagnosis });
    } catch (error) {
      this.update({ phase: 'error', error: errorMessage(error) });
    } finally {
      this.busy = false;
    }
  }
  async repair(idleConfirmed: boolean) {
    this.available();
    if (!idleConfirmed)
      throw new Error('Confirm that the Joule is not cooking before restoring its address.');
    const wire = this.selected;
    const baseline = this.plan;
    if (!wire || !baseline?.broker || this.snapshot.phase !== 'checked')
      throw new Error('Run a new check before reviewing a repair.');
    this.plan = null; // A repair is consumed, even if delivery later becomes uncertain.
    this.busy = true;
    let attempted = false;
    this.update({ phase: 'repairing', error: null, rechecked: false });
    try {
      await this.withConnection(wire, async (operation) => {
        const fresh = await this.read(wire, operation);
        if (
          !same(fresh.serial, baseline.serial) ||
          !same(fresh.platform, baseline.platform) ||
          !same(fresh.broker, baseline.broker) ||
          !same(fresh.address, baseline.address) ||
          !same(fresh.networkControl, baseline.networkControl) ||
          fresh.diagnosis.finding !== 'known-fault'
        )
          throw new Error(
            'The identity or settings changed after the check. Run a new check before reviewing a repair.',
          );
        await operation(() => {
          attempted = true; // Even a rejected/timed-out write may reach the appliance.
          // One complete acknowledged write. NEVER use recipe-style fragments
          // here, append NUL, write a numeric selector, or substitute a host.
          return wire.write(UUID.service, UUID.serverAddress, baseline.broker!.slice());
        }, 'The server-address write was not acknowledged.');
        const readback = await operation(
          () => wire.read(UUID.service, UUID.serverAddress),
          'The saved server address could not be read back.',
        );
        if (!same(readback, baseline.broker))
          throw new Error('The read-back address did not match the intended value.');
        this.update({
          diagnosis: {
            ...fresh.diagnosis,
            finding: 'correct',
            currentHex: hex(readback),
            currentHost: fresh.diagnosis.referenceHost,
            explanation: 'The complete built-in server address was read back after the write.',
            checkedAt: Date.now(),
          },
        });
      });
      this.update({ phase: 'repaired', verification: 'readback-matched' });
    } catch (error) {
      this.update({
        phase: attempted ? 'uncertain' : 'error',
        verification: attempted ? 'unconfirmed' : 'not-written',
        error: errorMessage(error),
      });
    } finally {
      this.busy = false;
    }
  }
  async recheck() {
    this.available();
    const wire = this.selected;
    const baseline = this.baseline;
    if (!wire || !baseline) throw new Error('Choose your Joule for a new check.');
    const afterWrite = this.snapshot.verification !== 'not-written';
    this.busy = true;
    this.plan = null;
    this.update({ phase: 'checking', error: null });
    try {
      const readings = await this.withConnection(wire, (operation) => this.read(wire, operation));
      if (
        !same(readings.serial, baseline.serial) ||
        !same(readings.platform, baseline.platform) ||
        (baseline.broker !== null && !same(readings.broker, baseline.broker))
      )
        throw new Error('The device information changed. Choose your Joule for a new check.');
      this.plan = readings.diagnosis.finding === 'known-fault' ? readings : null;
      const matched = readings.diagnosis.finding === 'correct';
      this.update({
        phase: afterWrite && matched ? 'repaired' : 'checked',
        diagnosis: readings.diagnosis,
        verification: afterWrite ? (matched ? 'readback-matched' : 'unconfirmed') : 'not-written',
        rechecked: true,
      });
    } catch (error) {
      this.update({
        phase: afterWrite ? 'uncertain' : 'error',
        verification: afterWrite ? 'unconfirmed' : 'not-written',
        error: errorMessage(error),
      });
    } finally {
      this.busy = false;
    }
  }
  /** Deliberately excludes serial, device ID/name, Wi-Fi, and account data. */
  report() {
    const { kind, phase, diagnosis, verification, rechecked } = this.snapshot;
    return {
      schema: 'joule-kitchen-recovery-v1',
      generatedAt: new Date().toISOString(),
      simulation: kind === 'mock',
      phase,
      diagnosis,
      verification,
      checkedOnNewConnection: rechecked,
      cloudConnectionVerified: false,
      browserRepairPhysicallyValidated: false,
    };
  }
}
