-- Authored by hand (not generated): the guards of administrative succession (ST-MDM-009, MDM 3.1 F3, BR-MDM-07).
-- V002 gave master_succession its columns, its unique (predecessor, successor, date) and its foreign keys. A succession is a fact about
-- the law (a province merged, a district abolished) that reports of earlier years are read against for good, so the database holds what the
-- application checked first:
--   * the shares: only a SPLIT has one, and it is strictly between 0 and 100;
--   * a predecessor hands over by one kind of succession on a date, and only a SPLIT has more than one successor;
--   * the shares of a SPLIT on a date add up to exactly 100 when the transaction ends (checked once, after all the edges of the split are in);
--   * an edge is never changed or removed by the runtime role: a mistake is corrected by a later succession, never by rewriting history.

ALTER TABLE machvon.master_succession ADD CONSTRAINT master_succession_share_kind_chk CHECK ((succession_kind = 'SPLIT') = (share_pct IS NOT NULL));
ALTER TABLE machvon.master_succession ADD CONSTRAINT master_succession_share_range_chk CHECK (share_pct IS NULL OR (share_pct > 0 AND share_pct < 100));

-- Only a split leaves one entry for several: any other kind has one successor per predecessor and date.
CREATE UNIQUE INDEX master_succession_single_uq ON machvon.master_succession (tenant_id, predecessor_record_id, effective_date) WHERE succession_kind <> 'SPLIT';

CREATE FUNCTION machvon.master_succession_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM machvon.master_succession
     WHERE tenant_id = NEW.tenant_id AND predecessor_record_id = NEW.predecessor_record_id AND effective_date = NEW.effective_date
       AND succession_kind <> NEW.succession_kind
  ) THEN
    RAISE EXCEPTION 'an entry hands over by one kind of succession on a date' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER master_succession_guard BEFORE INSERT ON machvon.master_succession
  FOR EACH ROW EXECUTE FUNCTION machvon.master_succession_guard();

CREATE FUNCTION machvon.master_succession_split_total() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  total numeric;
BEGIN
  SELECT sum(share_pct) INTO total FROM machvon.master_succession
   WHERE tenant_id = NEW.tenant_id AND predecessor_record_id = NEW.predecessor_record_id AND effective_date = NEW.effective_date AND succession_kind = 'SPLIT';
  IF total IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'the shares of a split add up to 100 percent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$fn$;

-- Deferred: the edges of one split are written one after the other, and the total is judged when the transaction ends.
CREATE CONSTRAINT TRIGGER master_succession_split_total AFTER INSERT ON machvon.master_succession
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.succession_kind = 'SPLIT')
  EXECUTE FUNCTION machvon.master_succession_split_total();

-- Kept for good (retention: permanent): the runtime role adds edges and reads them, nothing else.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.master_succession FROM machvon_app;
