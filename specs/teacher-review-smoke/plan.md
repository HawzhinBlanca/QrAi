# Teacher Review Smoke Plan

1. Patch API smoke.
   - Rename the missing-finding request so it is clearly a negative-path check.
   - Add a real teacher review write for seeded `finding-seed-2`.
   - Fail if the teacher queue is empty.

2. Verify.
   - Run `pnpm smoke:api` against the running local API.
   - Run `bash scripts/verify.sh`.
   - Use the ledger helper before committing.

3. Commit the slice.
