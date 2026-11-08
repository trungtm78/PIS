-- The findings of the independence check and the financial periods name the person who decided or verified them. These serve the question what one person decided or verified (the maker-checker review of the audit).
CREATE INDEX vendor_independence_finding_decider_idx ON machvon.vendor_independence_finding (tenant_id, decided_by, decided_at DESC) WHERE decided_by IS NOT NULL;
CREATE INDEX vendor_financial_period_verifier_idx ON machvon.vendor_financial_period (tenant_id, verified_by, verified_at DESC) WHERE verified_by IS NOT NULL;
