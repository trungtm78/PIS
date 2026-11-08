-- Authored by hand (not generated): indexes for the reads of the bid security register and the subcontracts (VND-2, slice beta).
--   * the list of securities of a package by state (the register filters by package and state, the alert source reads the open ones);
--   * the payment records of a subcontract by the request they follow (the clock of what the prime paid reads them by request).
CREATE INDEX vendor_bid_security_package_state_idx ON machvon.vendor_bid_security (tenant_id, package_id, state);
CREATE INDEX vendor_subcontract_payment_request_paid_idx ON machvon.vendor_subcontract_payment (tenant_id, subcontract_id, payment_request_id);
