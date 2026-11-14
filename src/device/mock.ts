import { MockDevice, MOCK_NAME } from '../../mock/device.ts';
import type { MockAction } from '../../mock/device.ts';
import type { GattWire } from './wire.ts';

export interface MockWire extends GattWire {
  action(action: MockAction): Promise<void>;
}
export class DemoGatt implements MockWire {
  readonly kind = 'mock' as const;
  readonly id = 'in-browser-simulated-joule';
  readonly name = MOCK_NAME;
  readonly device = new MockDevice();
  async connect() {
    this.device.connect();
  }
  disconnect() {
    this.device.disconnect();
  }
  onDisconnect(listener: () => void) {
    this.device.onDisconnect(listener);
  }
  async read(service: string, uuid: string) {
    return this.device.read(service, uuid);
  }
  async write(service: string, uuid: string, bytes: Uint8Array) {
    await this.device.write(service, uuid, bytes);
  }
  async subscribe(service: string, uuid: string, listener: (bytes: Uint8Array) => void) {
    this.device.subscribe(service, uuid, listener);
  }
  async action(action: MockAction) {
    this.device.action(action);
  }
}

/** The Docker mock bridges GATT operations, not the app's high-level state. */
export class SocketMockGatt implements MockWire {
  readonly kind = 'mock' as const;
  readonly id = 'docker-simulated-joule';
  readonly name = `${MOCK_NAME} · Docker`;
  private socket: WebSocket | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (data: number[]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private subscriptions = new Map<string, (bytes: Uint8Array) => void>();
  private disconnected: () => void = () => {};
  async connect() {
    const url = new URL('./__mock/gatt', window.location.href);
    url.search = '';
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        characteristic?: string;
        bytes?: number[];
        error?: string;
      };
      if (message.characteristic && message.bytes)
        this.subscriptions.get(message.characteristic)?.(new Uint8Array(message.bytes));
      else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.bytes ?? []);
      }
    });
    socket.addEventListener('close', () => {
      this.pending.forEach((pending) => {
        clearTimeout(pending.timer);
        pending.reject(new Error('The Docker mock disconnected.'));
      });
      this.pending.clear();
      this.subscriptions.clear();
      this.socket = null;
      this.disconnected();
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () =>
          reject(
            new Error(
              'Could not reach the Docker mock. Start docker compose, then open its local URL.',
            ),
          ),
        { once: true },
      );
    });
  }
  private call(operation: string, data: Record<string, unknown> = {}): Promise<number[]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('The Docker mock is disconnected.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The Docker mock timed out.'));
      }, 7000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, operation, ...data }));
    });
  }
  onDisconnect(listener: () => void) {
    this.disconnected = listener;
  }
  disconnect() {
    this.socket?.close();
  }
  async read(service: string, characteristic: string) {
    return new Uint8Array(await this.call('read', { service, characteristic }));
  }
  async write(service: string, characteristic: string, value: Uint8Array) {
    await this.call('write', { service, characteristic, bytes: Array.from(value) });
  }
  async subscribe(service: string, characteristic: string, listener: (bytes: Uint8Array) => void) {
    this.subscriptions.set(characteristic, listener);
    await this.call('subscribe', { service, characteristic });
  }
  async action(action: MockAction) {
    await this.call('action', { action });
  }
}
