-- Authored by hand (not generated): an exception to a ceiling of disbursement holds from the day it is asked for (Vietnamese time) to the day it lapses, never the other way round (G4-2, G4-5, lane D).
-- The command refuses a day in the past and one beyond the days the rule PAYMENT_INTEGRITY allows; this keeps the table honest for whoever else writes to it.

ALTER TABLE machvon.disbursement_exception
  ADD CONSTRAINT disbursement_exception_window_chk CHECK (valid_to >= ((requested_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date));
