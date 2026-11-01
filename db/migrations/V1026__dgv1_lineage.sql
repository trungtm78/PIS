-- Authored by hand (not generated): the lineage graph (ST-DGV-006, DGV.md F5).
-- V002 gave the nodes and the edges, with the foreign keys of an edge to its two nodes of the tenant; what the graph stands on is put into the database here, whatever the application checked first:
--   * a node is one thing, named by its kind, its module and the id or the key of what it stands for: V002's unique index does not see two nodes with no id (a null is not equal to a null), so the identity is
--     indexed with the nulls turned into values, and a node names an id or a key at least;
--   * the graph is a record of what was observed: a node and an edge are written once and never changed or deleted (an edge is one for each pair of nodes and each version of the transform, the same batch posted again
--     adds nothing), and an edge joins two different nodes.

ALTER TABLE machvon.lineage_node
  ADD CONSTRAINT lineage_node_ref_chk CHECK (ref_id IS NOT NULL OR nullif(btrim(coalesce(ref_key, '')), '') IS NOT NULL) NOT VALID,
  ADD CONSTRAINT lineage_node_name_chk CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200) NOT VALID;

CREATE UNIQUE INDEX lineage_node_identity_uq ON machvon.lineage_node (tenant_id, node_kind, ref_module, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(ref_key, ''));

ALTER TABLE machvon.lineage_edge ADD CONSTRAINT lineage_edge_transform_chk CHECK (char_length(btrim(transform_version)) BETWEEN 1 AND 80) NOT VALID;

CREATE FUNCTION machvon.guard_lineage() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lineage graph is a record: % on %.% by % is refused', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER lineage_node_guard BEFORE UPDATE OR DELETE ON machvon.lineage_node
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_lineage();
CREATE TRIGGER lineage_node_no_truncate BEFORE TRUNCATE ON machvon.lineage_node
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_lineage();
CREATE TRIGGER lineage_edge_guard BEFORE UPDATE OR DELETE ON machvon.lineage_edge
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_lineage();
CREATE TRIGGER lineage_edge_no_truncate BEFORE TRUNCATE ON machvon.lineage_edge
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_lineage();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.lineage_node FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.lineage_edge FROM machvon_app;
