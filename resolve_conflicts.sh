#!/bin/bash
# CHANGELOG: keep both
sed -i '/<<<<<<< HEAD/d' CHANGELOG.md
sed -i '/=======/d' CHANGELOG.md
sed -i '/>>>>>>> origin\/main/d' CHANGELOG.md

# facts-db.ts: keep ONLY origin/main for the conflict block
git checkout --theirs extensions/memory-hybrid/backends/facts-db.ts

# config/utils.ts: keep origin/main
git checkout --theirs extensions/memory-hybrid/config/utils.ts

# tools/memory-tools.ts: keep origin/main
git checkout --theirs extensions/memory-hybrid/tools/memory-tools.ts

# types/memory.ts: keep origin/main
git checkout --theirs extensions/memory-hybrid/types/memory.ts

# migrations: keep both
sed -i '/<<<<<<< HEAD/d' extensions/memory-hybrid/backends/migrations/facts-migrations.ts
sed -i '/=======/d' extensions/memory-hybrid/backends/migrations/facts-migrations.ts
sed -i '/>>>>>>> origin\/main/d' extensions/memory-hybrid/backends/migrations/facts-migrations.ts

