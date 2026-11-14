import { UUID } from './protocol.ts';
import type { GattWire } from './wire.ts';

export function bluetoothSupport(): string | null {
  if (!window.isSecureContext)
    return 'Bluetooth needs HTTPS or localhost. Open the GitHub Pages site over HTTPS.';
  if (!navigator.bluetooth)
    return 'Use Chrome or Edge on a computer, or Chrome on Android, for Bluetooth. Safari and Firefox do not provide Web Bluetooth.';
  return null;
}

export class BrowserGatt implements GattWire {
  readonly kind = 'bluetooth' as const;
  private characteristics = new Map<string, BluetoothRemoteGATTCharacteristic>();
  private subscriptions: (() => void)[] = [];
  private disconnected: () => void = () => {};
  private device: BluetoothDevice;
  private operations: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(device: BluetoothDevice) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.handleDisconnect);
  }
  get id() {
    return this.device.id;
  }
  get name() {
    return this.device.name || 'Joule Turbo';
  }
  static async choose(): Promise<BrowserGatt> {
    const problem = bluetoothSupport();
    if (problem) throw new Error(problem);
    // requestDevice must be invoked directly from the user's click.
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BSV600' }, { services: [UUID.advertisement] }],
      optionalServices: [UUID.service, UUID.infoService],
    });
    return new BrowserGatt(device);
  }
  static async remembered(): Promise<BrowserGatt[]> {
    if (!navigator.bluetooth?.getDevices) return [];
    const devices = await navigator.bluetooth.getDevices();
    return devices.map((device) => new BrowserGatt(device));
  }
  onDisconnect(listener: () => void) {
    this.disconnected = listener;
  }
  private handleDisconnect = () => {
    this.subscriptions.splice(0).forEach((remove) => remove());
    this.characteristics.clear();
    this.disconnected();
  };
  async connect() {
    if (!this.device.gatt) throw new Error('The selected device has no Bluetooth GATT server.');
    ++this.generation;
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    await this.device.gatt.connect();
  }
  disconnect() {
    ++this.generation;
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.device.gatt?.disconnect();
    this.handleDisconnect();
  }
  private operation<T>(run: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = this.operations.then(() => {
      if (generation !== this.generation)
        throw new Error('Bluetooth operation cancelled by disconnect.');
      return run();
    });
    this.operations = result.catch(() => {});
    return result;
  }
  private async characteristic(service: string, uuid: string) {
    const existing = this.characteristics.get(uuid);
    if (existing) return existing;
    if (!this.device.gatt?.connected) throw new Error('Bluetooth disconnected.');
    const parent = await this.device.gatt.getPrimaryService(service);
    const characteristic = await parent.getCharacteristic(uuid);
    this.characteristics.set(uuid, characteristic);
    return characteristic;
  }
  async read(service: string, uuid: string) {
    return this.operation(async () => {
      const value = await (await this.characteristic(service, uuid)).readValue();
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    });
  }
  async write(service: string, uuid: string, bytes: Uint8Array) {
    await this.operation(async () => {
      const characteristic = await this.characteristic(service, uuid);
      if (!characteristic.properties.write)
        throw new Error('The selected Joule does not support acknowledged writes.');
      await characteristic.writeValueWithResponse(bytes.slice().buffer);
    });
  }
  async subscribe(service: string, uuid: string, listener: (value: Uint8Array) => void) {
    await this.operation(async () => {
      const characteristic = await this.characteristic(service, uuid);
      const changed = () => {
        const value = characteristic.value;
        if (value)
          listener(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      };
      characteristic.addEventListener('characteristicvaluechanged', changed);
      this.subscriptions.push(() =>
        characteristic.removeEventListener('characteristicvaluechanged', changed),
      );
      await characteristic.startNotifications();
    });
  }
}
