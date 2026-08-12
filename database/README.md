# n8n database provisioning

This directory records the database setup used by the Render deployment.

## Render PostgreSQL

- Service name: `n8n-postgres`
- PostgreSQL version: `16`
- Region: `oregon`
- Plan used initially: `free`
- Database name assigned by Render: `n8n_postgres_40bf`
- Database user assigned by Render: `n8n_postgres_40bf_user`

The PostgreSQL instance itself was provisioned through Render rather than by executing SQL. Render creates the database and owner automatically.

## n8n schema

Do **not** manually create n8n's internal tables or seed its internal data. n8n owns its schema and runs its database migrations automatically on startup.

Any project-specific SQL that is actually executed manually will be recorded in this directory. Do not commit database passwords, connection URLs, encryption keys, API keys, or other secrets.

See `bootstrap.sql` for the safe SQL bootstrap/documentation script.
