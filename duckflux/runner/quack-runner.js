#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseWorkflowFile, runWorkflowFromFile } from '../core/index.js';

const [, , cmd, workflowPath, ...args] = process.argv;
const GUARD_FILE = path.join(process.cwd(), 'duckflux', 'tmp', 'guards', 'duckflux-runner-last-failure.json');
const FAIL_WINDOW_MS = 60 * 60 * 1000;
const MAX_RETRIES = 3;

function log(message) {
  console.error(`[quack-runner] ${message}`);
}

function ensureGuardDir() {
  mkdirSync(path.dirname(GUARD_FILE), { recursive: true });
}

function guardState() {
  if (!existsSync(GUARD_FILE)) return { first: 0, count: 0 };
  try {
    return JSON.parse(readFileSync(GUARD_FILE, 'utf8'));
  } catch {
    return { first: 0, count: 0 };
  }
}

function exceededFailureBudget() {
  const state = guardState();
  return state.count >= MAX_RETRIES && Date.now() - state.first < FAIL_WINDOW_MS;
}

function recordFailure() {
  ensureGuardDir();
  let state = guardState();
  if (Date.now() - state.first > FAIL_WINDOW_MS) state = { first: Date.now(), count: 0 };
  state.count += 1;
  writeFileSync(GUARD_FILE, JSON.stringify(state));
}

function clearFailures() {
  try {
    unlinkSync(GUARD_FILE);
  } catch {}
}

function collectInputs(argList) {
  const inputs = {};
  let dryRun = false;

  for (const arg of argList) {
    if (arg === '--dry-run' || arg === 'dry_run=true' || arg === 'dry-run=true') {
      dryRun = true;
      continue;
    }

    const stripped = arg.startsWith('--input=')
      ? arg.slice('--input='.length)
      : arg.startsWith('--')
      ? arg.slice(2)
      : arg;

    const eq = stripped.indexOf('=');
    if (eq > 0) {
      inputs[stripped.slice(0, eq)] = stripped.slice(eq + 1);
    }
  }

  return { inputs, dryRun };
}

async function main() {
  if (exceededFailureBudget()) {
    log('Previous consecutive failures reached guard threshold — aborting to break loop.');
    process.exit(2);
  }

  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) {
    console.log('Usage: quack-runner <run|validate|lint|version> <workflow.duck.yaml> [--dry-run] [--input k=v|k=v ...]');
    return;
  }

  if (cmd === 'version' || cmd === '--version') {
    console.log('quack-runner 1.1.0');
    return;
  }

  if (cmd === 'validate' || cmd === 'lint') {
    const file = workflowPath || args[0];
    if (!file) throw new Error('Workflow file required');
    const workflow = await parseWorkflowFile(file);
    console.log(`OK: ${file} (${Object.keys(workflow.participants ?? {}).length} participants, ${Array.isArray(workflow.flow) ? workflow.flow.length : 0} flow steps)`);
    return;
  }

  if (cmd === 'run') {
    if (!workflowPath) throw new Error('Workflow path required');
    const { inputs, dryRun } = collectInputs(args);
    const env = {
      ...process.env,
      REPO: inputs.repo || process.env.REPO || 'markus-lassfolk/openclaw-hybrid-memory',
    };
    log(`Running ${workflowPath} inputs=${JSON.stringify(inputs)} dryRun=${dryRun}`);
    const result = await runWorkflowFromFile(workflowPath, inputs, { env, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main()
  .then(clearFailures)
  .catch((error) => {
    console.error(error.stack || error.message);
    recordFailure();
    process.exit(1);
  });
