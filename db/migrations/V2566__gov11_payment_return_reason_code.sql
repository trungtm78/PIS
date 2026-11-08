-- Authored by hand (not generated): the standard reason of a returned payment request (GOV-11a, G1-17).
-- The free words of the return (`return_reason`) stay; the code names the reason in the list of the governance rule `PAYMENT_RETURN_REASON`, so the returns can be counted by reason. Additive and nullable: a request
-- returned before this change has no code and is counted apart. The code is a label of the rule (the application checks it against the catalogue in force that day); the database keeps its shape and nothing more: a request that was returned keeps the code of its last return when it is corrected and sent again, as it keeps the words.

ALTER TABLE machvon.payment_request ADD COLUMN return_reason_code text;
ALTER TABLE machvon.payment_request
  ADD CONSTRAINT payment_request_return_reason_code_chk CHECK (return_reason_code IS NULL OR (return_reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'));

COMMENT ON COLUMN machvon.payment_request.return_reason_code IS 'GOV-11a G1-17: the code of the standard reason of the return (rule PAYMENT_RETURN_REASON); null for a request that was not returned or was returned before the list.';
