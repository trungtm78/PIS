-- Authored by hand (not generated): indexes for the measurement of the accuracy of the forecasts (GOV-11, G1-16).
-- The accuracy of an investor compares, for each project and month, the last forecast made before the month (the history of `disbursement_schedule_line` is kept: a revision never overwrites) with
-- what the Treasury paid in it. Both reads go by project and month, so both get an index that starts with the tenant and leads with the project.

CREATE INDEX IF NOT EXISTS disbursement_schedule_forecast_history_idx
  ON machvon.disbursement_schedule_line (tenant_id, project_id, plan_year, month, bucket, budget_level, revision DESC)
  WHERE kind = 'FORECAST' AND granularity = 'MONTH';

CREATE INDEX IF NOT EXISTS treasury_transaction_project_confirmed_idx
  ON machvon.treasury_transaction (tenant_id, project_id, confirmed_at);
