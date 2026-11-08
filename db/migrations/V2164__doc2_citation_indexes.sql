-- The anchors of a comment and the citation of a text unit lead their indexes with the version (the citation is only unique inside one version of a document); the rule of the catalogue is that every *_id column also leads an index after tenant_id,
-- which serves the lookup of a citation across versions (where a cited passage went). The indexes are not unique: the uniqueness of a citation belongs to its version.
CREATE INDEX document_text_unit_citation_idx ON machvon.document_text_unit (tenant_id, citation_id);
CREATE INDEX document_comment_citation_idx ON machvon.document_comment (tenant_id, citation_id) WHERE citation_id IS NOT NULL;
