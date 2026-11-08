-- The ledgers of the bank account of a contractor and of a restriction case name the person who acted. The rule of the catalogue is that every *_id column leads an index after tenant_id;
-- this serves the question what one person did on the accounts and on the cases of the register.
CREATE INDEX bank_event_actor_idx ON machvon.contractor_bank_event (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX restriction_case_event_actor_idx ON machvon.restriction_case_event (tenant_id, actor_id, occurred_at DESC);
