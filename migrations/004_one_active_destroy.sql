-- Destroy is exempt from the one-active-operation rule, but two Destroys of the same
-- container at once would delete its service twice.
CREATE UNIQUE INDEX operations_one_active_destroy_per_container
  ON operations (container_id)
  WHERE status IN ('pending', 'in_progress') AND kind = 'destroy';
