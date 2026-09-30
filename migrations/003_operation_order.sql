-- Insertion order of operations. `created_at` cannot order them: two requests can share a
-- timestamp, and then the container's latest operation would be decided by a random id.
ALTER TABLE operations ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

DROP INDEX operations_by_container;
CREATE INDEX operations_by_container ON operations (container_id, seq DESC);
