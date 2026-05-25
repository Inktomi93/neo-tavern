ALTER TABLE `embeddings` ADD `embedding` F32_BLOB(1024);--> statement-breakpoint
-- Hand-added: libSQL native ANN index (drizzle-kit can't emit libsql_vector_idx).
-- Query with vector_top_k('embeddings_ann', vector32(?), k) JOIN embeddings ON rowid.
CREATE INDEX `embeddings_ann` ON `embeddings` (libsql_vector_idx(embedding));