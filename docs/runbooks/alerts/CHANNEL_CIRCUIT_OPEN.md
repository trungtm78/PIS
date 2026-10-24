# CHANNEL_CIRCUIT_OPEN

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/CHANNEL_CIRCUIT_OPEN.json`

## What it means

The circuit breaker of a channel account has stayed open for ten minutes (BR-NOT-16). It opens after 20 failed sends in a minute, rejects sends for two minutes, then lets one send through to test the provider (half open); a success closes it, a failure opens it again. While it is open the sends of that account wait in the queue (NOT-11) without using up their five attempts. The alert names the tenant, the channel account and the channel, once per opening.

## What to do

1. Open NOT-11 and filter on `Queued`: the sends of the channel are waiting, not lost.
2. Check the provider: its status page, the credential of the channel account (`CredentialExpired`), the endpoint of the adapter and the network path.
3. Once the provider answers, the next probe closes the circuit by itself; nothing needs to be restarted. If the probes keep failing, look at the error codes on NOT-12 for the sends that failed.
4. A message that cannot wait (a CRITICAL message) falls back to the next channel of its plan only after its own five attempts; if the provider will be down for long, cancel the waiting sends (`cancelNotification`) or fix the plan of the workflow.
