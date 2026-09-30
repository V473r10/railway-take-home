-- When the app found the container's service gone from the sandbox project without
-- having deleted it (someone deleted it from the Railway dashboard). Railway is the
-- truth (Q11): the container stays listed as missing until it is destroyed.
ALTER TABLE containers ADD COLUMN missing_at timestamptz;
