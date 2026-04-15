import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { GitHubRateLimitError, createGitHubClient } from './github-client.js';

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRepo(repo, env = {}) {
  return repo || env.REPO || env.repo || 'markus-lassfolk/openclaw-hybrid-memory';
}

function summarizeIssue(issue) {
  if (!issue) return null;
  return {
    number: issue.number,
    title: issue.title,
    created_at: issue.created_at,
    author: issue.user?.login ?? null,
    url: issue.html_url ?? issue.url ?? null,
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
      : [],
  };
}

function summarizePullRequest(pr, labels = []) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable ?? null,
    head: pr.head?.ref ?? null,
    base: pr.base?.ref ?? null,
    labels,
    url: pr.html_url ?? null,
  };
}

export async function parseWorkflowFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed workflow '${filePath}': expected a YAML mapping at the top level`);
  }
  return parsed;
}

async function executeDispatchWorkflow(filePath, workflow, inputs, options, github) {
  const repo = normalizeRepo(inputs.repo, options.env);
  const maxOpenPrs = toInt(inputs.max_open_prs ?? options.env?.MAX_OPEN_PRS, 9);

  const openPullRequests = await github.getOpenPullRequests(repo);
  const check_capacity = {
    count: openPullRequests.length,
    max: maxOpenPrs,
    within_limit: openPullRequests.length < maxOpenPrs,
  };

  const result = {
    ok: true,
    stub: false,
    dryRun: github.dryRun,
    workflow: path.basename(filePath),
    repo,
    check_capacity,
    eligible_issue: { found: false, issue: null },
    dispatched: false,
    operations: [],
    rateLimit: github.getRateLimit(),
  };

  if (!check_capacity.within_limit) {
    result.note = 'Capacity limit reached; dispatch skipped.';
    result.operations = github.getRecordedOperations();
    result.rateLimit = github.getRateLimit();
    return result;
  }

  const issue = await github.findEligibleIssue(repo);
  result.eligible_issue = {
    found: Boolean(issue),
    issue: summarizeIssue(issue),
  };

  if (!issue) {
    result.note = 'No eligible issue found.';
    result.operations = github.getRecordedOperations();
    result.rateLimit = github.getRateLimit();
    return result;
  }

  const currentLabels = await github.getIssueLabels(repo, issue.number);
  const labelNames = currentLabels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
  result.eligible_issue.current_labels = labelNames;

  if (labelNames.includes('stage/dispatched') || labelNames.includes('declined')) {
    result.note = 'Issue became ineligible before dispatch.';
    result.operations = github.getRecordedOperations();
    result.rateLimit = github.getRateLimit();
    return result;
  }

  await github.addLabels(repo, issue.number, ['stage/dispatched']);
  if (labelNames.includes('enriched')) {
    await github.removeLabels(repo, issue.number, ['enriched']);
  }

  result.dispatched = true;
  result.operations = github.getRecordedOperations();
  result.rateLimit = github.getRateLimit();
  return result;
}

async function executeLifecycleWorkflow(filePath, workflow, inputs, options, github) {
  const repo = normalizeRepo(inputs.repo, options.env);
  const prNumber = toInt(inputs.pr_num ?? options.env?.PR_NUM, NaN);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error('Lifecycle workflow requires pr_num');
  }

  const action = String(inputs.action ?? options.env?.ACTION ?? 'fetch');
  const labelName = String(inputs.label_name ?? options.env?.LABEL_NAME ?? '');
  const bodyText = String(inputs.body_text ?? options.env?.BODY_TEXT ?? '');

  const pr = await github.getPullRequest(repo, prNumber);
  const labels = (await github.getIssueLabels(repo, prNumber))
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);

  const result = {
    ok: true,
    stub: false,
    dryRun: github.dryRun,
    workflow: path.basename(filePath),
    repo,
    pr: summarizePullRequest(pr, labels),
    action,
    action_result: null,
    operations: [],
    rateLimit: github.getRateLimit(),
  };

  switch (action) {
    case 'fetch':
      result.action_result = { ok: true, fetched: true };
      break;
    case 'add-label':
      result.action_result = await github.addLabels(repo, prNumber, [labelName]);
      break;
    case 'remove-label':
      result.action_result = await github.removeLabel(repo, prNumber, labelName);
      break;
    case 'comment':
      result.action_result = await github.postComment(repo, prNumber, bodyText);
      break;
    case 'merge':
    case 'admin-merge':
      result.action_result = await github.mergePullRequest(repo, prNumber, {
        commit_title: pr.title ? `${pr.title} (#${pr.number})` : undefined,
        merge_method: 'squash',
      });
      break;
    case 'dispatch-forge':
    case 'dispatch-council':
      result.action_result = {
        ok: true,
        delegated: true,
        target: action === 'dispatch-forge' ? 'forge' : 'council',
      };
      break;
    default:
      throw new Error(`Unsupported lifecycle action '${action}'`);
  }

  result.operations = github.getRecordedOperations();
  result.rateLimit = github.getRateLimit();
  return result;
}

export async function runWorkflowFromFile(filePath, inputs = {}, options = {}) {
  const workflow = await parseWorkflowFile(filePath);
  const env = { ...process.env, ...(options.env ?? {}) };
  const dryRun = options.dryRun ?? toBoolean(inputs.dry_run ?? inputs['dry-run'] ?? env.DRY_RUN ?? false);
  const github = options.githubClient ?? createGitHubClient({
    token: options.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN,
    dryRun,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  });

  const name = path.basename(filePath);
  try {
    if (name === 'dispatch.duck.yaml' || name === 'dispatch.duck.yml') {
      return await executeDispatchWorkflow(filePath, workflow, inputs, { ...options, env }, github);
    }
    if (name === 'lifecycle.duck.yaml' || name === 'lifecycle.duck.yml') {
      return await executeLifecycleWorkflow(filePath, workflow, inputs, { ...options, env }, github);
    }

    return {
      ok: false,
      stub: false,
      dryRun,
      workflow: name,
      note: 'No local executor available for this workflow name.',
      inputs,
      parsed: workflow,
    };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      return {
        ok: false,
        stub: false,
        dryRun,
        workflow: name,
        error: error.message,
        rateLimited: true,
        retryAfterSeconds: error.retryAfterSeconds,
        resetAtEpochSeconds: error.resetAtEpochSeconds,
        operations: github.getRecordedOperations(),
      };
    }
    throw error;
  }
}
