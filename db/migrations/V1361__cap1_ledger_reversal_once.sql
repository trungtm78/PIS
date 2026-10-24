-- Authored by hand (not generated): an entry of the capital ledger is reversed once (docs/money-integrity.md, "Entries and reversals").
-- V002 gave the other entry ledgers (cumulative_ledger_entry, advance_ledger_entry) the unique partial index on (tenant_id, reversal_of_id)
-- and left capital_ledger_entry with a plain index. The publication of a revision of an appropriation (ST-CAP-001) is the first writer of
-- a REVERSAL here; the allocation, reduction and transfer commands that follow post reversals too, and the database, not each command's
-- read-then-insert, is what keeps a second reversal of the same entry from cancelling capital twice.

CREATE UNIQUE INDEX capital_ledger_entry_reversal_uq ON machvon.capital_ledger_entry (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;
