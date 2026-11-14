import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BrowserGatt } from '../device/bluetooth.ts';
import { ConnectionRecovery } from '../device/recovery.ts';
import type { RecoverySnapshot } from '../device/recovery.ts';
import type { RecoveryScenario } from '../../mock/recovery.ts';
import { errorMessage } from '../types.ts';

const NOTES = 'https://github.com/AndreKurait/joule-kitchen/blob/main/docs/RECOVERY.md';

export function RecoverySection({
  connectionBusy,
  support,
}: {
  connectionBusy: boolean;
  support: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="card recovery-section" id="recovery" aria-labelledby="recovery-title">
        <div className="recovery-intro">
          <p className="eyebrow">CONNECTION RECOVERY</p>
          <h2 id="recovery-title">Stuck on “Securing Connection”?</h2>
          <p>
            A Joule that looks bricked may have a broken server setting. Check for the fault we
            recovered from, then review the repair before changing anything.
          </p>
          <button className="button primary" onClick={() => setOpen(true)}>
            Open recovery <span aria-hidden="true">↗</span>
          </button>
          <p className="recovery-scope">
            Joule Turbo BSV600 · firmware 1.9.23 · checks over Bluetooth
          </p>
        </div>
        <div className="recovery-story">
          <h3>The Joule that looked bricked.</h3>
          <p>
            Ours still answered Bluetooth and joined Wi-Fi, but Breville+ could not finish
            connecting. Its saved server address had become an invalid single byte.
          </p>
          <p>
            Restoring the hostname stored on the Joule brought it back. We verified live readings,
            pump start and stop, and reconnection after unplugging it. The firmware stayed the same.
          </p>
          <a href={NOTES} target="_blank" rel="noreferrer">
            What we found &amp; what this can fix ↗
          </a>
        </div>
      </section>
      {open && (
        <RecoveryDialog
          close={() => setOpen(false)}
          connectionBusy={connectionBusy}
          support={support}
        />
      )}
    </>
  );
}

function titleFor(state: RecoverySnapshot, reviewing: boolean) {
  if (reviewing) return 'Review the address repair.';
  switch (state.phase) {
    case 'ready':
      return 'Let’s check the connection.';
    case 'choosing':
      return 'Choose your Joule.';
    case 'checking':
      return 'Reading connection settings…';
    case 'repairing':
      return 'Restoring the server address…';
    case 'repaired':
      return state.rechecked ? 'Address still matches.' : 'Address restored. Reconnect next.';
    case 'uncertain':
      return 'Write result not confirmed.';
    case 'error':
      return 'Couldn’t complete the check.';
    case 'checked':
      switch (state.diagnosis?.finding) {
        case 'known-fault':
          return 'We found the known fault.';
        case 'correct':
          return 'Your server address already matches.';
        case 'unsupported':
          return 'This repair doesn’t match your Joule.';
        default:
          return 'Different setting. No repair offered.';
      }
  }
}

function RecoveryDialog({
  close,
  connectionBusy,
  support,
}: {
  close: () => void;
  connectionBusy: boolean;
  support: string | null;
}) {
  const [recovery] = useState(() => new ConnectionRecovery());
  const state = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);
  const [reviewing, setReviewing] = useState(false);
  const [idleConfirmed, setIdleConfirmed] = useState(false);
  const [scenario, setScenario] = useState<RecoveryScenario>('broken');
  const [uiError, setUiError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const writing = state.phase === 'repairing';
  const busy = writing || state.phase === 'checking' || state.phase === 'choosing';
  const simulation = state.kind === 'mock';
  const diagnosis = state.diagnosis;
  const repaired = state.phase === 'repaired';
  const uncertain = state.phase === 'uncertain';
  const checked = state.phase === 'checked';
  const problem = uiError || state.error;
  const step = reviewing || writing ? 2 : repaired || uncertain ? 3 : 1;

  useEffect(() => {
    dialog.current?.showModal();
    return () => recovery.dispose();
  }, [recovery]);
  useEffect(() => {
    if (state.phase !== 'checked') {
      setReviewing(false);
      setIdleConfirmed(false);
    }
    heading.current?.focus();
  }, [state.phase]);
  useEffect(() => {
    if (reviewing) heading.current?.focus();
  }, [reviewing]);
  useEffect(() => {
    if (!writing) return;
    const beforeClose = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeClose);
    return () => window.removeEventListener('beforeunload', beforeClose);
  }, [writing]);

  async function choose() {
    if (connectionBusy) return;
    setUiError(null);
    try {
      recovery.choosing();
      const wire = await BrowserGatt.choose({ recovery: true });
      await recovery.inspect(wire);
    } catch (error) {
      recovery.selectionFailed(error);
    }
  }
  async function preview() {
    if (connectionBusy) return;
    setUiError(null);
    try {
      const { RecoveryDemoGatt } = await import('../../mock/recovery.ts');
      await recovery.inspect(new RecoveryDemoGatt(scenario));
    } catch (error) {
      setUiError(errorMessage(error));
    }
  }
  async function perform(operation: () => Promise<void>) {
    if (connectionBusy) return;
    setUiError(null);
    try {
      await operation();
    } catch (error) {
      setUiError(errorMessage(error));
    }
  }
  function downloadReport() {
    const blob = new Blob([JSON.stringify(recovery.report(), null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `joule-${simulation ? 'SIMULATED-' : ''}connection-check.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <dialog
      className="modal recovery-modal"
      ref={dialog}
      aria-labelledby="recovery-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!writing) close();
      }}
      onClose={() => {
        if (!writing) close();
      }}
    >
      <div className="modal-heading">
        <span className="eyebrow">JOULE RECOVERY · BLUETOOTH</span>
        <button
          className="icon-button"
          onClick={close}
          disabled={writing}
          aria-label="Close recovery"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <ol className="recovery-steps" aria-label="Recovery progress">
        {['Check', 'Review', 'Reconnect'].map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>
            <span>{index + 1}</span> {label}
          </li>
        ))}
      </ol>
      {simulation && (
        <p className="recovery-simulation" role="status">
          <strong>SIMULATION</strong> All checks and repairs here use a mock Joule.
        </p>
      )}
      <h2 id="recovery-dialog-title" ref={heading} tabIndex={-1}>
        {titleFor(state, reviewing)}
      </h2>

      {connectionBusy && (
        <p className="recovery-callout" role="status">
          The kitchen already has a Bluetooth session open. Finish your cook and disconnect there
          before checking recovery.
        </p>
      )}
      {problem && (
        <p className="recovery-error" role="alert">
          {problem}
        </p>
      )}
      {state.phase === 'ready' && (
        <>
          <p>
            Leave your Joule plugged in and nearby. Close Breville+ on your phone, then choose your
            appliance in the browser’s Bluetooth picker.
          </p>
          <p className="recovery-callout">
            <strong>The first check only reads settings.</strong> A repair is offered only when the
            device and fault match the verified recovery.
          </p>
          <button
            className="button primary full"
            disabled={!!support || connectionBusy}
            onClick={() => void choose()}
          >
            Check my Joule
          </button>
          {support && <p className="support-note">{support}</p>}
          <button className="demo-button" disabled={connectionBusy} onClick={() => void preview()}>
            Preview with a simulated fault ↗
          </button>
          <details className="recovery-help">
            <summary>What can this fix?</summary>
            <p>
              One known malformed server setting on Turbo BSV600, communication firmware 1.9.23. The
              device must still answer Bluetooth. This cannot fix damaged electronics or firmware,
              and does not set up a Wi-Fi network or account.
            </p>
            <p>
              The repair was verified on hardware using a native Bluetooth tool. This browser repair
              flow is experimental and has been tested with simulated devices.
            </p>
          </details>
        </>
      )}
      {busy && (
        <p className="recovery-working" role="status">
          <span className="spinner" />
          {writing
            ? 'Rechecking the settings, then saving and reading back the complete address. Keep this page open.'
            : state.phase === 'choosing'
              ? 'Select your Joule in the browser. No settings will be changed.'
              : 'Reading the device identity and both server settings. No settings will be changed.'}
        </p>
      )}

      {diagnosis && !busy && (
        <>
          <p>{diagnosis.explanation}</p>
          <dl className="recovery-device">
            <div>
              <dt>Model</dt>
              <dd>{diagnosis.model}</dd>
            </div>
            <div>
              <dt>Communication firmware</dt>
              <dd>{diagnosis.commFirmware}</dd>
            </div>
          </dl>
          {diagnosis.currentHex !== null && (
            <div className="recovery-addresses">
              <div>
                <span>Saved server address · last read</span>
                <code data-testid="recovery-current-address">
                  {diagnosis.currentHost ||
                    (diagnosis.currentHex ? `Hex: ${diagnosis.currentHex}` : 'Empty')}
                </code>
              </div>
              <div>
                <span>Built-in address read from this Joule</span>
                <code>{diagnosis.referenceHost || 'Could not validate the built-in address'}</code>
              </div>
            </div>
          )}
        </>
      )}

      {checked && !reviewing && (
        <>
          <p className="recovery-read-only">
            This check made no changes. Bluetooth is disconnected.
          </p>
          {diagnosis?.finding === 'known-fault' ? (
            <button
              className="button primary full"
              disabled={connectionBusy}
              onClick={() => {
                setIdleConfirmed(false);
                setReviewing(true);
              }}
            >
              Review the repair
            </button>
          ) : (
            <p className="recovery-callout">
              {diagnosis?.finding === 'correct'
                ? 'If Breville+ still cannot connect, check Wi-Fi and account setup in that app. A matching address alone does not confirm an internet connection.'
                : 'No setting will be replaced. Save the diagnostic report and use Breville support for a fault outside this repair’s scope.'}
            </p>
          )}
        </>
      )}
      {checked && reviewing && (
        <>
          <p className="recovery-callout">
            This restores the exact built-in address shown above. Your saved Wi-Fi credentials and
            firmware stay as they are. The browser repair flow is experimental.
          </p>
          <label className="review-check">
            <input
              type="checkbox"
              checked={idleConfirmed}
              onChange={(event) => setIdleConfirmed(event.target.checked)}
            />
            {simulation ? 'This is a simulated repair.' : 'My Joule is not cooking.'}
          </label>
          <button
            className="button primary full"
            disabled={!idleConfirmed || connectionBusy}
            onClick={() => void perform(() => recovery.repair(idleConfirmed))}
          >
            {simulation ? 'Restore simulated address' : 'Restore server address'}
          </button>
          <button className="text-button recovery-back" onClick={() => setReviewing(false)}>
            Back to the check
          </button>
        </>
      )}
      {uncertain && (
        <>
          <p className="recovery-callout">
            The address may already have been saved. Recheck it over a fresh Bluetooth connection.
            Rechecking only reads settings; it will not repeat the repair.
          </p>
          <button
            className="button primary full"
            disabled={connectionBusy}
            onClick={() => void perform(() => recovery.recheck())}
          >
            Recheck saved address
          </button>
        </>
      )}
      {repaired && (
        <>
          <p className="recovery-callout">
            <strong>
              {state.rechecked
                ? 'Address checked on a new Bluetooth connection.'
                : 'Write and readback matched.'}
            </strong>{' '}
            Bluetooth is disconnected. Breville+ still needs to confirm the cloud connection.
          </p>
          <ol className="recovery-next">
            <li>
              {simulation
                ? 'On a real Joule, unplug it for 10 seconds, then plug it in without holding its button.'
                : 'Unplug the Joule for 10 seconds, then plug it in without holding its button.'}
            </li>
            <li>Keep Breville+ closed while you recheck the saved address below.</li>
            <li>Open Breville+ and check for a fresh temperature reading and connected status.</li>
          </ol>
          <button
            className="button secondary full"
            disabled={connectionBusy}
            onClick={() => void perform(() => recovery.recheck())}
          >
            Recheck saved address
          </button>
          <details className="recovery-help">
            <summary>Still stuck connecting?</summary>
            <p>
              Finish Wi-Fi and account setup in Breville+. Our hardware recovery also reconnected an
              existing saved Wi-Fi profile. This site restores the server address; it cannot perform
              that network setup or confirm Breville’s cloud connection.
            </p>
            <p>
              Keep the diagnostic report for support. Repeated address writes or a firmware flash
              are not a next step when the saved address already matches.
            </p>
          </details>
        </>
      )}
      {state.phase === 'error' && (
        <>
          <p>
            No repair was sent during this check. Close other Bluetooth connections and choose your
            Joule again.
          </p>
          <button
            className="button primary full"
            disabled={!!support || connectionBusy}
            onClick={() => void choose()}
          >
            Choose Joule again
          </button>
          {support && <p className="support-note">{support}</p>}
        </>
      )}
      {simulation && !busy && !reviewing && (
        <details className="recovery-help recovery-demo-controls">
          <summary>Try another simulated outcome</summary>
          <label htmlFor="recovery-scenario">Simulated scenario</label>
          <select
            id="recovery-scenario"
            value={scenario}
            onChange={(event) => setScenario(event.target.value as RecoveryScenario)}
          >
            <option value="broken">Known invalid address</option>
            <option value="correct">Address already correct</option>
            <option value="different">An unrecognized setting</option>
            <option value="unsupported">Unsupported firmware</option>
            <option value="lost-ack">Connection lost during repair</option>
          </select>
          <button
            className="button secondary full"
            disabled={connectionBusy}
            onClick={() => void preview()}
          >
            Run simulated check
          </button>
        </details>
      )}
      {diagnosis && !busy && (
        <div className="recovery-report">
          <button className="text-button" onClick={downloadReport}>
            Download diagnostic report
          </button>
          <span>Excludes device identifiers, Wi-Fi credentials and account data.</span>
        </div>
      )}
      <div className="recovery-modal-footer">
        <button className="text-button" onClick={close} disabled={writing}>
          Back to the kitchen
        </button>
        <a href={NOTES} target="_blank" rel="noreferrer">
          Recovery notes ↗
        </a>
      </div>
    </dialog>
  );
}
