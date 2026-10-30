-- Authored by hand (not generated), ST-OMNI-002 (OMNI.md 3.5, BR-OMNI-05): the contact directory. V002 laid down `contact` and `contact_identity` (unique by tenant, channel and hash of the identity; Verified means a method and a moment); this adds what verification needs
-- and guards both tables:
--   * an identity keeps the hash of a code that was sent for it, when it runs out, the wrong codes counted and the lock (never the code), the reference of the document that verified it, a version and when it was added;
--   * what an identity is (contact, channel, hash, masked copy) never changes; its state only moves from Pending to Verified or to Revoked (a Verified identity cannot be Revoked: V002 ties Verified to the method and the moment, and revoking one is not an operation of this story); a verified identity keeps the method and the moment that verified it;
--   * a contact is kept (never deleted), moves Unverified to Verified to Merged (or Blocked), and a contact that was merged is not changed again; the display name and the class are written once (the directory is not a place to rewrite who someone is);
--   * a contact that was merged cannot be merged into a contact that was itself merged (the chain of merges ends in a live contact), and only the contact it points to may change, when that one is merged in its turn.

ALTER TABLE machvon.contact_identity ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.contact_identity ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE machvon.contact_identity ADD COLUMN otp_hash char(64);
ALTER TABLE machvon.contact_identity ADD COLUMN otp_expires_at timestamptz;
ALTER TABLE machvon.contact_identity ADD COLUMN otp_failed_count integer NOT NULL DEFAULT 0 CHECK (otp_failed_count >= 0);
ALTER TABLE machvon.contact_identity ADD COLUMN otp_locked_until timestamptz;
ALTER TABLE machvon.contact_identity ADD COLUMN verification_ref text;
ALTER TABLE machvon.contact_identity ADD CONSTRAINT contact_identity_otp_ck CHECK ((otp_hash IS NULL) = (otp_expires_at IS NULL));
ALTER TABLE machvon.contact_identity ADD CONSTRAINT contact_identity_masked_ck CHECK (external_id_masked <> '' AND length(external_id_masked) <= 210);

CREATE FUNCTION machvon.guard_contact_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONTACT_IMMUTABLE: an identity is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.contact_id, NEW.channel, NEW.external_id_hash, NEW.external_id_masked, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.contact_id, OLD.channel, OLD.external_id_hash, OLD.external_id_masked, OLD.created_at) THEN
    RAISE EXCEPTION 'CONTACT_IMMUTABLE: what an identity is does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (('Pending', 'Verified'), ('Pending', 'Revoked'))) THEN
    RAISE EXCEPTION 'CONTACT_STATE_INVALID: an identity does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Pending' AND (NEW.verification_method, NEW.verified_at, NEW.verified_by, NEW.verification_ref) IS DISTINCT FROM (OLD.verification_method, OLD.verified_at, OLD.verified_by, OLD.verification_ref) THEN
    RAISE EXCEPTION 'CONTACT_IMMUTABLE: what verified an identity does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER contact_identity_guard BEFORE UPDATE OR DELETE ON machvon.contact_identity
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contact_identity();
REVOKE DELETE, TRUNCATE ON TABLE machvon.contact_identity FROM machvon_app;

CREATE FUNCTION machvon.guard_contact() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONTACT_IMMUTABLE: a contact is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.display_name, NEW.classification, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.display_name, OLD.classification, OLD.created_at) THEN
    RAISE EXCEPTION 'CONTACT_IMMUTABLE: who a contact is does not change' USING ERRCODE = '23514';
  END IF;
  -- A contact that was merged is not changed again, but for the contact it points to: when that one is merged in its turn, what pointed to it is brought to the survivor (the chain is one step long).
  IF OLD.status = 'Merged' AND NOT (NEW.status = 'Merged' AND NEW.merged_into_id IS NOT NULL) THEN
    RAISE EXCEPTION 'CONTACT_IMMUTABLE: a contact that was merged is not changed again' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('Unverified', 'Verified'), ('Unverified', 'Merged'), ('Verified', 'Merged'), ('Unverified', 'Blocked'), ('Verified', 'Blocked'), ('Blocked', 'Verified'), ('Blocked', 'Unverified'))) THEN
    RAISE EXCEPTION 'CONTACT_STATE_INVALID: a contact does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.merged_into_id IS NOT NULL AND EXISTS (SELECT 1 FROM machvon.contact c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.merged_into_id AND c.status = 'Merged') THEN
    RAISE EXCEPTION 'CONTACT_STATE_INVALID: a contact is merged into a live contact' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER contact_guard BEFORE UPDATE OR DELETE ON machvon.contact
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contact();
REVOKE DELETE, TRUNCATE ON TABLE machvon.contact FROM machvon_app;

-- The list (newest first) and the lookup of the contacts a contact was merged from.
CREATE INDEX contact_page_idx ON machvon.contact (tenant_id, created_at DESC, id DESC);
