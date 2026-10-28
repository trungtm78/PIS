-- Authored by hand (not generated): the guards under budgets, reservations and price versions of the AI gateway (ST-LLM-003, LLM F3, BR-LLM-05, BR-LLM-13).
-- The baseline index let a tenant budget be made twice for a period: NULLs are distinct for a unique index, and a tenant budget has no scope reference. Now they are one.
-- A reservation is in one of the states of the design. A model has one price version in force (the one with no end) and one price version for a moment.

DROP INDEX machvon.ai_budget_scope_uq;
CREATE UNIQUE INDEX ai_budget_scope_uq ON machvon.ai_budget (tenant_id, scope_kind, coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid), period) WHERE status = 'ACTIVE';
ALTER TABLE machvon.budget_reservation ADD CONSTRAINT budget_reservation_status_chk CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED', 'PENDING_RECONCILE', 'EXCEPTION'));
CREATE UNIQUE INDEX pricing_version_open_uq ON machvon.pricing_version (tenant_id, model_ref_id) WHERE effective_until IS NULL AND model_ref_id IS NOT NULL;
CREATE UNIQUE INDEX pricing_version_from_uq ON machvon.pricing_version (tenant_id, model_ref_id, effective_from) WHERE model_ref_id IS NOT NULL;

-- The baseline check said that cached tokens are never more than the input tokens. That is the meaning of a price that counts them in the input; a price that counts them apart
-- (SEPARATE) is given 20,000 input and 100,000 cached for the same attempt, and the rule belongs to the cost formula, which refuses it for the first meaning (BR-LLM-04).
ALTER TABLE machvon.llm_attempt DROP CONSTRAINT llm_attempt_tokens_chk;
ALTER TABLE machvon.llm_attempt ADD CONSTRAINT llm_attempt_tokens_chk CHECK (input_total >= 0 AND cached_input >= 0 AND output_total >= 0);

-- A request is held once. And the answer that an attempt got when it was settled (what it released, whether it went over, whether it crossed the soft line) is kept with the attempt, so that a repeat of the callback
-- gets the same answer for as long as the attempt exists, whatever happens to the events.
CREATE UNIQUE INDEX budget_reservation_request_uq ON machvon.budget_reservation (tenant_id, request_id);
ALTER TABLE machvon.llm_attempt ADD COLUMN settlement jsonb;
