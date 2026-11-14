# Validation

CI never pairs with or controls physical hardware.

The app's diagnosis release passed **65 unit/protocol/storage checks** and
**32 Playwright UI checks** (desktop and mobile Chromium) in Docker on macOS/arm64.
The earlier Bluetooth release's 22 UI checks also passed against the direct
Node mock in Chrome on macOS, including automatic server startup.
GitHub Actions is configured to repeat the same suite on Linux before deploying Pages.
The Pages workflow starts the mock directly on its container runner. The
separate Docker workflow builds the images, runs the same UI tests across
containers and checks the mock's published localhost port.

The first Pages publication on November 14, 2026 used a temporary, isolated
Actions runner while GitHub-hosted jobs were queued. That job repeated the
29 unit checks and build, verified byte-for-byte equality with the static
files tested in Docker, and successfully deployed them. The temporary runner
was removed after publication.

An anonymous browser check of the public HTTPS site verified its exact build,
simulator controls, missing-sensor Start guard, separate measured/target graph,
CSV export, recordings after reload and mobile layout, with no page errors.
It sent no commands to physical hardware. The regular hosted CI workflows
remain configured separately; the first publication does not establish that
their queued runs passed.

## Automated checks

`npm run check` typechecks the project, runs Vitest and produces the static
production build. The protocol checks cover exact frame length, UTF-8 across
fragment boundaries, interleaved heartbeats, malformed transfers, manual
program limits, command ordering and cancellation. The independent mock
program interpreter checks the heater-off ending and timer semantics.

The IndexedDB checks reopen a database, retain source and gap information,
export CSV, delete complete sessions and separate real/simulated readings.

`npm run test:docker` runs desktop and mobile Playwright projects against a
separate mock container, including:

- Loading a static page without connecting or starting.
- Pairing, physical-button confirmation, review before Start.
- Manual cook, reported idle after Stop, and the appliance timer ending a run.
- Stop during a delayed upload, without a late LoadRecipeEnd.
- Live graph, separate target, unit conversion, complete CSV download.
- History surviving page reload.
- Disconnect, stale data, reconnect without command replay.
- Truncated frames and recovery on the next valid frame.
- Missing temperature blocks Start while Stop remains available.
- Same-origin access to the local mock service.

Each WebSocket has a separate fake device. The mock processes serializable
GATT reads, writes and notification subscriptions, using independent program
validation rather than returning whatever status the UI expects.

The container has no radio device, host networking or vendor credentials. It
uses a project bridge network and publishes its UI on loopback only. CI checks
that the host can reach this published address, in addition to the tests inside
Docker. The mock makes no appliance or cloud requests. Its HTTP server also
denies Bluetooth through Permissions Policy. Tests use ordinary browser
security settings.

## Connection diagnosis and repair checks

The recovery controller is exercised with a persistent in-memory GATT
peripheral and a synthetic implementation of the browser's native GATT API.
The tests cover:

- Read-only diagnosis and automatic Bluetooth release.
- Exact identity, platform, firmware, hostname format, malformed address and
  inactive network-setup guards.
- Correct addresses, unknown settings and unsupported firmware receiving no
  writes.
- Fresh preflight reads rejecting settings that changed after review.
- One complete acknowledged write of the selected device's own hostname,
  followed by exact readback, without recipe fragments.
- A dropped connection, lost acknowledgement, mismatched readback and hanging
  write producing an unconfirmed result without automatic retries or rollback.
- A fresh, read-only recheck after an uncertain result.
- Cancellation before a write and shared ownership with normal monitoring.
- Diagnostic exports excluding device identifiers and never claiming cloud
  verification.

Desktop and mobile browser tests exercise diagnosis, separate findings and
explicitly untested Wi-Fi/account access before any fix is offered. They
cover the simulated repair review, confirmation, readback, recheck and
diagnostic download, plus healthy/unrecognized/unsupported outcomes,
connection loss and opening diagnosis while monitoring is already connected.

The recovery demo runs inside the browser, including in Docker UI tests, and
never connects to a physical Bluetooth adapter or cloud service. It persists
settings across simulated reconnects; it does not simulate Breville login,
Wi-Fi provisioning or actual certificate rotation.

## Physical validation scope

Direct native BLE status, measured temperature, heartbeat acknowledgement and
the Wi-Fi/Bluetooth reporting handshake were observed on a BSV600 with comm
firmware 1.9.23 and task-engine firmware 2.5.2 before this browser port.

On November 14, 2026, the production static build was opened in Chrome 157
on macOS and paired to the real Joule through its native browser device
chooser. The browser received **26.7°C / idle**, saved two observed samples
in IndexedDB and disconnected after restoring Wi-Fi reporting. No cooking
command was sent, and there were no page errors. This path used no Python
relay, account token, application backend or cloud login.

Two subsequent browser connections read 26.6°C and 26.5°C while the appliance
reported idle. A separate reload check reopened a real recording and rendered
its saved curve. These checks used the device chooser; support for remembering
permissions across browser restarts depends on the browser.

Manual cooking validation on the real appliance remains a separate supervised
check. Successful mock tests do not establish real heater operation or offline
Turbo cooking.

The **server-address repair method** was verified using a native Bluetooth
tool before the browser recovery port. The [recovery record](RECOVERY.md)
describes fresh Breville status, physically observed pump start/stop, home
Wi-Fi reconnection and the correct address surviving a power cycle.
The new browser repair flow has been validated with simulated peripherals;
no malformed setting was reintroduced into the working appliance to exercise
the new browser write. A successful simulated repair is not a new hardware
validation or proof of cloud connectivity.

A physical test must use an attended appliance in water between its MIN/MAX
marks, a prepared brief low-temperature program, independent Stop requests and
a final idle observation. Do not add physical Start calls to ordinary tests.

## Debugging a failed Docker run

```sh
docker compose -f compose.yaml -f compose.test.yaml logs --no-color
mkdir -p artifacts
docker compose -f compose.yaml -f compose.test.yaml cp ui-tests:/app/test-results artifacts/test-results
docker compose -f compose.yaml -f compose.test.yaml cp ui-tests:/app/playwright-report artifacts/playwright-report
npm run test:docker:down
```

GitHub Actions uploads failure screenshots/traces for seven days. These runs
use simulated identifiers and data only. Do not upload traces from real-device
or signed-in browser sessions to public CI artifacts.
