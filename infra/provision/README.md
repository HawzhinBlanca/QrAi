# Restricted application role

Role provisioning is deliberately separate from immutable migrations. Run
`server/scripts/provision-role.mjs` with an administrative `MIGRATION_DATABASE_URL` and the
runtime credential in `APP_DATABASE_PASSWORD`. The script sends the credential as a Postgres
protocol parameter, never interpolates it into JavaScript or shell SQL, and strips superuser,
`BYPASSRLS`, database creation, and role creation privileges on every run.
