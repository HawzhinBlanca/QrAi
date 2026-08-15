# Immutable database migrations

`manifest.json` is the source checksum boundary for the ordered SQL files in this directory.
Once a migration has shipped, its bytes never change; corrections are new numbered files.
`server/scripts/migrate.mjs` verifies the manifest, takes a Postgres advisory lock, and records the
same checksums in `schema_migrations` inside the transaction that applies each file.

The historical `0002`, `0006`, and `0007` files contain data because they shipped that way and are
therefore still immutable migrations. New environment fixtures do not belong here. The complete
canonical Quran seed remains owned by `packages/quran-data`; restricted-role provisioning is owned
separately by `infra/provision` and `server/scripts/provision-role.mjs`.
