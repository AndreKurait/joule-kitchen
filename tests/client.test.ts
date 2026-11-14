import { afterEach, describe, expect, it } from 'vitest';
import { DemoGatt } from '../src/device/mock.ts';
import { JouleClient } from '../src/device/client.ts';
import { decoder, Message, UUID } from '../src/device/protocol.ts';

const clients: JouleClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.disconnect().catch(() => {})));
});
async function connected() {
  const client = new JouleClient(),
    wire = new DemoGatt();
  clients.push(client);
  await client.connect(wire);
  return { client, wire };
}
describe('command lifecycle against independent simulated appliance', () => {
  it('pairing requests status without starting a cook, and requires physical confirmation', async () => {
    const { client, wire } = await connected();
    expect(client.getSnapshot().status).toMatchObject({ state: 'idle', temperatureC: 22 });
    expect(client.canStart()).toContain('button');
    await expect(client.start({ temperatureC: 55, durationSeconds: 10 })).rejects.toThrow();
    expect(wire.device.commands.some((command) => command.type === Message.LoadStart)).toBe(false);
  });
  it('starts a finite manual program and confirms Stop from the resulting shadow', async () => {
    const { client, wire } = await connected();
    await client.requestControl();
    await wire.action('button');
    await client.start({ temperatureC: 30, durationSeconds: 10 });
    expect(client.getSnapshot().status).toMatchObject({
      state: 'cooking',
      targetC: 30,
      nativeMode: 23,
    });
    await client.stop();
    expect(client.getSnapshot().status).toMatchObject({ state: 'idle', targetC: null });
    expect(client.getSnapshot().command).toBeNull();
  });
  it('Stop interrupts a slow upload without allowing a trailing commit', async () => {
    const { client, wire } = await connected();
    await client.requestControl();
    await wire.action('button');
    await wire.action('slow-upload');
    const start = client.start({ temperatureC: 30, durationSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.stop();
    await start;
    expect(wire.device.commands.filter((command) => command.type === Message.LoadEnd)).toEqual([]);
    expect(client.getSnapshot().status?.state).toBe('idle');
  });
  it('records no fabricated updates on connection loss and never retries Start on reconnect', async () => {
    const { client, wire } = await connected();
    const before = client.getSnapshot().status!.at;
    await wire.action('disconnect');
    expect(client.getSnapshot().phase).toBe('error');
    expect(client.getSnapshot().status!.at).toBe(before);
    const next = new DemoGatt();
    await client.connect(next);
    expect(next.device.commands.some((command) => command.type === Message.LoadStart)).toBe(false);
  });
  it('refuses cooking with a stale last reading even when GATT remains connected', async () => {
    const { client, wire } = await connected();
    await client.requestControl();
    await wire.action('button');
    expect(client.canStart(client.getSnapshot().status!.at + 16000)).toContain('fresh');
  });
  it('rejects Start after a malformed frame until a complete valid snapshot arrives', async () => {
    const { client, wire } = await connected();
    await client.requestControl();
    await wire.action('button');
    await wire.action('malformed');
    expect(client.canStart()).toContain('valid Joule status');
    await expect(client.start({ temperatureC: 30, durationSeconds: 10 })).rejects.toThrow();
    await wire.action('resume');
    expect(client.canStart()).toBeNull();
  });
  it('rejects Start without a measured temperature and still allows Stop', async () => {
    const { client, wire } = await connected();
    await client.requestControl();
    await wire.action('button');
    await wire.action('sensor-fault');
    expect(client.getSnapshot().status?.temperatureC).toBeNull();
    expect(client.canStart()).toContain('valid bath temperature');
    await expect(client.start({ temperatureC: 30, durationSeconds: 10 })).rejects.toThrow();
    await client.stop();
    expect(client.getSnapshot().status?.state).toBe('idle');
    await wire.action('resume');
    expect(client.canStart()).toBeNull();
  });
  it('a GATT commit acknowledgement without a matching cook shadow cannot enable a second Start', async () => {
    class AcknowledgedOnlyGatt extends DemoGatt {
      override async write(service: string, characteristic: string, bytes: Uint8Array) {
        if (
          characteristic === UUID.request &&
          JSON.parse(decoder.decode(bytes)).type === Message.LoadEnd
        )
          return;
        return super.write(service, characteristic, bytes);
      }
    }
    const client = new JouleClient(),
      wire = new AcknowledgedOnlyGatt();
    clients.push(client);
    await client.connect(wire);
    await client.requestControl();
    await wire.action('button');
    await client.start({ temperatureC: 30, durationSeconds: 10 });
    expect(client.getSnapshot().status?.state).toBe('idle');
    expect(client.canStart()).toContain('not confirmed');
    await expect(client.start({ temperatureC: 30, durationSeconds: 10 })).rejects.toThrow();
    await client.stop();
    expect(client.canStart()).toBeNull();
  });
});
