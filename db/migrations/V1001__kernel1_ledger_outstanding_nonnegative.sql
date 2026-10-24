-- Authored by hand (not generated): the ledger lint of ST-KERNEL-072 (AC-ST-KERNEL-072-3) asks every amount column of a ledger
-- table to be guarded by a non-negative CHECK in the database. The two entry tables that carry the outstanding advance after
-- each posting had no such guard: an advance can never be recovered below zero, so a negative value is always a posting error.
-- Both tables are append-only and empty before the first release, so the constraints are validated at once.

ALTER TABLE machvon.advance_ledger_entry ADD CONSTRAINT advance_ledger_entry_outstanding_chk CHECK (outstanding_after_vnd >= 0);
ALTER TABLE machvon.cumulative_ledger_entry ADD CONSTRAINT cumulative_ledger_entry_outstanding_chk CHECK (advance_outstanding_after_vnd >= 0);
