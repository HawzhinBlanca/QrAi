# Privacy Delete Learner Scope Plan

1. Change privacy delete SQL so all derived-record deletes join or subquery through the requested learner's tenant-scoped sessions.
2. Add a live-Postgres regression test with two learners in one tenant.
3. Run the targeted ignored integration test, regular platform-api tests, and the canonical repository gate.
