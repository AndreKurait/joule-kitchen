import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryDemoGatt, DEMO_BROKER } from '../mock/recovery.ts';
import type { RecoveryScenario } from '../mock/recovery.ts';
import { ConnectionRecovery } from '../src/device/recovery.ts';
import { JouleClient } from '../src/device/client.ts';
import { DemoGatt } from '../src/device/mock.ts';
import { claimDeviceLock } from '../src/device/lock.ts';
import { encoder, UUID } from '../src/device/protocol.ts';
import type { GattWire } from '../src/device/wire.ts';

const recoveries: ConnectionRecovery[] = [];
afterEach(() => {
  recoveries.splice(0).forEach((recovery) => recovery.dispose());
  vi.useRealTimers();
});
function recovery() {
  const result = new ConnectionRecovery();
  recoveries.push(result);
  return result;
}
async function inspect(scenario: RecoveryScenario = 'broken') {
  const client = recovery();
  const wire = new RecoveryDemoGatt(scenario);
  await client.inspect(wire);
  return { client, wire };
}
class AlteredReads extends RecoveryDemoGatt {
  overrides = new Map<string, Uint8Array>();
  override async read(service: string, characteristic: string) {
    const bytes = await super.read(service, characteristic);
    return this.overrides.get(characteristic)?.slice() ?? bytes;
  }
}

describe('read-only diagnosis and exact observed scope', () => {
  it('finds the known fault using only settings reads, then closes Bluetooth', async () => {
    const { client, wire } = await inspect();
    expect(client.getSnapshot()).toMatchObject({
      phase: 'checked',
      verification: 'not-written',
      diagnosis: { finding: 'known-fault', currentHex: '04', referenceHost: DEMO_BROKER },
    });
    expect(wire.reads).toEqual([
      { service: UUID.service, characteristic: UUID.serial },
      { service: UUID.infoService, characteristic: UUID.platform },
      { service: UUID.infoService, characteristic: UUID.broker },
      { service: UUID.service, characteristic: UUID.serverAddress },
      { service: UUID.networkService, characteristic: UUID.networkControl },
    ]);
    expect(wire.writes).toEqual([]);
    await expect(wire.read(UUID.service, UUID.serial)).rejects.toThrow('closed');
  });
  it.each([
    ['correct', 'correct'],
    ['different', 'unrecognized'],
    ['unsupported', 'unsupported'],
  ] as const)('offers no repair for %s settings', async (scenario, finding) => {
    const { client, wire } = await inspect(scenario);
    expect(client.getSnapshot().diagnosis?.finding).toBe(finding);
    await expect(client.repair(true)).rejects.toThrow('new check');
    expect(wire.writes).toEqual([]);
    if (scenario === 'unsupported') expect(wire.reads).toHaveLength(2);
  });
  it.each([
    'APN3|A0|AZ|EX04|BSV600|1x9x23|ANOTHER000001',
    'APN3|A0|AZ|EX04|BSV500|1x9x23|SIMULATED000002',
    'APN3|A1|AZ|EX04|BSV600|1x9x23|SIMULATED000002',
    'APN3|A0|AZ|EX04|BSV600|1x9x23|SIMULATED000002|extra',
  ])('refuses a mismatched identity or unverified platform: %s', async (platform) => {
    const client = recovery();
    const wire = new AlteredReads();
    wire.overrides.set(UUID.platform, encoder.encode(platform));
    await client.inspect(wire);
    expect(client.getSnapshot().diagnosis?.finding).not.toBe('known-fault');
    await expect(client.repair(true)).rejects.toThrow();
    expect(wire.writes).toEqual([]);
    expect(wire.reads).toHaveLength(2);
  });
  it.each([
    DEMO_BROKER + '\n',
    DEMO_BROKER + '\0',
    ' ' + DEMO_BROKER,
    'https://' + DEMO_BROKER,
    DEMO_BROKER + ':8883',
    DEMO_BROKER + '.unrelated.example',
    DEMO_BROKER.replace('us-west-2', 'eu-west-1'),
    'x'.repeat(60) + '-ats.iot.us-west-2.amazonaws.com',
    '',
  ])('rejects an unverified broker rather than normalizing it: %j', async (host) => {
    const client = recovery();
    const wire = new AlteredReads();
    wire.overrides.set(UUID.broker, encoder.encode(host));
    await client.inspect(wire);
    expect(client.getSnapshot().diagnosis).toMatchObject({
      finding: 'unsupported',
      referenceHost: null,
    });
    await expect(client.repair(true)).rejects.toThrow();
    expect(wire.writes).toEqual([]);
  });
  it('rejects invalid UTF-8 in the reference hostname', async () => {
    const client = recovery();
    const wire = new AlteredReads();
    wire.overrides.set(UUID.broker, new Uint8Array([0xff, 0xfe]));
    await client.inspect(wire);
    expect(client.getSnapshot().diagnosis?.finding).toBe('unsupported');
    await expect(client.repair(true)).rejects.toThrow();
    expect(wire.writes).toEqual([]);
  });
  it('refuses to change an address while network setup is active', async () => {
    const client = recovery();
    const wire = new AlteredReads();
    wire.overrides.set(UUID.networkControl, new Uint8Array([1]));
    await client.inspect(wire);
    expect(client.getSnapshot().diagnosis).toMatchObject({
      finding: 'unsupported',
      networkSetupIdle: false,
    });
    await expect(client.repair(true)).rejects.toThrow();
    expect(wire.writes).toEqual([]);
  });
  it('does not treat other empty, multi-byte, or numeric settings as the verified fault', async () => {
    for (const bytes of [[], [0], [3], [4, 0], [0x30, 0x34]]) {
      const client = recovery();
      const wire = new AlteredReads();
      wire.overrides.set(UUID.serverAddress, new Uint8Array(bytes));
      await client.inspect(wire);
      expect(client.getSnapshot().diagnosis?.finding).toBe('unrecognized');
      await expect(client.repair(true)).rejects.toThrow();
      expect(wire.writes).toEqual([]);
    }
  });
});

describe('reviewed repair, verification, and delivery uncertainty', () => {
  it('requires idle confirmation, re-reads the baseline, writes the full hostname once and reads it back', async () => {
    const { client, wire } = await inspect();
    await expect(client.repair(false)).rejects.toThrow('not cooking');
    expect(wire.writes).toEqual([]);
    await client.repair(true);
    expect(wire.reads).toHaveLength(11); // five diagnosis + five preflight + one readback
    expect(wire.writes).toEqual([
      {
        service: UUID.service,
        characteristic: UUID.serverAddress,
        bytes: encoder.encode(DEMO_BROKER),
      },
    ]);
    expect(client.getSnapshot()).toMatchObject({
      phase: 'repaired',
      verification: 'readback-matched',
      rechecked: false,
      diagnosis: { currentHost: DEMO_BROKER },
    });
    await expect(client.repair(true)).rejects.toThrow('new check');
    await expect(wire.read(UUID.service, UUID.serial)).rejects.toThrow('closed');
    await client.recheck();
    expect(client.getSnapshot()).toMatchObject({ phase: 'repaired', rechecked: true });
    expect(wire.writes).toHaveLength(1);
    expect(client.report().cloudConnectionVerified).toBe(false);
  });
  it.each([UUID.serial, UUID.platform, UUID.broker, UUID.serverAddress, UUID.networkControl])(
    'refuses a repair if %s changes between diagnosis and commit',
    async (characteristic) => {
      const client = recovery();
      const wire = new AlteredReads();
      await client.inspect(wire);
      wire.overrides.set(characteristic, encoder.encode('CHANGED'));
      await client.repair(true);
      expect(client.getSnapshot().phase).toBe('error');
      expect(client.getSnapshot().verification).toBe('not-written');
      expect(wire.writes).toEqual([]);
      await expect(client.repair(true)).rejects.toThrow('new check');
    },
  );
  it('detects a changed but still valid reference hostname before writing', async () => {
    const client = recovery();
    const wire = new AlteredReads();
    await client.inspect(wire);
    wire.overrides.set(UUID.broker, encoder.encode('different123-ats.iot.us-west-2.amazonaws.com'));
    await client.repair(true);
    expect(client.getSnapshot()).toMatchObject({ phase: 'error', verification: 'not-written' });
    expect(wire.writes).toEqual([]);
  });
  it('reads after a lost acknowledgement without retrying or restoring the malformed address', async () => {
    const { client, wire } = await inspect('lost-ack');
    await client.repair(true);
    expect(client.getSnapshot()).toMatchObject({ phase: 'uncertain', verification: 'unconfirmed' });
    expect(wire.writes).toHaveLength(1);
    await expect(client.repair(true)).rejects.toThrow('new check');
    await client.recheck();
    expect(client.getSnapshot()).toMatchObject({
      phase: 'repaired',
      verification: 'readback-matched',
      rechecked: true,
    });
    expect(wire.writes).toHaveLength(1);
    expect(client.report().cloudConnectionVerified).toBe(false);
  });
  it('a transport acknowledgement with the wrong readback cannot claim success', async () => {
    class DiscardedWrite extends RecoveryDemoGatt {
      override async read(service: string, characteristic: string) {
        const bytes = await super.read(service, characteristic);
        return characteristic === UUID.serverAddress ? new Uint8Array([4]) : bytes;
      }
    }
    const client = recovery();
    const wire = new DiscardedWrite();
    await client.inspect(wire);
    await client.repair(true);
    expect(client.getSnapshot()).toMatchObject({ phase: 'uncertain', verification: 'unconfirmed' });
    expect(wire.writes).toHaveLength(1);
    await client.recheck();
    expect(client.getSnapshot()).toMatchObject({
      phase: 'checked',
      diagnosis: { finding: 'known-fault' },
      verification: 'unconfirmed',
    });
    // A new explicit review could retry now; the recheck itself never does.
    expect(wire.writes).toHaveLength(1);
  });
  it('bounds a hanging write and does not replay it on timeout', async () => {
    vi.useFakeTimers();
    class HungWrite extends RecoveryDemoGatt {
      override async write(service: string, characteristic: string, bytes: Uint8Array) {
        await super.write(service, characteristic, bytes);
        await new Promise(() => {});
      }
    }
    const client = recovery();
    const wire = new HungWrite();
    await client.inspect(wire);
    const pending = client.repair(true);
    await vi.advanceTimersByTimeAsync(8001);
    await pending;
    expect(client.getSnapshot()).toMatchObject({ phase: 'uncertain', verification: 'unconfirmed' });
    await client.recheck();
    expect(client.getSnapshot().phase).toBe('repaired');
    expect(wire.writes).toHaveLength(1);
  });
  it('cancels delayed preflight work before it can write and rejects overlapping operations', async () => {
    let resume!: () => void;
    class DelayedRead extends RecoveryDemoGatt {
      delay = false;
      override async read(service: string, characteristic: string) {
        const bytes = await super.read(service, characteristic);
        if (this.delay && characteristic === UUID.serverAddress)
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        return bytes;
      }
    }
    const client = recovery();
    const wire = new DelayedRead();
    await client.inspect(wire);
    wire.delay = true;
    const pending = client.repair(true);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    await expect(client.repair(true)).rejects.toThrow('finish');
    client.dispose();
    resume();
    await pending;
    expect(wire.writes).toEqual([]);
  });
  it('never exports identity, app credentials or claims a cloud repair', async () => {
    const { client } = await inspect();
    await client.repair(true);
    const report = client.report();
    expect(report).toMatchObject({
      simulation: true,
      cloudConnectionVerified: false,
      browserRepairPhysicallyValidated: false,
      verification: 'readback-matched',
    });
    expect(JSON.stringify(report)).not.toMatch(
      /SIMULATED000002|in-browser-recovery-demo|serial|password|token/i,
    );
  });
});

describe('shared monitoring / recovery ownership', () => {
  it('cannot take a device already held by another connection and releases it afterward', async () => {
    const wire = new RecoveryDemoGatt();
    const native = Object.create(wire) as GattWire;
    Object.defineProperty(native, 'kind', { value: 'bluetooth' });
    const release = await claimDeviceLock(native);
    const client = recovery();
    try {
      await client.inspect(native);
      expect(client.getSnapshot().error).toContain('another connection');
      expect(wire.reads).toEqual([]);
      expect(wire.writes).toEqual([]);
    } finally {
      release();
    }
    await client.inspect(native);
    expect(client.getSnapshot().diagnosis?.finding).toBe('known-fault');
    const releaseAgain = await claimDeviceLock(native);
    releaseAgain();
  });
  it('uses the same lock name as the normal Joule client', async () => {
    class NativeFixture extends DemoGatt {
      constructor() {
        super();
        Object.defineProperty(this, 'kind', { value: 'bluetooth' });
      }
    }
    const wire = new NativeFixture();
    const monitor = new JouleClient();
    await monitor.connect(wire);
    try {
      const repair = recovery();
      await repair.inspect(wire);
      expect(repair.getSnapshot().error).toContain('another connection');
      expect(monitor.getSnapshot().phase).toBe('connected');
    } finally {
      await monitor.disconnect();
    }
    const release = await claimDeviceLock(wire);
    release();
  });
  it('a rejected normal connection cannot disconnect or replace the recovery owner', async () => {
    let resume!: () => void;
    class PausedNativeFixture extends RecoveryDemoGatt {
      constructor() {
        super();
        Object.defineProperty(this, 'kind', { value: 'bluetooth' });
      }
      override async read(service: string, characteristic: string) {
        if (characteristic === UUID.serverAddress)
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        return super.read(service, characteristic);
      }
    }
    const wire = new PausedNativeFixture();
    const repair = recovery();
    const pending = repair.inspect(wire);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    const monitor = new JouleClient();
    try {
      await expect(monitor.connect(wire)).rejects.toThrow('another connection');
      resume();
      await pending;
      expect(repair.getSnapshot()).toMatchObject({
        phase: 'checked',
        diagnosis: { finding: 'known-fault' },
      });
      expect(wire.writes).toEqual([]);
    } finally {
      resume();
      await monitor.disconnect();
    }
  });
});
