# LLM_KILL_SWITCH_SLOW

**Owner:** security-oncall · **Severity:** critical · **Rule:** `alerts/rules/LLM_KILL_SWITCH_SLOW.json`

## What it means

An emergency stop of the AI gateway (LLM-18) needed more than five seconds, from the call to the last request it stopped (BR-LLM-12 holds it to five). New requests are refused as soon as the switch is saved, so the delay is in cancelling what was running: the providers that were asked to cancel answered slowly, or there were very many requests in flight.

## What to do

1. Read `llm_kill_switch_latency_ms{tenant_id}` and the switch in LLM-18: its scope, `affected_requests`, and how many were cancelled and how many are marked to have their answer thrown away.
2. Check the provider that was slow (the attempts of the requests in LLM-05). A provider that cannot cancel leaves its requests `killed_pending`: their answers are discarded when they come, and no output reaches a module.
3. If the scope was too wide for the number of requests in flight, engage narrower switches (a provider, a model, a task) so that less is cancelled at once.
4. A switch is released only by another person, with a reason.
