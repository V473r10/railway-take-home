-- What happened to each container, one entry per step: a request, each call to Railway
-- and how it ended, each look before repeating a call, what Railway reported, how the
-- operation ended. Written alongside the state it describes, never read to decide it.
CREATE TABLE timeline_entries (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  container_id uuid NOT NULL REFERENCES containers (id),
  -- Null for what happened to the container outside any operation (found missing, say).
  operation_id uuid REFERENCES operations (id),
  at           timestamptz NOT NULL,
  kind         text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX timeline_by_container ON timeline_entries (container_id, seq);
