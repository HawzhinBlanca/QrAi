-- The complete bundled Quran was acquired from Al Quran Cloud (`quran-uthmani`), but the original
-- schema allowed only the two source ids known to the Al-Fatihah fixture. Keep the old constraint
-- active while PostgreSQL validates the expanded set, then preserve its stable public name.
-- Canonical Arabic text is not updated by this migration.

alter table canonical_ayahs
  add constraint canonical_ayahs_source_id_check_v2
  check (source_id in ('alquran-cloud', 'quran-foundation', 'tanzil')) not valid;

alter table canonical_ayahs
  validate constraint canonical_ayahs_source_id_check_v2;

alter table canonical_ayahs
  drop constraint canonical_ayahs_source_id_check;

alter table canonical_ayahs
  rename constraint canonical_ayahs_source_id_check_v2 to canonical_ayahs_source_id_check;
