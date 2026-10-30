-- Authored by hand (not generated), ST-OMNI-006 (OMNI.md 3.1 step 5, BR-OMNI-06, BR-OMNI-08): the routing policies and the canned replies of the tenant. V002 laid down both tables; this guards them:
--   * a routing policy is a version: what it says (the rules, the calendar, the minutes and the hours) never changes, it goes Draft to Published once and Published to Superseded when a later one is published, and it is never deleted. One policy
--     is Published at a time; the conversations keep the version they were routed by (a foreign key from `conversation.routing_policy_id`);
--   * a canned reply keeps its code and its author; it is changed under its version and is never deleted (a reply that is not wanted any more is Retired).

CREATE UNIQUE INDEX conversation_routing_policy_published_uq ON machvon.conversation_routing_policy (tenant_id) WHERE status = 'Published';
CREATE INDEX conversation_routing_policy_created_idx ON machvon.conversation_routing_policy (tenant_id, revision DESC);
ALTER TABLE machvon.conversation ADD FOREIGN KEY (tenant_id, routing_policy_id) REFERENCES machvon.conversation_routing_policy (tenant_id, id);

CREATE FUNCTION machvon.guard_routing_policy() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POLICY_IMMUTABLE: a routing policy is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.revision, NEW.rules_json, NEW.calendar_code, NEW.first_response_minutes, NEW.resolution_hours, NEW.created_by)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.revision, OLD.rules_json, OLD.calendar_code, OLD.first_response_minutes, OLD.resolution_hours, OLD.created_by) THEN
    RAISE EXCEPTION 'POLICY_IMMUTABLE: what a routing policy says does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (('Draft', 'Published'), ('Published', 'Superseded'))) THEN
    RAISE EXCEPTION 'POLICY_STATE_INVALID: a routing policy does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER routing_policy_guard BEFORE UPDATE OR DELETE ON machvon.conversation_routing_policy
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_routing_policy();
REVOKE DELETE, TRUNCATE ON TABLE machvon.conversation_routing_policy FROM machvon_app;

CREATE FUNCTION machvon.guard_canned_reply() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'REPLY_IMMUTABLE: a canned reply is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.code, NEW.created_by) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.code, OLD.created_by) THEN
    RAISE EXCEPTION 'REPLY_IMMUTABLE: the code of a canned reply does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER canned_reply_guard BEFORE UPDATE OR DELETE ON machvon.canned_reply
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_canned_reply();
REVOKE DELETE, TRUNCATE ON TABLE machvon.canned_reply FROM machvon_app;
