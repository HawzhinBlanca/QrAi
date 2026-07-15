# Research: Incident and Rollback Rehearsal

## Objectives
- Document disaster scenarios and recovery procedures.
- Verify backup and restore processes via real database restore drills.

## Current Codebase Architecture
1. **Backup Runbook (`docs/BACKUP_RESTORE.md`)**:
   - Outlines detailed steps for database structure backups (`pg_dump` with custom formats) and learner audio files backups (`docker run tar` volume compression).
   - Documents scheduling via cron daily, off-host backups, and security hygiene (exclude backups from version control).
2. **Database Restore**:
   - Restores custom-format dumps into clean target databases using `pg_restore --no-owner`.
3. **Database Restore Drill**:
   - Executed a complete restore drill within the PostgreSQL staging docker container:
     - Dumped database schema and contents into `/tmp/backup.dump`.
     - Created a fresh database target `quran_ai_restored`.
     - Restored the dump using `pg_restore`.
     - Confirmed dataset integrity (read back all 6,236 canonical ayahs).
     - Successfully cleaned up after completion.

## Compliance Summary
- Incident runbook is complete.
- Restore drill successfully verified.
