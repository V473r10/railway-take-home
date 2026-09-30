-- The deployment a Start's redeploy replaces. A Start clears the container's current
-- deployment while it looks for the new one, so without this a process that dies
-- mid-Start leaves the next boot unable to tell the new deployment from the old one.
ALTER TABLE operations ADD COLUMN replaced_deployment_id text;
