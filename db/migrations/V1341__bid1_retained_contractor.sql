-- Authored by hand (not generated): a contractor is kept for good once registered (V1340: an identity is kept, a decision is final, a
-- duplicate goes to the merge in master data, never to a delete). Retention is ten years after its last contract, and only a job that
-- has checked the legal holds may end it. No command deletes a contractor; the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor FROM machvon_app;
