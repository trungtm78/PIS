-- ST-LLM-007 (LLM.md F6, BR-LLM-11, LLM-16, UAT-AC467, UAT-AC14): knowledge collections, the items indexed into them and the chunks of the items, with the embedding of each chunk.
-- V002 gave the three tables their columns. What retrieval stands on is put into the database here, whatever the application checked first: a chunk is the tenant's and its collection's, an item is indexed
-- under the ACL it was indexed with, and a collection never changes what it was made with.

ALTER TABLE machvon.ai_knowledge_item
  ADD COLUMN acl_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN classification text,
  ADD COLUMN failure_code text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE machvon.ai_knowledge_collection
  ADD CONSTRAINT ai_knowledge_collection_text_chk CHECK (char_length(btrim(code)) BETWEEN 2 AND 60 AND char_length(btrim(title)) BETWEEN 2 AND 300 AND char_length(btrim(subject_module)) BETWEEN 2 AND 10) NOT VALID;

ALTER TABLE machvon.ai_knowledge_item
  ADD CONSTRAINT ai_knowledge_item_class_chk CHECK (classification IS NULL OR classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE')) NOT VALID,
  ADD CONSTRAINT ai_knowledge_item_indexed_chk CHECK (status <> 'INDEXED' OR (indexed_at IS NOT NULL AND chunk_count > 0 AND classification IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT ai_knowledge_item_hash_chk CHECK (acl_hash ~ '^[0-9a-f]{64}$') NOT VALID;

ALTER TABLE machvon.ai_chunk
  ADD CONSTRAINT ai_chunk_hash_chk CHECK (acl_hash ~ '^[0-9a-f]{64}$' AND text_sha256 ~ '^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT ai_chunk_position_chk CHECK (chunk_no >= 0) NOT VALID;

-- A chunk belongs to an item of its collection, an item to a collection and to a document version of the same tenant.
ALTER TABLE machvon.ai_knowledge_item
  ADD CONSTRAINT ai_knowledge_item_collection_fk FOREIGN KEY (tenant_id, collection_id) REFERENCES machvon.ai_knowledge_collection (tenant_id, id),
  ADD CONSTRAINT ai_knowledge_item_version_fk FOREIGN KEY (tenant_id, document_version_id) REFERENCES machvon.document_version (tenant_id, id);
ALTER TABLE machvon.ai_chunk
  ADD CONSTRAINT ai_chunk_item_fk FOREIGN KEY (tenant_id, collection_id, document_version_id) REFERENCES machvon.ai_knowledge_item (tenant_id, collection_id, document_version_id);


-- The nearest-neighbour index of the embeddings. It exists where pgvector does (the TEST profile keeps the vectors as plain arrays, which no such index serves); the retrieval puts the tenant and the
-- collection in front of the distance either way.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE INDEX ai_chunk_embedding_hnsw ON machvon.ai_chunk USING hnsw (embedding vector_cosine_ops)';
  END IF;
END $$;

-- A collection keeps what it was made with; it moves ACTIVE <-> REINDEXING and ends RETIRED.
CREATE FUNCTION machvon.guard_ai_knowledge_collection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a knowledge collection is kept for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code OR NEW.subject_module IS DISTINCT FROM OLD.subject_module
     OR NEW.embedding_model_id IS DISTINCT FROM OLD.embedding_model_id OR NEW.max_classification IS DISTINCT FROM OLD.max_classification OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'what a knowledge collection was made with does not change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'RETIRED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a retired knowledge collection stays retired' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_knowledge_collection_guard BEFORE UPDATE OR DELETE ON machvon.ai_knowledge_collection
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_knowledge_collection();
CREATE TRIGGER ai_knowledge_collection_no_truncate BEFORE TRUNCATE ON machvon.ai_knowledge_collection
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_ai_knowledge_collection();

-- An item stays the item of its document version in its collection; it is indexed, reindexed, failed or removed, and a removed one is not indexed again.
CREATE FUNCTION machvon.guard_ai_knowledge_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a knowledge item is removed by its status, it is not deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.collection_id IS DISTINCT FROM OLD.collection_id OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id THEN
    RAISE EXCEPTION 'what a knowledge item belongs to does not change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REMOVED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a removed knowledge item stays removed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_knowledge_item_guard BEFORE UPDATE OR DELETE ON machvon.ai_knowledge_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_knowledge_item();
CREATE TRIGGER ai_knowledge_item_no_truncate BEFORE TRUNCATE ON machvon.ai_knowledge_item
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_ai_knowledge_item();

REVOKE DELETE, TRUNCATE ON TABLE machvon.ai_knowledge_collection FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.ai_knowledge_item FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.ai_chunk FROM machvon_app;
