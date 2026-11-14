export interface GattWire {
  readonly id: string;
  readonly name: string;
  readonly kind: 'bluetooth' | 'mock';
  connect(): Promise<void>;
  disconnect(): void;
  read(service: string, characteristic: string): Promise<Uint8Array>;
  write(service: string, characteristic: string, value: Uint8Array): Promise<void>;
  subscribe(
    service: string,
    characteristic: string,
    listener: (value: Uint8Array) => void,
  ): Promise<void>;
  onDisconnect(listener: () => void): void;
}
