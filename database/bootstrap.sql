-- n8n PostgreSQL bootstrap / audit script
--
-- IMPORTANT:
-- The Render PostgreSQL service, database, and owner are provisioned by Render.
-- n8n creates and migrates its own application tables automatically.
-- Therefore no CREATE DATABASE, CREATE USER, n8n internal CREATE TABLE, or seed INSERT
-- statements were manually executed during initial provisioning.
--
-- Render-provisioned values (non-secret):
--   PostgreSQL: 16
--   Database:   n8n_postgres_40bf
--   Owner/User: n8n_postgres_40bf_user
--
-- Never commit passwords, connection strings containing credentials,
-- N8N_ENCRYPTION_KEY, API keys, OAuth secrets, or tokens.

-- Optional verification commands to run after connecting to the database:
SELECT current_database() AS database_name,
       current_user AS database_user,
       version() AS postgres_version;

-- n8n migrations are intentionally NOT duplicated here.
-- They are version-specific and are executed by n8n itself at startup.

-- Future manually executed project-specific SQL should be appended below with:
--   * date/time
--   * purpose
--   * exact SQL
--   * whether it was executed successfully

-- Executed manual INSERT statements so far: NONE.
