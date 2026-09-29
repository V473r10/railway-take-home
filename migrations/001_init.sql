-- A container is one Railway service this app created, plus its current deployment.
CREATE TABLE containers (
  id                    uuid PRIMARY KEY,
  -- Fixed prefix plus the id of the create operation (ADR 0004, second layer).
  name                  text NOT NULL UNIQUE,
  -- Null until Railway confirms the service exists.
  service_id            text UNIQUE,
  current_deployment_id text,
  observed_status       text,
  observed_stopped      boolean,
  observed_at           timestamptz,
  -- Origin of the container's lifetime.
  created_at            timestamptz NOT NULL,
  destroyed_at          timestamptz
);

-- An operation is one requested action, recorded before anything is sent to Railway.
CREATE TABLE operations (
  id                     uuid PRIMARY KEY,
  container_id           uuid NOT NULL REFERENCES containers (id),
  kind                   text NOT NULL CHECK (kind IN ('create', 'stop', 'start', 'destroy')),
  status                 text NOT NULL CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed')),
  -- ADR 0004, first layer: the same click sent twice is one operation.
  idempotency_key        text NOT NULL UNIQUE,
  attempts               integer NOT NULL DEFAULT 0,
  last_error             text,
  last_trace_id          text,
  last_outcome_ambiguous boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL
);

-- At most one active operation per container, except that a destroy may always be requested.
CREATE UNIQUE INDEX operations_one_active_per_container
  ON operations (container_id)
  WHERE status IN ('pending', 'in_progress') AND kind <> 'destroy';

CREATE INDEX operations_by_container ON operations (container_id, created_at DESC);
