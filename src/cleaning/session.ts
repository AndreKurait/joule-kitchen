import type { ConnectionKind, ConnectionSnapshot, ManualSettings } from '../types.ts';

/** The extended 20–30 minute bath in the manufacturer's cleaning guide. */
export const CLEANING_SETTINGS: Readonly<ManualSettings> = Object.freeze({
  temperatureC: 60,
  durationSeconds: 30 * 60,
});

export interface CleaningRun {
  uuid: string;
  deviceId: string;
  kind: ConnectionKind;
  startedAt: number;
  seenRunning: boolean;
  peakTemperatureC: number | null;
  stoppedAt: number | null;
  interrupted: boolean;
  stopRequested: boolean;
}

export function hasCleaningReading(
  run: CleaningRun,
  state: ConnectionSnapshot,
  now = Date.now(),
): boolean {
  return (
    state.phase === 'connected' &&
    state.identity?.id === run.deviceId &&
    state.kind === run.kind &&
    !!state.status &&
    state.status.at >= run.startedAt &&
    now - state.status.at <= 15000 &&
    !state.error &&
    !state.status.errors.length
  );
}

/** Observation only: elapsed browser time can never declare the appliance stopped. */
export function observeCleaning(
  run: CleaningRun,
  state: ConnectionSnapshot,
  now = Date.now(),
): CleaningRun {
  if (run.interrupted || !hasCleaningReading(run, state, now)) return run;
  const status = state.status!;
  if (status.state !== 'idle' && status.recipeUuid !== run.uuid)
    return { ...run, interrupted: true };
  if (run.stoppedAt !== null) return run;
  if (status.recipeUuid === run.uuid && status.state !== 'idle') {
    const temperature = status.temperatureC;
    const peak =
      temperature !== null && Number.isFinite(temperature)
        ? Math.max(run.peakTemperatureC ?? temperature, temperature)
        : run.peakTemperatureC;
    if (run.seenRunning && peak === run.peakTemperatureC) return run;
    return { ...run, seenRunning: true, peakTemperatureC: peak };
  }
  if ((run.seenRunning || run.stopRequested) && status.state === 'idle' && !state.command)
    return { ...run, stoppedAt: status.at };
  return run;
}
