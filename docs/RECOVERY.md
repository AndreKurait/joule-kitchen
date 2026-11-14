# Recovering a stuck Joule Turbo connection

Joule Kitchen includes a guided Bluetooth check and a narrowly scoped repair
for **one verified server-address fault**. Open the site's **Recovery**
section, then select **Open recovery**.

This is the fault that made our Joule Turbo appear bricked. Restoring a setting
recovered it; its firmware did not need to be replaced. The browser repair is
experimental: the repair method was verified using a native Bluetooth tool,
and the browser implementation has been tested with simulated peripherals.
Do not deliberately corrupt a working appliance to test recovery.

## What happened

On November 13, 2026, Central time, the investigated BSV600 still answered
Bluetooth reads and joined Wi-Fi, but Breville+ could not finish connecting.
The saved server address was the single byte `04`, rather than a hostname.
A decrypted capture of the owned appliance's traffic showed a DNS query
containing that byte and an NXDOMAIN response.

A controlled diagnostic write of `03` changed the DNS query to `03`.
This established that the setting was being used as literal hostname bytes,
not a numeric server selector. Neither number is a valid replacement address.

The device also exposed its expected cloud broker hostname in a read-only
characteristic. Writing that complete, unchanged hostname to the saved
server-address characteristic and reconnecting an existing Wi-Fi profile
allowed certificate rotation and live status to resume.

Verification included:

- Fresh temperature and idle status through the normal Breville connection.
- A supervised 30°C start and stop, with the owner observing the pump.
- Reconnection on the saved home Wi-Fi network with the phone hotspot off.
- The correct hostname and live cloud status after unplugging and restarting.

The device retained communication firmware **1.9.23** and task-engine
firmware **2.5.2**. No appliance firmware was flashed. The available historical
logs do not identify which earlier command first wrote the malformed setting;
the evidence establishes the fault and recovery, not attribution to a
particular agent, Mac setting, or app version.

## Use the recovery tool

1. Finish any cook. Leave the Joule plugged in and nearby, and close Breville+
   or another app using its Bluetooth connection. Disconnect the kitchen's
   monitoring session if one is open.
2. Select **Open recovery → Check my Joule** in a browser that supports
   Web Bluetooth, then select the appliance in the browser's device picker.
3. Read the result. This first check only reads settings, then releases
   Bluetooth. A matching address needs no repair. An unknown device, firmware,
   address format or fault does not get a repair button.
4. If the exact known fault is found, select **Review the repair**. The tool
   shows the saved address and the built-in hostname from that same device.
   Confirm that the Joule is not cooking, then select **Restore server address**.
5. The tool reconnects, checks every precondition again, writes the complete
   hostname once and reads it back. It then releases Bluetooth.
6. After a matching readback, unplug the Joule for 10 seconds and plug it back
   in without holding its button. Keep Breville+ closed while selecting
   **Recheck saved address**.
7. Open Breville+ and verify that it reconnects and shows fresh status. Complete
   Wi-Fi/account setup there if needed. The original hardware recovery also
   reconnected a saved network profile; this website does not perform that step.

**An address readback is not proof of cloud connectivity.** The browser does
not sign in to Breville or observe its authenticated cloud state. The follow-up
check reads the address on a new Bluetooth connection; it cannot independently
prove that a physical power cycle occurred.

If a write times out or Bluetooth disconnects, the result is **unconfirmed**.
Use **Recheck saved address**, which only reads. The tool never automatically
retries a write, and never restores the malformed `04` value as a rollback.
If a new check still finds the exact fault, another repair requires a new review.

## Exact repair scope

All these conditions must hold before a write:

| Read from the selected device       | Required value                                                    |
| ----------------------------------- | ----------------------------------------------------------------- |
| Serial and platform identity        | Matching serial fields                                            |
| Platform and communication firmware | `APN3\|A0\|AZ\|EX04\|BSV600\|1x9x23\|<serial>`                    |
| Built-in broker                     | Complete ASCII ATS hostname in `iot.us-west-2.amazonaws.com`      |
| Saved server address                | Exactly one byte, `04`                                            |
| Network setup control               | Exactly `00`, inactive                                            |
| Fresh preflight reads               | Identical identity, platform, broker, address and network control |

The replacement comes from the selected Joule. There is no hardcoded owner
hostname, editable server field, numeric selector, normalization, or arbitrary
GATT console. Other broker regions and platform versions are intentionally
outside the verified write scope.

The recovery path bypasses the normal application reporting handshake, which
did not finish on the malfunctioning appliance. It does not subscribe to
application messages, start the heater or pump, change Wi-Fi credentials,
reset the appliance, or upload firmware.

It cannot repair a device that no longer answers Bluetooth, damaged hardware
or firmware, account registration, Wi-Fi coverage, or an unrelated cloud
outage. A healthy server address is reported as **already matching**, not as a
claim that every part of the appliance is healthy.

## Bluetooth characteristics

| Service                                | Characteristic | Recovery use                                        |
| -------------------------------------- | -------------- | --------------------------------------------------- |
| `c6f2d9e3-49e7-4125-9014-bfc6d669ff00` | `…ff01`        | Read identity                                       |
| `8a7f1168-48af-4efb-83b5-e679f932ff00` | `…ff04`        | Read platform/firmware/identity                     |
| `8a7f1168-48af-4efb-83b5-e679f932ff00` | `…ff02`        | Read the device's built-in broker                   |
| `c6f2d9e3-49e7-4125-9014-bfc6d669ff00` | `…ff07`        | Read the saved address; one reviewed hostname write |
| `a9d7166a-d72e-40a9-a002-48044cc30100` | `…0101`        | Read whether network setup is inactive              |

The hostname is a **single complete acknowledged GATT write**, without a
terminator. Do not split it into the 20-byte chunks used by the separate recipe
protocol. If the browser/device cannot deliver that write, the tool stops and
offers a read-only recheck.

## Preview and diagnostics

**Preview with a simulated fault** exercises the same recovery controller
without a real appliance. It includes a correct address, unsupported firmware,
an unrecognized setting and a connection lost after a write. Simulated
addresses are retained across the demo's Bluetooth reconnects.

Downloadable JSON reports contain the diagnostic result and address readback
status. They exclude serial/device identifiers, Wi-Fi credentials and account
data, and explicitly record that cloud connectivity was not verified. Reports
are generated in the browser; nothing is automatically uploaded.

See [testing](TESTING.md) for automated coverage and the separate physical
validation scope. No private radio capture, account session, appliance identity,
vendor APK or firmware image is distributed with this project.
