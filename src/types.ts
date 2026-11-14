export type ConnectionKind = 'bluetooth' | 'mock';
export type ConnectionPhase = 'disconnected' | 'choosing' | 'connecting' | 'connected' | 'error';
export type Unit = 'C' | 'F';

export interface DeviceIdentity {
  id: string;
  name: string;
  model: 'BSV600';
  commFirmware: string;
  /** Used only for the appliance's physical-button handshake. Never exported. */
  serial: string;
}

export interface JouleStatus {
  at: number;
  state: string;
  temperatureC: number | null;
  targetC: number | null;
  nativeMode: number | null;
  recipeUuid: string | null;
  remainingSeconds: number | null;
  firmware: { commFirmware?: string; teFirmware?: string };
  errors: string[];
}

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  kind: ConnectionKind | null;
  identity: DeviceIdentity | null;
  status: JouleStatus | null;
  proximity: number;
  lastHeartbeat: number | null;
  error: string | null;
  command: 'starting' | 'stopping' | null;
  message: string | null;
}

export interface Sample {
  id?: number;
  sessionId: string;
  at: number;
  temperatureC: number | null;
  targetC: number | null;
  state: string;
  nativeMode: number | null;
  recipeUuid: string | null;
  remainingSeconds: number | null;
  gapBefore: boolean;
}

export interface Recording {
  id: string;
  startedAt: number;
  endedAt: number | null;
  kind: ConnectionKind;
  label: string;
  sampleCount: number;
}

export interface ManualSettings {
  temperatureC: number;
  durationSeconds: number;
}

export function formatTemperature(value: number | null, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return (unit === 'F' ? (value * 9) / 5 + 32 : value).toFixed(1);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
