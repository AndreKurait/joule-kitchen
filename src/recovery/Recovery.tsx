import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BrowserGatt } from '../device/bluetooth.ts';
import { ConnectionRecovery } from '../device/recovery.ts';
import type { RecoveryDiagnosis, RecoverySnapshot } from '../device/recovery.ts';
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
      <section className="card recovery-section" id="diagnose" aria-labelledby="diagnosis-title">
        <div className="recovery-intro">
          <p className="eyebrow">CONNECTION HELP</p>
          <h2 id="diagnosis-title">Can’t connect to Breville+?</h2>
          <p>
            Stuck on “Securing Connection” or seeing your Joule as offline? Check its settings over
            Bluetooth, see what we find, then choose a suggested fix if one is available.
          </p>
          <button className="button primary" onClick={() => setOpen(true)}>
            Diagnose connection <span aria-hidden="true">↗</span>
          </button>
          <p className="recovery-scope">
            Server-address check · Joule Turbo BSV600 · communication firmware 1.9.23
          </p>
        </div>
        <div className="recovery-story">
          <h3>Why this check exists.</h3>
          <p>
            Ours still answered Bluetooth and joined Wi-Fi, but Breville+ could not finish
            connecting. What looked like a bricked Joule turned out to have an invalid saved server
            address.
          </p>
          <p>
            Restoring the hostname stored on the Joule brought it back. We verified live readings,
            pump start and stop, and reconnection after unplugging it. The firmware stayed the same.
          </p>
          <a href={NOTES} target="_blank" rel="noreferrer">
            Read the diagnosis &amp; repair notes ↗
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
  if (reviewing) return 'Review the suggested fix.';
  switch (state.phase) {
    case 'ready':
      return 'Let’s check your Joule.';
    case 'choosing':
      return 'Choose your Joule.';
    case 'checking':
      return 'Reading connection settings…';
    case 'repairing':
      return 'Restoring the server address…';
    case 'repaired':
      return state.rechecked ? 'Address still matches.' : 'Address restored. Check Breville+ next.';
    case 'uncertain':
      return 'Write result not confirmed.';
    case 'error':
      return 'Couldn’t complete the check.';
    case 'checked':
      switch (state.diagnosis?.finding) {
        case 'known-fault':
          return 'A server-address fault was found.';
        case 'correct':
          return 'The saved server address matches.';
        case 'unsupported':
          return 'The diagnosis is incomplete.';
        default:
          return 'This setting needs further diagnosis.';
      }
  }
}

function DiagnosticFindings({ diagnosis }: { diagnosis: RecoveryDiagnosis }) {
  const supported = diagnosis.currentHex !== null;
  const addressResult = !supported
    ? 'Not checked'
    : {
        'known-fault': 'Fault found',
        correct: 'Matches built-in address',
        unsupported: 'Inconclusive',
        unrecognized: 'Unrecognized setting',
      }[diagnosis.finding];
  const addressTone =
    diagnosis.finding === 'known-fault'
      ? 'fault'
      : diagnosis.finding === 'correct'
        ? 'pass'
        : 'unknown';
  return (
    <dl className="diagnosis-findings" aria-label="Diagnostic findings">
      <div>
        <dt>Bluetooth</dt>
        <dd>
          <strong className="diagnosis-status pass">Responding</strong>
        </dd>
      </div>
      <div>
        <dt>Device compatibility</dt>
        <dd>
          <strong className={`diagnosis-status ${supported ? 'pass' : 'unknown'}`}>
            {supported ? 'Supported for this check' : 'Outside this check’s scope'}
          </strong>
          <span>
            {diagnosis.model} · firmware {diagnosis.commFirmware}
          </span>
        </dd>
      </div>
      <div>
        <dt>Server address</dt>
        <dd>
          <strong className={`diagnosis-status ${addressTone}`}>{addressResult}</strong>
        </dd>
      </div>
      <div>
        <dt>Wi-Fi &amp; Breville account</dt>
        <dd>
          <strong className="diagnosis-status unknown">Not checked</strong>
          <span>Internet access and app sign-in aren’t tested here.</span>
        </dd>
      </div>
    </dl>
  );
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
  const step = reviewing || writing || repaired || uncertain ? 3 : checked ? 2 : 1;

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
        <span className="eyebrow">CONNECTION DIAGNOSIS · BLUETOOTH</span>
        <button
          className="icon-button"
          onClick={close}
          disabled={writing}
          aria-label="Close diagnosis"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <ol className="recovery-steps" aria-label="Diagnosis progress">
        {['Check', 'Findings', 'Next steps'].map((label, index) => (
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
          before starting a diagnosis.
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
            We’ll check Bluetooth response, identify the model and firmware, and compare the saved
            server address with the Joule’s built-in address on supported devices.
          </p>
          <p className="recovery-callout">
            <strong>Diagnosis only. No settings are changed.</strong> You’ll see the findings first,
            with a suggested fix only if we identify the known fault.
          </p>
          <p>
            Leave your Joule plugged in and nearby. Close Breville+ on your phone, then choose your
            appliance in the browser’s Bluetooth picker.
          </p>
          <button
            className="button primary full"
            disabled={!!support || connectionBusy}
            onClick={() => void choose()}
          >
            Start diagnosis
          </button>
          {support && <p className="support-note">{support}</p>}
          <button className="demo-button" disabled={connectionBusy} onClick={() => void preview()}>
            Preview a diagnosis ↗
          </button>
          <details className="recovery-help">
            <summary>What can this diagnose?</summary>
            <p>
              One known malformed server setting on Turbo BSV600, communication firmware 1.9.23. The
              device must still answer Bluetooth. Wi-Fi, internet access, Breville account setup and
              hardware faults are outside this check.
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
          {checked && !reviewing && <DiagnosticFindings diagnosis={diagnosis} />}
          <details className="recovery-help" open={reviewing || repaired || uncertain}>
            <summary>Device details &amp; address readings</summary>
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
                  <code>
                    {diagnosis.referenceHost || 'Could not validate the built-in address'}
                  </code>
                </div>
              </div>
            )}
          </details>
        </>
      )}

      {checked && !reviewing && (
        <>
          <p className="recovery-read-only">
            This diagnosis made no changes. Bluetooth is disconnected.
          </p>
          <div className="diagnosis-next">
            {diagnosis?.finding === 'known-fault' ? (
              <>
                <h3>A suggested fix is available.</h3>
                <p>
                  Restore the saved server address using the built-in value from this Joule. Review
                  the exact change before deciding to apply it.
                </p>
                <button
                  className="button primary full"
                  disabled={connectionBusy}
                  onClick={() => {
                    setIdleConfirmed(false);
                    setReviewing(true);
                  }}
                >
                  Review suggested fix
                </button>
              </>
            ) : diagnosis?.finding === 'correct' ? (
              <>
                <h3>Next: check Wi-Fi and account setup.</h3>
                <p>
                  This address needs no repair. Open Breville+ and review its Wi-Fi setup and the
                  account your Joule is added to. A matching address alone does not confirm an
                  internet connection.
                </p>
                <p>If it still cannot connect, save this report for Breville support.</p>
              </>
            ) : (
              <>
                <h3>Further diagnosis is needed.</h3>
                <p>
                  These readings don’t identify a supported fix. Save the diagnostic report for
                  Breville support, including the app’s error message when you contact them.
                </p>
              </>
            )}
          </div>
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
            Back to findings
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
          Diagnosis &amp; repair notes ↗
        </a>
      </div>
    </dialog>
  );
}
