## Similar-sweep PR checklist

Use this template for automated or manual **similar-sweep** fixes. Branch from latest `main` before opening.

### Scope

- [ ] Targets a single concern (one subsystem or file family)
- [ ] No unrelated refactors or drive-by edits

### Merge-conflict hygiene

- [ ] Rebased onto latest `origin/main` within the last 7 days
- [ ] Does **not** reintroduce a monolithic [`vector-db.ts`](../../extensions/memory-hybrid/backends/vector-db.ts) body — apply changes in [`vector-db/vector-db-class.ts`](../../extensions/memory-hybrid/backends/vector-db/vector-db-class.ts) only
- [ ] Avoids [`index.ts`](../../extensions/memory-hybrid/index.ts) unless plugin hook registration is required
- [ ] New tests live in **new files** (do not append to shared suites like `vector-db-schema.test.ts` or `pre-finalization-guard.test.ts`)

### Quality

- [ ] `cd extensions/memory-hybrid && npx tsc --noEmit`
- [ ] `cd extensions/memory-hybrid && npm run lint`
- [ ] `cd extensions/memory-hybrid && npm test`

### Coordination

- [ ] No more than one open similar-sweep PR touching the same production file (check with `.github/scripts/check-pr-file-overlap.mjs`)

Closes #
