import { describe, expect, it, vi } from 'vitest';
import { BrowserGatt } from '../src/device/bluetooth.ts';
import { uuid } from '../src/uuid.ts';
import { ConnectionRecovery } from '../src/device/recovery.ts';
import { encoder, UUID } from '../src/device/protocol.ts';

describe('browser compatibility and remembered connections', () => {
  it('produces valid, unique v4 identifiers when HTTP does not expose randomUUID', () => {
    const source = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const identifiers = Array.from({ length: 100 }, () => uuid(source));
    expect(new Set(identifiers).size).toBe(100);
    for (const id of identifiers)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('receives native disconnect events after reconnecting the same remembered device', async () => {
    const device = new EventTarget() as EventTarget & {
      id: string;
      name: string;
      gatt: { connected: boolean; connect: () => Promise<void>; disconnect: () => void };
    };
    device.id = 'synthetic-remembered-device';
    device.name = 'Simulated remembered device';
    device.gatt = {
      connected: false,
      async connect() {
        this.connected = true;
      },
      disconnect() {
        this.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      },
    };
    const wire = new BrowserGatt(device as unknown as BluetoothDevice);
    const disconnected = vi.fn();
    wire.onDisconnect(disconnected);
    await wire.connect();
    wire.disconnect();
    expect(disconnected).toHaveBeenCalledTimes(1);
    await wire.connect();
    device.gatt.disconnect();
    expect(disconnected).toHaveBeenCalledTimes(2);
  });
  it('restores this peripheral’s own hostname in one acknowledged browser write, never 20-byte fragments', async () => {
    const host = 'seconddevice-ats.iot.us-west-2.amazonaws.com';
    let address = new Uint8Array([4]);
    const writes: { uuid: string; bytes: Uint8Array }[] = [];
    const device = new EventTarget() as EventTarget & {
      id: string;
      name: string;
      gatt: {
        connected: boolean;
        connect: () => Promise<void>;
        disconnect: () => void;
        getPrimaryService: (uuid: string) => Promise<unknown>;
      };
    };
    device.id = 'synthetic-recovery-peripheral';
    device.name = 'BSV600 simulated browser peripheral';
    device.gatt = {
      connected: false,
      async connect() {
        this.connected = true;
      },
      disconnect() {
        this.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      },
      async getPrimaryService(service: string) {
        return {
          async getCharacteristic(characteristic: string) {
            return {
              properties: { write: characteristic === UUID.serverAddress },
              async readValue() {
                let bytes: Uint8Array;
                if (service === UUID.service && characteristic === UUID.serial)
                  bytes = encoder.encode('SIMULATED000003');
                else if (service === UUID.infoService && characteristic === UUID.platform)
                  bytes = encoder.encode('APN3|A0|AZ|EX04|BSV600|1x9x23|SIMULATED000003');
                else if (service === UUID.infoService && characteristic === UUID.broker)
                  bytes = encoder.encode(host);
                else if (service === UUID.service && characteristic === UUID.serverAddress)
                  bytes = address;
                else if (service === UUID.networkService && characteristic === UUID.networkControl)
                  bytes = new Uint8Array([0]);
                else throw new Error('Unexpected characteristic');
                return new DataView(bytes.slice().buffer);
              },
              async writeValueWithResponse(value: ArrayBuffer) {
                expect(service).toBe(UUID.service);
                writes.push({ uuid: characteristic, bytes: new Uint8Array(value).slice() });
                address = new Uint8Array(value).slice();
              },
            };
          },
        };
      },
    };
    const recovery = new ConnectionRecovery();
    const wire = new BrowserGatt(device as unknown as BluetoothDevice);
    try {
      await recovery.inspect(wire);
      expect(writes).toEqual([]);
      expect(device.gatt.connected).toBe(false);
      await recovery.repair(true);
      expect(writes).toEqual([{ uuid: UUID.serverAddress, bytes: encoder.encode(host) }]);
      expect(recovery.getSnapshot().verification).toBe('readback-matched');
      await recovery.recheck();
      expect(writes).toHaveLength(1);
      expect(device.gatt.connected).toBe(false);
    } finally {
      recovery.dispose();
    }
  });
});
