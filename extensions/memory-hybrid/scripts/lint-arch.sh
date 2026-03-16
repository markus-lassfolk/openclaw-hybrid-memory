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
echo ""
echo "Checking for console.* in production code..."
if grep -rn "console\.log\|console\.warn\|console\.error" api/ backends/ cli/ config/ lifecycle/ prompts/ routes/ services/ setup/ tools/ types/ utils/ --include="*.ts" 2>/dev/null | grep -v ".test.ts" | grep -v "logger" | head -5 | grep -q .; then
  grep -rn "console\.log\|console\.warn\|console\.error" api/ backends/ cli/ config/ lifecycle/ prompts/ routes/ services/ setup/ tools/ types/ utils/ --include="*.ts" 2>/dev/null | grep -v ".test.ts" | grep -v "logger" | head -5
  echo "Warning: console.* found in production code (use logger instead)"
else
  echo "OK: No raw console.* calls found"
fi

# Check 3: Test files must end in .test.ts (error if .spec.ts found)
echo ""
echo "Checking test file naming convention..."
found=$(find api backends cli config lifecycle prompts routes services setup tests tools types utils -name "*.spec.ts" -type f 2>/dev/null | head -1)
if [ -n "$found" ]; then
  echo "Error: Use .test.ts not .spec.ts (found: $found)"
  EXIT_CODE=1
else
  echo "OK: Test files follow .test.ts convention"
fi

echo ""
echo "=== Architectural lint complete ==="
exit $EXIT_CODE
