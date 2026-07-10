#!/bin/bash
# Architectural lint checks
# Run from extensions/memory-hybrid/ directory

set +e  # Don't exit on first error; we track exit code manually

EXIT_CODE=0

echo "=== Architectural Lint ==="

# Check 1: No direct fs imports in services (warn only)
echo ""
echo "Checking for direct fs imports in services..."
if grep -rn "from ['\"]fs['\"]\\|require(['\"]fs['\"])" services/ --include="*.ts" 2>/dev/null | grep -v ".test.ts" | head -5 | grep -q .; then
  grep -rn "from ['\"]fs['\"]\\|require(['\"]fs['\"])" services/ --include="*.ts" 2>/dev/null | grep -v ".test.ts" | head -5
  echo "Warning: Direct fs imports found in services (services should use storage abstraction)"
else
  echo "OK: No direct fs imports in services"
fi

# Check 2: No console.log in production code (warn only)
# Scans the whole tree (minus node_modules/.git) rather than a hardcoded directory allowlist --
# that list had drifted stale (missing benchmark/, contracts/, scripts/, skills/, src/,
# workspace-snippets/), silently exempting newer directories from the check (#2067-followup).
echo ""
echo "Checking for console.* in production code..."
if grep -rn "console\.log\|console\.warn\|console\.error" . --include="*.ts" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | grep -v ".test.ts" | grep -v "logger" | head -5 | grep -q .; then
  grep -rn "console\.log\|console\.warn\|console\.error" . --include="*.ts" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | grep -v ".test.ts" | grep -v "logger" | head -5
  echo "Warning: console.* found in production code (use logger instead)"
else
  echo "OK: No raw console.* calls found"
fi

# Check 3: Test files must end in .test.ts (error if .spec.ts found)
# Same stale-allowlist bug as Check 2, but this one is a hard CI gate (EXIT_CODE=1) -- a .spec.ts
# file added under any directory missing from the old list (e.g. src/, benchmark/) would violate
# the naming convention yet still print "OK" and exit 0, letting the real violation ship silently.
echo ""
echo "Checking test file naming convention..."
found=$(find . -path "*/node_modules" -prune -o -path "*/.git" -prune -o -name "*.spec.ts" -type f -print 2>/dev/null | head -1)
if [ -n "$found" ]; then
  echo "Error: Use .test.ts not .spec.ts (found: $found)"
  EXIT_CODE=1
else
  echo "OK: Test files follow .test.ts convention"
fi

echo ""
echo "=== Architectural lint complete ==="
exit $EXIT_CODE
