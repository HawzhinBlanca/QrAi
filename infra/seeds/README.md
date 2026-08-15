# Seed boundary

Environment fixtures and the complete canonical Quran corpus are not migration-runner inputs.
The corpus is generated and checksum-validated by `packages/quran-data`. Historical data-bearing
migrations remain under `infra/migrations` because changing or renumbering shipped history would
invalidate their checksums.
