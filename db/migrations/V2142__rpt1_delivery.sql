-- Authored by hand (not generated): what happened when an issued report copy went to a receiver (RPT-1 part 2, eng-review R17 and R18, docs/report-engine.md "Delivery").
-- `report_delivery` is an append-only log of events, one row each, never updated or deleted:
--   * DELIVERED: the copy was handed to the receiver by a channel; one per (copy, receiver), so a repeat push of the same bytes is ALREADY_DELIVERED (the unique key is the last word under concurrency);
--   * ACCEPTED or REJECTED: the receiver's answer, one per (copy, receiver). The database refuses an ACCEPTED row for a copy made on a DEMO form (R18): a demo copy is shown, never accepted.
-- Stale deliveries (a copy replaced by a later revision, or older than what the receiver accepted) are refused by the application before a row is written (REPORT_OUT_OF_DATE).

CREATE TABLE machvon.report_delivery (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  layout_code text NOT NULL,
  period_code text NOT NULL,
  revision integer NOT NULL,
  sha256 char(64) NOT NULL,
  receiver text NOT NULL,
  channel text NOT NULL,
  event text NOT NULL,
  reference text,
  note text,
  counts_as_accepted boolean NOT NULL,
  recorded_by uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  CONSTRAINT report_delivery_event_chk CHECK (event IN ('DELIVERED', 'ACCEPTED', 'REJECTED')),
  CONSTRAINT report_delivery_channel_chk CHECK (channel IN ('MANUAL', 'DOWNLOAD', 'EMAIL', 'PORTAL', 'HPM_PUSH')),
  CONSTRAINT report_delivery_receiver_chk CHECK (receiver ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$'),
  CONSTRAINT report_delivery_hash_chk CHECK (sha256 ~ '^[0-9a-f]{64}$' AND revision >= 1),
  CONSTRAINT report_delivery_text_chk CHECK ((reference IS NULL OR (reference = btrim(reference) AND char_length(reference) BETWEEN 1 AND 200)) AND (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 2000))),
  CONSTRAINT report_delivery_accept_chk CHECK (event <> 'ACCEPTED' OR counts_as_accepted),
  CONSTRAINT report_delivery_once_uq UNIQUE (tenant_id, issue_id, receiver, event)
);
CREATE INDEX report_delivery_series_idx ON machvon.report_delivery (tenant_id, layout_code, period_code, receiver, occurred_at DESC);
CREATE INDEX report_delivery_recent_idx ON machvon.report_delivery (tenant_id, occurred_at DESC, id DESC);

CREATE FUNCTION machvon.report_delivery_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  copy machvon.report_issue%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the delivery log is append-only' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO copy FROM machvon.report_issue WHERE tenant_id = NEW.tenant_id AND id = NEW.issue_id;
  IF NOT FOUND OR copy.layout_code <> NEW.layout_code OR copy.period_code <> NEW.period_code OR copy.revision <> NEW.revision OR copy.sha256 <> NEW.sha256 THEN
    RAISE EXCEPTION 'a delivery row names the copy it is about, with its series, revision and hash' USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'ACCEPTED' AND NOT copy.counts_as_accepted THEN
    RAISE EXCEPTION 'a copy made on a demo form is never accepted' USING ERRCODE = '23514';
  END IF;
  IF NEW.counts_as_accepted <> copy.counts_as_accepted THEN
    RAISE EXCEPTION 'whether a delivery counts as accepted is the property of the copy' USING ERRCODE = '23514';
  END IF;
  IF NEW.event <> 'DELIVERED' AND NOT EXISTS (SELECT 1 FROM machvon.report_delivery d WHERE d.tenant_id = NEW.tenant_id AND d.issue_id = NEW.issue_id AND d.receiver = NEW.receiver AND d.event = 'DELIVERED') THEN
    RAISE EXCEPTION 'a receiver answers a copy that was delivered to it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.report_delivery FOR EACH ROW EXECUTE FUNCTION machvon.report_delivery_guard();

ALTER TABLE machvon.report_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_delivery AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_delivery AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.report_delivery FROM machvon_app;

COMMENT ON TABLE machvon.report_delivery IS 'RPT-1: the log of deliveries of issued report copies to receivers and their answers; append-only; a demo copy is never accepted (R18).';
