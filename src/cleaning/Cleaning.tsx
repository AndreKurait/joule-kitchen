import { useEffect, useRef, useState } from 'react';
import type { JouleClient } from '../device/client.ts';
import type { ConnectionSnapshot, Unit } from '../types.ts';
import { errorMessage, formatTemperature } from '../types.ts';
import { CLEANING_SETTINGS, hasCleaningReading, observeCleaning } from './session.ts';
import type { CleaningRun } from './session.ts';

const GUIDE = 'https://support.chefsteps.com/hc/en-us/articles/214090878-How-do-I-clean-Joule';
const MANUAL = 'https://assets.breville.com/BSV600/BSV600_USCM_SG3_D24_LR.pdf#page=36';

export function CleaningSection({
  client,
  state,
  unit,
  now,
  pressSimulatedButton,
}: {
  client: JouleClient;
  state: ConnectionSnapshot;
  unit: Unit;
  now: number;
  pressSimulatedButton: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [rinsed, setRinsed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<CleaningRun | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const connected = state.phase === 'connected';
  const simulation = state.kind === 'mock';
  const unavailable = client.canStart(now);
  const target = `${formatTemperature(CLEANING_SETTINGS.temperatureC, unit)}°${unit}`;
  const fresh = run !== null && hasCleaningReading(run, state, now);
  const ownsRunning =
    fresh && state.status?.recipeUuid === run?.uuid && state.status?.state !== 'idle';
  const stopped = !!run && run.stoppedAt !== null && !run.interrupted;
  const remaining = ownsRunning ? state.status?.remainingSeconds : null;
  const countdown =
    remaining === null || remaining === undefined
      ? '—'
      : `${Math.floor(remaining / 60)}:${Math.floor(remaining % 60)
          .toString()
          .padStart(2, '0')}`;

  useEffect(() => {
    if (open) {
      setPrepared(false);
      setRinsed(false);
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);

  useEffect(() => {
    setRun((current) => (current ? observeCleaning(current, state, now) : current));
  }, [state, now]);

  async function act(operation: () => Promise<unknown>) {
    setError(null);
    try {
      await operation();
    } catch (problem) {
      setError(errorMessage(problem));
    }
  }

  async function start() {
    if (!prepared || working) return;
    const { identity, kind } = client.getSnapshot();
    if (!identity || !kind) return;
    setWorking(true);
    setPrepared(false);
    setError(null);
    const startedAt = Date.now();
    try {
      const uuid = await client.start(CLEANING_SETTINGS);
      if (!uuid)
        throw new Error('Cleaning Start was cancelled. Check the Joule before continuing.');
      setRun(
        observeCleaning(
          {
            uuid,
            deviceId: identity.id,
            kind,
            startedAt,
            seenRunning: false,
            peakTemperatureC: null,
            stoppedAt: null,
            interrupted: false,
            stopRequested: false,
          },
          client.getSnapshot(),
        ),
      );
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setWorking(false);
    }
  }

  function returnToKitchen() {
    setOpen(false);
    document.getElementById('bath')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function stop() {
    setRun((current) => (current ? { ...current, stopRequested: true } : current));
    await act(() => client.stop());
  }

  return (
    <section id="cleaning" className="card cleaning-section" aria-labelledby="cleaning-title">
      <div>
        <p className="eyebrow">CARE FOR YOUR JOULE</p>
        <h2 id="cleaning-title">A fresh start for the next bath.</h2>
        <p>A guided vinegar bath for mineral buildup, followed by a cool-down and rinse.</p>
        <div className="cleaning-facts" aria-label="Cleaning cycle settings">
          <span>½ water + ½ white vinegar</span>
          <span>{target}</span>
          <span>30 minutes</span>
        </div>
      </div>
      <div className="cleaning-entry">
        <button
          className="button secondary"
          onClick={() => {
            if (!run && !working) setReviewing(false);
            setError(null);
            setOpen(true);
          }}
        >
          {run || working ? 'View cleaning cycle' : 'Clean Joule'}
          <span aria-hidden="true">↗</span>
        </button>
        <p>
          {run
            ? stopped
              ? 'The cycle ended. Finish with a rinse.'
              : 'Open the guide for the latest status.'
            : 'Prepare first. Start when you’re ready.'}
        </p>
      </div>

      <dialog
        ref={dialog}
        className="modal cleaning-modal"
        aria-labelledby="cleaning-dialog-title"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <div className="modal-heading">
          <span className="eyebrow">{simulation ? 'SIMULATED CLEANING' : 'JOULE CARE'}</span>
          <button
            className="icon-button"
            aria-label="Close cleaning guide"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <h2 id="cleaning-dialog-title">
          {stopped
            ? 'Cool, rinse, dry.'
            : run
              ? 'Your cleaning cycle.'
              : reviewing
                ? 'Ready for a vinegar bath?'
                : 'Clean your Joule.'}
        </h2>
        <p className="cleaning-subtitle">Extended clean · Joule Turbo</p>

        {(error || (open && state.error && !stopped)) && (
          <p className="notice error-notice" role="alert">
            {error || state.error}
          </p>
        )}

        {stopped ? (
          <>
            <p className="cleaning-status" role="status">
              Joule reported idle. The cleaning cycle has stopped.
            </p>
            {(run!.peakTemperatureC === null || run!.peakTemperatureC < 60) && (
              <p>This page did not observe the bath reaching {target} before it stopped.</p>
            )}
            <ol className="cleaning-steps">
              <li>
                <strong>Unplug and let it cool.</strong>
                Leave the Joule in the pot until the water, foot and clip are cool enough to handle.
              </li>
              <li>
                <strong>Rinse the lower section.</strong>
                Discard the vinegar bath and rinse the wetted lower section with clean water. Keep
                the top and cord dry.
              </li>
              <li>
                <strong>Wipe and dry.</strong>
                Wipe the outside with a damp cloth and let it dry before storing. Never put Joule in
                a dishwasher or immerse it completely.
              </li>
            </ol>
            <label className="review-check">
              <input
                type="checkbox"
                checked={rinsed}
                onChange={(event) => setRinsed(event.target.checked)}
              />
              {simulation
                ? 'I have finished this simulated cleaning guide.'
                : 'My Joule is unplugged, cool, rinsed and dry.'}
            </label>
            <button
              className="button primary full"
              disabled={!rinsed}
              onClick={() => {
                setRun(null);
                setReviewing(false);
                setOpen(false);
              }}
            >
              Finish cleaning
            </button>
          </>
        ) : run ? (
          <>
            <p className="cleaning-status" role="status">
              {run.interrupted
                ? 'Another program was observed. This cleaning cycle is no longer being tracked.'
                : !fresh
                  ? 'Status unavailable. The Joule may still be running.'
                  : ownsRunning
                    ? 'The Joule is running the cleaning bath.'
                    : 'Waiting for the Joule to confirm this cleaning cycle.'}
            </p>
            <div className="review-metrics">
              <strong>
                {target}
                <span>bath target</span>
              </strong>
              <strong>
                {countdown}
                <span>{ownsRunning ? 'remaining on Joule' : 'no current countdown'}</span>
              </strong>
            </div>
            <p>
              The 30-minute program includes warm-up and ends with heating off. Closing this guide
              or page does not send Stop. Keep the Joule in its bath until it has stopped and
              cooled.
            </p>
            {!fresh && (
              <p>Reconnect in the kitchen to check it. Cleaning will not restart automatically.</p>
            )}
            {!run.interrupted && (
              <button
                className="button stop-button full"
                disabled={
                  !connected || state.identity?.id !== run.deviceId || state.kind !== run.kind
                }
                onClick={() => void stop()}
              >
                {state.command === 'stopping' ? 'Send Stop again' : 'Stop cleaning'}
              </button>
            )}
            <button className="button secondary full" onClick={returnToKitchen}>
              Return to kitchen
            </button>
            {run.interrupted && (
              <button
                className="button secondary full"
                onClick={() => {
                  setRun(null);
                  setReviewing(false);
                  setOpen(false);
                }}
              >
                End cleaning guide
              </button>
            )}
          </>
        ) : reviewing ? (
          <>
            <div className="review-metrics">
              <strong>
                {target}
                <span>bath target</span>
              </strong>
              <strong>
                30<span>minutes from Start</span>
              </strong>
            </div>
            <p>
              This is the longer vinegar bath for buildup. The timer includes warm-up and runs on
              the Joule. Heating ends after 30 minutes, even if the page closes.
            </p>
            <label className="review-check">
              <input
                type="checkbox"
                checked={prepared}
                onChange={(event) => setPrepared(event.target.checked)}
              />
              {simulation
                ? 'I understand this cleaning cycle is simulated.'
                : 'My Joule is upright between MIN and MAX in equal parts water and distilled white vinegar, with no food in the pot. I’m nearby.'}
            </label>
            <button
              className="button primary full"
              disabled={!prepared || !!unavailable || working}
              onClick={() => void start()}
            >
              {working
                ? 'Sending cleaning cycle…'
                : simulation
                  ? 'Start simulated cleaning'
                  : 'Start cleaning'}
            </button>
            {unavailable && <p className="control-help">{unavailable}</p>}
            {(working || error) && (
              <button
                className="button stop-button full"
                disabled={!connected}
                onClick={() => void act(() => client.stop())}
              >
                Stop cleaning
              </button>
            )}
            <button
              className="button secondary full"
              disabled={working}
              onClick={() => {
                setPrepared(false);
                setReviewing(false);
              }}
            >
              Back to preparation
            </button>
          </>
        ) : (
          <>
            <ol className="cleaning-steps">
              <li>
                <strong>Mix the bath.</strong>
                Use equal parts water and distilled white vinegar in a small pot. Leave food out.
              </li>
              <li>
                <strong>Set Joule upright.</strong>
                Keep the liquid between MIN and MAX, with the top and cord dry.
              </li>
              <li>
                <strong>Review, then start.</strong>
                This extended bath targets {target} for 30 minutes, including warm-up, then turns
                heating off. You can stop it sooner.
              </li>
            </ol>
            <p>
              For routine cleaning, Breville’s guide says cleaning is complete when the bath reaches
              60°C / 140°F. The longer 20–30 minute bath is for buildup or circulation problems.
              Watch circulation and stop if the Joule reports an error.
            </p>
            {connected && state.proximity !== 2 && (
              <div className="cleaning-connect">
                {state.proximity === 1 ? (
                  <>
                    <p>Briefly press and release the Joule’s top button.</p>
                    {simulation && (
                      <button
                        className="button secondary full"
                        onClick={() => void act(pressSimulatedButton)}
                      >
                        Press simulated cleaning button
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="button secondary full"
                    disabled={state.status?.state !== 'idle' || !!state.command}
                    onClick={() => void act(() => client.requestControl())}
                  >
                    Enable cleaning controls
                  </button>
                )}
              </div>
            )}
            <button
              className="button primary full"
              disabled={!!unavailable}
              onClick={() => {
                setPrepared(false);
                setReviewing(true);
              }}
            >
              Review cleaning cycle
            </button>
            {unavailable && <p className="control-help">{unavailable}</p>}
            {!connected && (
              <button className="button secondary full" onClick={returnToKitchen}>
                Go to kitchen to connect
              </button>
            )}
          </>
        )}
        <p className="cleaning-source">
          <a href={GUIDE} target="_blank" rel="noreferrer">
            Manufacturer’s cleaning guide ↗
          </a>
          <a href={MANUAL} target="_blank" rel="noreferrer">
            Turbo manual ↗
          </a>
        </p>
        <p className="cleaning-limit">Uses the experimental manual controller. Stay nearby.</p>
      </dialog>
    </section>
  );
}
