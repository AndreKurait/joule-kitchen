# Guided cleaning

Select **Clean → Clean Joule** for preparation, review, a timed vinegar bath,
and cooling/rinsing instructions. Opening the guide sends no device commands.
Pair in the kitchen, enable cleaning controls, and confirm with the Joule's
top button before reviewing and starting.

The guide uses equal parts water and **distilled white vinegar** in a small,
food-free pot. Keep the Joule upright with liquid between MIN and MAX and
the top and cord dry.

## The preset

This is the **extended cleaning option**: **60°C / 140°F for 30 minutes from
Start**, including warm-up. It is separate from the manual cook form's
temperature and duration. The submitted program includes an appliance-owned
timer and an explicit heater-off ending. Closing the guide or browser does
not send Stop. Stay nearby; **Stop cleaning** is available during the run.

The manufacturer's routine procedure finishes when the bath reaches
60°C / 140°F. Its longer 20–30 minute option is for buildup or circulation
problems. The guide explains this distinction; the website does not claim
that every routine clean needs 30 minutes, or that it automatically stops
as soon as the target temperature is reached.

## Finishing

The guide follows the submitted recipe UUID and device identity. It shows
the rinse steps only after observing that program and a subsequent idle
reading, or after a requested Stop is confirmed. A browser countdown, stale
reading or disconnect cannot establish that the appliance stopped.

Another program ends tracking of the cleaning cycle. The guide never
automatically starts or retries cleaning. Reopening or reconnecting cannot
replay Start.

After the Joule stops, unplug it and leave it in the bath to cool before
handling. Rinse the wetted lower section with fresh water, wipe the outside,
and let it dry. Keep the top and cord dry; never completely immerse it or put
it in a dishwasher. Finish the guide after these steps.

## Sources and validation

- [Breville Joule Turbo BSV600 US manual](https://assets.breville.com/BSV600/BSV600_USCM_SG3_D24_LR.pdf#page=36), illustrated care steps on pages 36–37 and handling precautions on page 4.
- [Manufacturer's “How do I clean Joule?” guide](https://support.chefsteps.com/hc/en-us/articles/214090878-How-do-I-clean-Joule), including the longer bath for buildup.

Checked November 14, 2026. The Turbo manual's diagrams were visually reviewed.
This flow reuses the experimental manual controller and its existing
firmware, idle-state, fresh-reading and physical-button guards. Automated
tests use simulated appliances; no physical cleaning cycle was run to
validate this feature. See [TESTING.md](TESTING.md).
