import { encoder, UUID } from '../src/device/protocol.ts';
import type { GattWire } from '../src/device/wire.ts';

export type RecoveryScenario = 'broken' | 'correct' | 'different' | 'unsupported' | 'lost-ack';
export const DEMO_BROKER = 'example123-ats.iot.us-west-2.amazonaws.com';
const SERIAL = 'SIMULATED000002';

/** Persistent in-memory settings. No radio, network, account, or cook commands. */
export class RecoveryDemoGatt implements GattWire {
  readonly kind = 'mock' as const;
  readonly id = 'in-browser-recovery-demo';
  readonly name = 'Simulated recovery Joule';
  private connected = false;
  private disconnected: () => void = () => {};
  private address: Uint8Array;
  readonly writes: { service: string; characteristic: string; bytes: Uint8Array }[] = [];
  readonly reads: { service: string; characteristic: string }[] = [];
  constructor(private readonly scenario: RecoveryScenario = 'broken') {
    this.address =
      scenario === 'correct'
        ? encoder.encode(DEMO_BROKER)
        : new Uint8Array([scenario === 'different' ? 3 : 4]);
  }
  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
    this.disconnected();
  }
  onDisconnect(listener: () => void) {
    this.disconnected = listener;
  }
  async read(service: string, characteristic: string) {
    if (!this.connected) throw new Error('The simulated connection is closed.');
    this.reads.push({ service, characteristic });
    if (service === UUID.service && characteristic === UUID.serial) return encoder.encode(SERIAL);
    if (service === UUID.infoService && characteristic === UUID.platform)
      return encoder.encode(
        `APN3|A0|AZ|EX04|BSV600|${this.scenario === 'unsupported' ? '9x9x9' : '1x9x23'}|${SERIAL}`,
      );
    if (service === UUID.infoService && characteristic === UUID.broker)
      return encoder.encode(DEMO_BROKER);
    if (service === UUID.service && characteristic === UUID.serverAddress)
      return this.address.slice();
    if (service === UUID.networkService && characteristic === UUID.networkControl)
      return new Uint8Array([0]);
    throw new Error('Unexpected recovery read.');
  }
  async write(service: string, characteristic: string, bytes: Uint8Array) {
    if (!this.connected) throw new Error('The simulated connection is closed.');
    this.writes.push({ service, characteristic, bytes: bytes.slice() });
    if (service !== UUID.service || characteristic !== UUID.serverAddress)
      throw new Error('The recovery demo does not support other writes.');
    if (
      bytes.length !== DEMO_BROKER.length ||
      !bytes.every((value, index) => value === DEMO_BROKER.charCodeAt(index))
    )
      throw new Error('Expected one complete hostname, with no terminator or fragments.');
    this.address = bytes.slice();
    if (this.scenario === 'lost-ack') {
      this.disconnect();
      throw new Error('Simulated connection loss after the address was saved.');
    }
  }
  async subscribe(): Promise<void> {
    throw new Error('Recovery must not subscribe to application notifications.');
  }
}
