import { describe, expect, it, vi } from 'vitest';
import { BrowserGatt } from '../src/device/bluetooth.ts';
import { uuid } from '../src/uuid.ts';

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
});
