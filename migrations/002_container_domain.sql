-- The container's public Railway domain, created with the service. Null until Railway returns it.
ALTER TABLE containers ADD COLUMN domain text;
