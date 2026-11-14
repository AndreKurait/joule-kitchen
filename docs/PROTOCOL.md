# Joule Turbo interoperability notes

This implementation was written from observations of a BSV600 and its normal
Android application protocol. The repository includes the new implementation,
small synthetic test messages and protocol descriptions; it does not include
vendor binaries, application source, firmware, credentials or a device identity.

## Transport

Advertising service: `6e404321-b5a3-f393-e0a9-e50e24dcca9f`.
Names commonly start with `BSV600`. A matching advertisement is not sufficient:
the app reads the platform and serial characteristics and requires matching
BSV600 identity before any application write.

The primary application service is
`c6f2d9e3-49e7-4125-9014-bfc6d669ff00`.

| Characteristic suffix | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `ff01`                | Read serial for identity and physical-button handshake |
| `ff05`                | Proximity/button status and requests                   |
| `ff07`                | Saved server hostname; guarded recovery path only      |
| `ff08`                | Incoming JSON control notifications                    |
| `ff09`                | Outgoing JSON control messages, acknowledged writes    |
| `ff0a`                | Incoming bulk payload fragments                        |
| `ff0b`                | Outgoing recipe payload fragments                      |

The platform string is read from
`8a7f1168-48af-4efb-83b5-e679f932ff04`, in service
`8a7f1168-48af-4efb-83b5-e679f932ff00`. Its observed shape is
`APN3|A0|AZ|EX04|BSV600|1x9x23|<serial>`. This is not an MTU field.

The client uses 20-byte recipe fragments so it does not assume a negotiated
MTU that Web Bluetooth cannot query. JSON frame lengths are UTF-8 byte counts.
Writes are serialized; Stop invalidates the upload generation and receives
priority over queued fragments. A fragment already in flight cannot be
recalled. Start is never automatically retried.

## Pairing and reporting

1. Ask the browser's user-gesture device chooser for a Joule.
2. Connect GATT; validate platform and serial.
3. Subscribe to bulk payloads, JSON messages and proximity status.
4. Send `{"type":5,"payload":{"mode":1}}`.
5. Require `{"type":6,"mode":1,"result":0}`.
6. Send `{"type":16}` (ShadowRequest).
7. Acknowledge each type 14 connection heartbeat with `{"type":15}`.
8. On explicit disconnect restore reporting mode 0 before closing GATT.

Mode 0 is Wi-Fi reporting, 1 is Wi-Fi plus Bluetooth, and 2 is Bluetooth only.
The monitoring/cooking client does not rewrite Wi-Fi profiles, server
addresses or firmware. The separate [recovery controller](RECOVERY.md) can
restore a server address after an explicit review of the exact known fault.
It bypasses the reporting handshake, reads the device's own broker from
`8a7f1168-48af-4efb-83b5-e679f932ff02`, and verifies inactive network setup
before writing. Its complete hostname write is not a fragmented recipe
transfer. Both paths use the same per-device connection lock.

Direct status was observed without an account token on an already provisioned,
Wi-Fi-connected unit. Accountless initial provisioning and fully offline
cooking are separate claims and have not been established by that observation.

Physical cooking confirmation uses `<serial>:connect` on `ff05`. The reported
values are 0 idle, 1 waiting for button, 2 verified, 3 timeout, 4 cancelled, and
5 busy. `<serial>:stop` cancels a pending proximity request. This is separate
from stopping a cook.

## Complete status frames

| Start / End type | Payload              |
| ---------------- | -------------------- |
| 1 / 2            | Device shadow JSON   |
| 7 / 8            | Recipe timeline JSON |
| 18 / 19          | Variable-update JSON |

The start message advertises `len`; payload bytes arrive on `ff0a`; the end
message completes the transfer. Decode only after exact byte count and matching
end type. Truncated, oversized, timed out or malformed frames are discarded.
Heartbeats can interleave with a transfer without resetting its buffer.

The observed full shadow has `state.reported` with:

- `state`: appliance state
- `heaters[id=0].cur_temp`: measured bath temperature in °C
- `heaters[id=0].temp_sp`: requested heater target, possibly null when idle
- `appliance.mode`: 23 ordinary sous vide; 24 native Turbo
- `recipe` and/or `cookUUID`: current program identity
- `firmware.commFirmware` and `firmware.teFirmware`
- `timers` and `errors`

The recorder uses receipt time, stores °C, and treats missing temperatures as
missing. A heartbeat is not a temperature reading. A timeline packet is not
interpreted as a temperature history. The graph labels observed native Turbo
status without estimating food core temperature.

## Manual timed program

Recipe upload: type 3 with `len`, bulk bytes on `ff0b`, then type 4 to commit.
The recipe envelope contains `instructions`, `initialStep: 0`, and
`recipeSource: "manual"`.

The supported program has exactly one stage and one step:

1. Set appliance mode 23.
2. Clear timer 0.
3. Start countdown timer 0, duration in seconds, usage 6, autostart 0.
4. Start heater 0 at the selected Celsius setpoint, preheat 0.
5. Wait for timer 0.
6. Stop heater 0.
7. Clear timer 0.

Run time starts immediately; it includes warm-up. The browser does not perform
a heating feedback loop. Input is limited to 20–90°C and 10 seconds–24 hours.
These are application limits, not a food-safety or doneness model.

Stop uses `{"type":9,"payload":{"reason":1}}`. GATT write completion confirms
transport delivery only. A fresh shadow is needed to observe cooking or idle.
Late cooking status after a requested Stop causes another Stop, not a Start.

## Native Turbo and cloud work still needed

The vendor's Turbo food recipe path takes doneness/setpoint, piece count,
thickness in millimeters and total weight in **milligrams**. Native recipe
compilation also uses food-specific coefficients. A manual setpoint program
cannot be substituted and described as Turbo.

The previously investigated cloud APIs can preview and load native Turbo
recipes for an authorized account, but that transport has not been ported into
this public static client. The ordinary cloud WebSocket uses custom
authorization headers, and the control endpoints' browser CORS preflight was
rejected. Do not work around this by embedding credentials or exposing an
unauthenticated control proxy.

## Primary platform references

- [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)
- [Web Bluetooth API and browser support](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [Browser page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [WebSocket constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)
- [Cross-origin requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
