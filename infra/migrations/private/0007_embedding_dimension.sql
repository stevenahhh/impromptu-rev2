SET ROLE impromptu_owner;

ALTER TABLE private_app.deck_retrieval_chunks
  DROP CONSTRAINT deck_retrieval_chunks_embedding_check,
  ADD CONSTRAINT deck_retrieval_chunks_embedding_dimension_check
    CHECK (cardinality(embedding) = 768);
