import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BrowserGatt, bluetoothSupport } from './device/bluetooth.ts';
import { JouleClient } from './device/client.ts';
import type { MockWire } from './device/mock.ts';
import type { MockAction } from '../mock/device.ts';
import type { GattWire } from './device/wire.ts';
import { HistoryStore, exportCsv } from './history/store.ts';
import { Recorder } from './history/recorder.ts';
import { TemperatureGraph } from './history/Graph.tsx';
import { RecoverySection } from './recovery/Recovery.tsx';
import type { Recording, Sample, Unit } from './types.ts';
import { errorMessage, formatTemperature } from './types.ts';

const client = new JouleClient();
const store = new HistoryStore();
const SOURCE = 'https://github.com/AndreKurait/joule-kitchen';
const clock = (seconds: number | null) =>
  seconds === null
    ? '—'
    : `${Math.floor(seconds / 60)
        .toString()
        .padStart(2, '0')}:${Math.floor(seconds % 60)
        .toString()
        .padStart(2, '0')}`;

function Icon({
  name,
  size = 20,
}: {
  name:
    'bluetooth' | 'chart' | 'arrow' | 'download' | 'stop' | 'clock' | 'close' | 'check' | 'leaf';
  size?: number;
}) {
  const paths = {
    bluetooth: 'm7 7 10 10-5 5V2l5 5L7 17',
    chart: 'M4 4v16h16M7 15l4-5 4 3 5-8',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    stop: 'M6 6h12v12H6z',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    close: 'm6 6 12 12M6 18 18 6',
    check: 'm5 12 4 4L19 6',
    leaf: 'M20 3C8 2 2 9 6 16s15 3 14-13ZM5 21 16 8',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function loadUnit(): Unit {
  try {
    return localStorage.getItem('joule-unit') === 'F' ? 'F' : 'C';
  } catch {
    return 'C';
  }
}

export default function App() {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [unit, setUnit] = useState<Unit>(loadUnit);
  const [now, setNow] = useState(Date.now());
  const [uiError, setUiError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [activeRecording, setActiveRecording] = useState<Recording | null>(null);
  const [selectedId, setSelectedId] = useState('live');
  const [liveSamples, setLiveSamples] = useState<Sample[]>([]);
  const [savedSamples, setSavedSamples] = useState<Sample[]>([]);
  const [showTarget, setShowTarget] = useState(true);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [temperatureC, setTemperatureC] = useState(55);
  const [minutes, setMinutes] = useState(30);
  const [reviewing, setReviewing] = useState(false);
  const [waterConfirmed, setWaterConfirmed] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mock, setMock] = useState<MockWire | null>(null);
  const [remembered, setRemembered] = useState<BrowserGatt[]>([]);
  const [keepingAwake, setKeepingAwake] = useState(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const previousPhase = useRef(state.phase);
  const refreshRecordings = useCallback(() => {
    void store
      .recordings()
      .then(setRecordings)
      .catch((error) => setStorageError(errorMessage(error)));
  }, []);
  const recorder = useMemo(
    () =>
      new Recorder(
        store,
        (recording, sample) => {
          setActiveRecording(recording);
          setLiveSamples((samples) => [...samples, sample]);
          setStorageError(null);
          setRecordings((records) => [recording, ...records.filter((r) => r.id !== recording.id)]);
        },
        setStorageError,
      ),
    [],
  );

  useEffect(() => {
    refreshRecordings();
    void BrowserGatt.remembered()
      .then(setRemembered)
      .catch(() => {});
    const remove = client.onStatus((status) => {
      const kind = client.getSnapshot().kind;
      if (kind) recorder.record(kind, status);
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const visible = () => {
      recorder.markGap();
      if (!document.hidden && client.getSnapshot().phase === 'connected')
        void client.refresh().catch(() => {});
    };
    document.addEventListener('visibilitychange', visible);
    const beforeClose = (event: BeforeUnloadEvent) => {
      const current = client.getSnapshot();
      if (current.status?.state !== 'idle' && current.phase === 'connected') event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeClose);
    return () => {
      remove();
      clearInterval(tick);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('beforeunload', beforeClose);
    };
  }, [recorder, refreshRecordings]);
  useEffect(() => {
    if (state.phase !== previousPhase.current && ['disconnected', 'error'].includes(state.phase))
      recorder.markGap();
    previousPhase.current = state.phase;
  }, [state.phase, recorder]);
  useEffect(() => {
    if (selectedId === 'live') return;
    let cancelled = false;
    void store
      .samples(selectedId)
      .then((samples) => {
        if (!cancelled) setSavedSamples(samples);
      })
      .catch((error) => setStorageError(errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);
  useEffect(() => {
    if (reviewing) {
      setWaterConfirmed(false);
      reviewDialog.current?.showModal();
    } else reviewDialog.current?.close();
  }, [reviewing]);

  async function perform(operation: () => Promise<unknown>) {
    setUiError(null);
    try {
      await operation();
    } catch (error) {
      setUiError(errorMessage(error));
    }
  }
  async function connect(wire: GattWire) {
    // Switching simulation/real transport starts a new, separately labelled log.
    await recorder.end();
    setLiveSamples([]);
    setActiveRecording(null);
    setSelectedId('live');
    await client.connect(wire);
    // Keep a chosen device available for one-click reconnect even on browsers
    // that do not implement getDevices() across page loads.
    if (wire instanceof BrowserGatt)
      setRemembered((devices) => [wire, ...devices.filter((device) => device.id !== wire.id)]);
  }
  async function pair() {
    setUiError(null);
    try {
      client.choosing();
      const wire = await BrowserGatt.choose();
      setMock(null);
      await connect(wire);
    } catch (error) {
      client.selectionFailed(error);
    }
  }
  async function simulate() {
    await perform(async () => {
      const { DemoGatt, SocketMockGatt } = await import('./device/mock.ts');
      const wire =
        new URLSearchParams(window.location.search).get('mock') === 'server'
          ? new SocketMockGatt()
          : new DemoGatt();
      setMock(wire);
      await connect(wire);
    });
  }
  const mockAction = (action: MockAction) =>
    perform(async () => {
      await mock?.action(action);
    });
  const status = state.status;
  const connected = state.phase === 'connected';
  const connecting = ['connecting', 'choosing'].includes(state.phase);
  const stale = !status || now - status.at > 15000 || !connected;
  const simulation = state.kind === 'mock';
  const running = connected && status && status.state !== 'idle';
  const unavailable = client.canStart(now);
  const selectedRecording =
    selectedId === 'live' ? activeRecording : (recordings.find((r) => r.id === selectedId) ?? null);
  const allSamples = selectedId === 'live' ? liveSamples : savedSamples;
  const lastTime = allSamples[allSamples.length - 1]?.at ?? now;
  const samples = windowMinutes
    ? allSamples.filter((sample) => sample.at >= lastTime - windowMinutes * 60000)
    : allSamples;
  const selectedIsSimulated = selectedRecording?.kind === 'mock';
  const support =
    new URLSearchParams(window.location.search).get('mock') === 'server'
      ? 'This page connects to the Docker mock. Use the live site to pair a real Joule.'
      : bluetoothSupport();
  const problem = uiError || state.error;

  async function download() {
    await perform(async () => {
      if (!selectedRecording) return;
      await recorder.settled();
      const rows = await store.samples(selectedRecording.id);
      const blob = new Blob([exportCsv(selectedRecording, rows)], {
        type: 'text/csv;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `joule-${selectedRecording.kind === 'mock' ? 'SIMULATED-' : ''}${new Date(selectedRecording.startedAt).toISOString().replaceAll(':', '-')}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function toggleAwake() {
    await perform(async () => {
      if (wakeLock.current) {
        await wakeLock.current.release();
        wakeLock.current = null;
        setKeepingAwake(false);
      } else {
        if (!navigator.wakeLock)
          throw new Error('Screen wake lock is unavailable in this browser.');
        const lock = await navigator.wakeLock.request('screen');
        wakeLock.current = lock;
        setKeepingAwake(true);
        lock.addEventListener('release', () => {
          wakeLock.current = null;
          setKeepingAwake(false);
        });
      }
    });
  }
  const updateUnit = (next: Unit) => {
    setUnit(next);
    try {
      localStorage.setItem('joule-unit', next);
    } catch {
      /* ephemeral preference */
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Joule Kitchen home">
          <img src="./favicon.svg" width="34" height="34" alt="" />
          <span>
            joule<span className="brand-light">kitchen</span>
          </span>
          <span className="beta-tag">LAB</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#bath" className="nav-current">
            The kitchen
          </a>
          <a href="#history">Recordings</a>
          <a href="#recovery">Recovery</a>
          <button className="nav-button" onClick={() => setAboutOpen(true)}>
            About
          </button>
        </nav>
        <a className="source-link" href={SOURCE} target="_blank" rel="noreferrer">
          View source <span aria-hidden="true">↗</span>
        </a>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR COUNTERTOP, CONNECTED</p>
            <h1>Keep an eye on the bath.</h1>
            <p className="intro">
              A direct connection to your Joule. A little more insight into every cook.
            </p>
          </div>
          <div className="local-pill">
            <span className="green-dot" />
            History stays in this browser
          </div>
        </div>

        {simulation && (
          <div className="simulation-banner" role="status">
            <strong>SIMULATION</strong>
            <span>You’re using a mock Joule. All temperatures and commands are simulated.</span>
            <span className="mock-location">
              {mock?.id.startsWith('docker') ? 'Docker device' : 'Browser demo'}
            </span>
          </div>
        )}
        {problem && (
          <div className="notice error-notice" role="alert">
            <span>{problem}</span>
            {uiError && (
              <button aria-label="Dismiss message" onClick={() => setUiError(null)}>
                <Icon name="close" size={18} />
              </button>
            )}
          </div>
        )}
        {storageError && (
          <div className="notice error-notice" role="alert">
            {storageError}
          </div>
        )}

        <div className="workspace">
          <aside className="sidebar">
            <section className="card connection-card" aria-labelledby="connection-title">
              <div className="card-kicker">
                <Icon name="bluetooth" />
                <span>BLUETOOTH</span>
                <span className={`status-dot ${connected ? 'online' : ''}`} />
              </div>
              <h2 id="connection-title">
                {connected
                  ? simulation
                    ? 'Simulated Joule'
                    : 'Hello, Joule.'
                  : 'Meet your Joule.'}
              </h2>
              <p>
                {connected
                  ? simulation
                    ? 'Connected to the simulated Joule.'
                    : 'Connected over Bluetooth. No sign-in needed.'
                  : 'Pair your nearby Joule Turbo over Bluetooth to see live water temperature. No sign-in needed.'}
              </p>
              {!connected && !connecting && (
                <>
                  <button
                    className="button primary full"
                    onClick={() => void pair()}
                    disabled={!!support}
                  >
                    <Icon name="bluetooth" />
                    Pair Joule
                    <Icon name="arrow" size={18} />
                  </button>
                  {support && <p className="support-note">{support}</p>}
                  {remembered.length > 0 && (
                    <div className="remembered">
                      <span>Previously paired</span>
                      {remembered.map((device) => (
                        <button
                          key={device.id}
                          className="button secondary full"
                          onClick={() => void perform(() => connect(device))}
                        >
                          {device.name}
                          <Icon name="arrow" size={16} />
                        </button>
                      ))}
                    </div>
                  )}
                  <button className="demo-button" onClick={() => void simulate()}>
                    Try a simulated Joule <span aria-hidden="true">↗</span>
                  </button>
                </>
              )}
              {connecting && (
                <div className="connecting-state" role="status">
                  <span className="spinner" />
                  {state.phase === 'choosing'
                    ? 'Choose your Joule in the browser…'
                    : 'Connecting to your Joule…'}
                </div>
              )}
              {connected && (
                <>
                  <div className="device-details">
                    <span>
                      Joule Turbo <b>BSV600</b>
                    </span>
                    <span>
                      <span className="green-dot" />
                      {simulation ? 'Simulated Bluetooth' : 'Bluetooth'}
                    </span>
                  </div>
                  {state.proximity !== 2 && (
                    <button
                      className="button secondary full"
                      onClick={() => void perform(() => client.requestControl())}
                      disabled={state.proximity === 1}
                    >
                      {state.proximity === 1 ? 'Waiting for the top button…' : 'Enable cooking'}
                    </button>
                  )}
                  {state.proximity === 2 && (
                    <p className="button-confirmed">
                      <Icon name="check" size={16} />
                      Physical button confirmed
                    </p>
                  )}
                  {state.proximity === 1 && (
                    <p className="button-instruction">Press the Joule’s top button once.</p>
                  )}
                  <button
                    className="text-button"
                    disabled={!!state.command}
                    onClick={() =>
                      void perform(async () => {
                        await client.disconnect();
                        await recorder.end();
                        refreshRecordings();
                      })
                    }
                  >
                    Disconnect
                  </button>
                </>
              )}
              <div className="connection-footer">
                <span>01</span>
                <span>
                  Keep this page open to record.
                  <a className="recovery-shortcut" href="#recovery">
                    Stuck connecting? Try recovery ↗
                  </a>
                </span>
              </div>
            </section>

            <div className="quiet-note">
              <Icon name="leaf" size={19} />
              <p>
                Open source. Served as static files.
                <br />
                No analytics or account database.
              </p>
            </div>
          </aside>

          <div className="main-column">
            <section className="card bath-card" id="bath" aria-labelledby="bath-title">
              <div className="section-heading">
                <div className="card-kicker">
                  <span className={`status-dot ${connected && !stale ? 'online' : ''}`} />
                  <h2 id="bath-title">THE BATH</h2>
                </div>
                <div className="unit-toggle" aria-label="Temperature unit">
                  <button aria-pressed={unit === 'C'} onClick={() => updateUnit('C')}>
                    °C
                  </button>
                  <button aria-pressed={unit === 'F'} onClick={() => updateUnit('F')}>
                    °F
                  </button>
                </div>
              </div>
              <div className="bath-metrics">
                <div className="current-temperature">
                  <span className="metric-label">
                    {stale && status ? 'LAST READING' : 'WATER TEMPERATURE'}
                  </span>
                  <div>
                    <span data-testid="bath-temperature">
                      {formatTemperature(status?.temperatureC ?? null, unit)}
                    </span>
                    <span className="temperature-unit">°{unit}</span>
                  </div>
                  <p className={stale && status ? 'stale-label' : 'live-label'}>
                    {!status
                      ? 'Waiting for your Joule'
                      : stale
                        ? 'Reading paused · reconnect to update'
                        : simulation
                          ? 'Live simulated reading'
                          : 'Live from your Joule'}
                  </p>
                </div>
                <div className="secondary-metrics">
                  <div>
                    <span className="metric-label">TARGET</span>
                    <strong data-testid="target-temperature">
                      {formatTemperature(status?.targetC ?? null, unit)}
                      <small>°{unit}</small>
                    </strong>
                  </div>
                  <div>
                    <span className="metric-label">STATE</span>
                    <strong className="state-value" data-testid="device-state">
                      {!connected
                        ? 'Disconnected'
                        : stale
                          ? 'Waiting'
                          : status?.state === 'idle'
                            ? 'Idle'
                            : status?.nativeMode === 24
                              ? 'Turbo'
                              : status?.state === 'cooking'
                                ? 'Cooking'
                                : (status?.state ?? 'Waiting')}
                    </strong>
                  </div>
                </div>
                <div className="bath-illustration" aria-hidden="true">
                  <div className="joule-stick">
                    <i />
                    <span />
                  </div>
                  <div className="vessel">
                    <div className={`water ${running ? 'moving' : ''}`} />
                    <div className="water-surface" />
                    <span className="water-mark">MAX</span>
                  </div>
                </div>
              </div>
              <div className="bath-footer">
                <span>
                  {status
                    ? `Updated ${new Date(status.at).toLocaleTimeString()}`
                    : 'Temperature appears after pairing'}
                </span>
                <span>
                  <Icon name="clock" size={15} />
                  {running ? `${clock(status.remainingSeconds)} remaining` : 'Ready when you are'}
                </span>
              </div>
            </section>

            <section className="card history-card" id="history" aria-labelledby="history-title">
              <div className="section-heading">
                <div>
                  <div className="card-kicker">
                    <Icon name="chart" />
                    <span>THE TEMPERATURE CURVE</span>
                  </div>
                  <h2 id="history-title">Every degree, over time.</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Export recording as CSV"
                  title="Export complete recording"
                  disabled={!selectedRecording?.sampleCount}
                  onClick={() => void download()}
                >
                  <Icon name="download" />
                </button>
              </div>
              <div className="history-controls">
                <label className="sr-only" htmlFor="recording">
                  Recording
                </label>
                <select
                  id="recording"
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  <option value="live">Current connection</option>
                  {recordings
                    .filter((record) => record.id !== activeRecording?.id)
                    .map((record) => (
                      <option key={record.id} value={record.id}>
                        {record.kind === 'mock' ? 'SIMULATED · ' : ''}
                        {new Date(record.startedAt).toLocaleString()}
                      </option>
                    ))}
                </select>
                <div className="range-buttons" aria-label="Graph time range">
                  {[
                    [15, '15m'],
                    [60, '1h'],
                    [360, '6h'],
                    [0, 'All'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={windowMinutes === value}
                      onClick={() => setWindowMinutes(Number(value))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {selectedIsSimulated && <p className="simulation-label">SIMULATED RECORDING</p>}
              <TemperatureGraph samples={samples} unit={unit} showTarget={showTarget} />
              <div className="history-footer">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={showTarget}
                    onChange={(event) => setShowTarget(event.target.checked)}
                  />
                  Show target
                </label>
                <span data-testid="sample-count">
                  {selectedRecording?.sampleCount ?? 0} readings saved
                </span>
                {selectedId !== 'live' && (
                  <button className="text-button danger-text" onClick={() => setDeleteOpen(true)}>
                    Delete
                  </button>
                )}
              </div>
              <p className="storage-note">
                Recorded on this device while the page is running. Missing readings appear as gaps.{' '}
                <button className="inline-button" onClick={() => void toggleAwake()}>
                  {keepingAwake ? 'Screen is staying awake ✓' : 'Keep screen awake'}
                </button>
              </p>
            </section>
          </div>

          <aside className="cook-column">
            <section className="card cook-card" aria-labelledby="cook-title">
              <div className="card-kicker">
                <Icon name="clock" />
                <span>MANUAL · EXPERIMENTAL</span>
              </div>
              <h2 id="cook-title">A timed bath.</h2>
              <p>
                Choose a temperature and a run time. The program uses the Joule’s timer and ends
                with a heater-off instruction.
              </p>
              <label className="field-label" htmlFor="temperature">
                Bath temperature <span>20–90°C</span>
              </label>
              <div className="number-field">
                <input
                  id="temperature"
                  inputMode="decimal"
                  type="number"
                  min={unit === 'C' ? 20 : 68}
                  max={unit === 'C' ? 90 : 194}
                  step="0.5"
                  value={
                    unit === 'C'
                      ? temperatureC
                      : Math.round(((temperatureC * 9) / 5 + 32) * 10) / 10
                  }
                  onChange={(event) =>
                    setTemperatureC(
                      unit === 'C'
                        ? Number(event.target.value)
                        : ((Number(event.target.value) - 32) * 5) / 9,
                    )
                  }
                />
                <span>°{unit}</span>
              </div>
              <label className="field-label" htmlFor="duration">
                Run time <span>from Start</span>
              </label>
              <div className="number-field">
                <input
                  id="duration"
                  type="number"
                  inputMode="decimal"
                  min="0.1666666667"
                  max="1440"
                  step="any"
                  value={minutes}
                  onChange={(event) => setMinutes(Number(event.target.value))}
                />
                <span>min</span>
              </div>
              <div className="presets" aria-label="Run time presets">
                {[10, 30, 60].map((value) => (
                  <button
                    key={value}
                    onClick={() => setMinutes(value)}
                    aria-pressed={minutes === value}
                  >
                    {value} min
                  </button>
                ))}
              </div>
              <p className="timing-note">
                The timer starts immediately, including warm-up. This is a manual bath, not a Turbo
                food recipe.
              </p>
              <button
                className="button primary full"
                disabled={
                  !!unavailable ||
                  !Number.isFinite(temperatureC) ||
                  temperatureC < 20 ||
                  temperatureC > 90 ||
                  minutes * 60 < 10 ||
                  minutes > 1440
                }
                onClick={() => setReviewing(true)}
              >
                Review manual cook <Icon name="arrow" size={18} />
              </button>
              {unavailable && <p className="control-help">{unavailable}</p>}
              <button
                className={`button stop-button full ${running ? 'is-running' : ''}`}
                disabled={!connected}
                onClick={() => {
                  setReviewing(false);
                  void perform(() => client.stop());
                }}
              >
                <Icon name="stop" size={18} />
                {state.command === 'stopping' ? 'Stop again' : 'Stop Joule'}
              </button>
              {state.message && (
                <p className="command-message" role="status">
                  {state.message}
                </p>
              )}
            </section>
            <section className="turbo-note">
              <span className="turbo-label">TURBO, TOO</span>
              <h3>Keep the whole curve.</h3>
              <p>
                Start a Turbo recipe in Breville+, then pair here to record the Joule’s changing
                bath temperature.
              </p>
              <p>The graph shows measured water temperature, not food core temperature.</p>
            </section>
          </aside>
        </div>

        <RecoverySection connectionBusy={connected || connecting} support={support} />

        {simulation && connected && (
          <details className="mock-controls">
            <summary>
              Mock device controls <span>For UI testing</span>
            </summary>
            <div className="mock-actions">
              <button
                className="button secondary"
                onClick={() => void mockAction('button')}
                disabled={state.proximity !== 1}
              >
                Press simulated top button
              </button>
              <button className="button secondary" onClick={() => void mockAction('turbo')}>
                Simulate Turbo status
              </button>
              <button className="button secondary" onClick={() => void mockAction('idle')}>
                Simulate idle
              </button>
              <button className="button secondary" onClick={() => void mockAction('malformed')}>
                Send truncated frame
              </button>
              <button className="button secondary" onClick={() => void mockAction('sensor-fault')}>
                Simulate missing sensor
              </button>
              <button className="button secondary" onClick={() => void mockAction('silence')}>
                Pause readings
              </button>
              <button className="button secondary" onClick={() => void mockAction('resume')}>
                Resume readings
              </button>
              <button className="button secondary" onClick={() => void mockAction('slow-upload')}>
                Slow recipe upload
              </button>
              <button className="button secondary" onClick={() => void mockAction('disconnect')}>
                Drop connection
              </button>
            </div>
          </details>
        )}
        <footer className="footer">
          <span>Made for curious cooks.</span>
          <span>
            An independent experiment for Joule Turbo BSV600. Not affiliated with Breville.
          </span>
          <a href={`${SOURCE}#readme`} target="_blank" rel="noreferrer">
            Documentation ↗
          </a>
        </footer>
      </main>

      <dialog
        ref={reviewDialog}
        className="modal"
        onCancel={() => setReviewing(false)}
        onClose={() => setReviewing(false)}
        aria-labelledby="review-title"
      >
        <div className="modal-heading">
          <span className="eyebrow">{simulation ? 'SIMULATED COOK' : 'READY TO RUN?'}</span>
          <button
            className="icon-button"
            aria-label="Close review"
            onClick={() => setReviewing(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="review-title">One last look.</h2>
        <p>Manual timed bath · Joule Turbo</p>
        <div className="review-metrics">
          <strong>
            {formatTemperature(temperatureC, unit)}°{unit}
            <span>bath target</span>
          </strong>
          <strong>
            {minutes}
            <span>minutes from Start</span>
          </strong>
        </div>
        <p>
          The run time includes warm-up. The timed program ends with a heater-off instruction.
          Closing the page does not send Stop.
        </p>
        <label className="review-check">
          <input
            type="checkbox"
            checked={waterConfirmed}
            onChange={(event) => setWaterConfirmed(event.target.checked)}
          />
          {simulation
            ? 'I understand this is a simulated device.'
            : 'My Joule is upright in water between MIN and MAX, and I’m nearby.'}
        </label>
        <button
          className="button primary full"
          disabled={!waterConfirmed || !!unavailable}
          onClick={() => {
            setReviewing(false);
            void perform(() =>
              client.start({ temperatureC, durationSeconds: Math.round(minutes * 60) }),
            );
          }}
        >
          {simulation ? 'Start simulated cook' : 'Start timed cook'}
          <Icon name="arrow" size={18} />
        </button>
        <button className="button secondary full" onClick={() => setReviewing(false)}>
          Back to the kitchen
        </button>
      </dialog>
      {aboutOpen && (
        <InfoModal title="Your kitchen, in your browser." close={() => setAboutOpen(false)}>
          <p>
            Joule Kitchen connects this browser directly to your Joule Turbo BSV600 over Bluetooth.
          </p>
          <p>
            Recordings stay in this browser on this device. Export CSV to keep a copy. Clearing site
            data removes recordings.
          </p>
          <p>
            Keep this page open to record. A sleeping device, background tab or lost connection can
            create gaps. The graph never fills those gaps with invented temperatures.
          </p>
          <p>
            The manual controller is experimental and uses a timed program for firmware 1.9.23 /
            2.5.2. Native Turbo recipes are not supported here.
          </p>
          <a className="button secondary" href={SOURCE} target="_blank" rel="noreferrer">
            Source, tests &amp; protocol notes ↗
          </a>
        </InfoModal>
      )}
      {deleteOpen && (
        <InfoModal title="Delete this recording?" close={() => setDeleteOpen(false)}>
          <p>This removes this recording and its readings from this browser.</p>
          <button
            className="button stop-button full"
            onClick={() =>
              void perform(async () => {
                await store.remove(selectedId);
                setSelectedId('live');
                setDeleteOpen(false);
                refreshRecordings();
              })
            }
          >
            Delete recording
          </button>
        </InfoModal>
      )}
    </div>
  );
}

function InfoModal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      className="modal info-modal"
      ref={dialog}
      onCancel={close}
      onClose={close}
      aria-label={title}
    >
      <div className="modal-heading">
        <span className="eyebrow">JOULE KITCHEN</span>
        <button className="icon-button" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
