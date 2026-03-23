#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_MAX_BODY_CHARS = 1200;
const DEFAULT_MAX_ITEMS_PER_SECTION = 12;
const BOT_LOGIN_RE = /\[bot\]$/i;
const NON_BLOCKING_REVIEW_STATES = new Set(['APPROVED', 'DISMISSED']);
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value, maxChars = DEFAULT_MAX_BODY_CHARS) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function isBotActor(actor) {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.type === 'Bot') return true;
  const login = String(actor.login ?? '').trim();
  return BOT_LOGIN_RE.test(login);
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sortNewestFirst(items, getDate) {
  return [...items].sort((left, right) => {
    const leftDate = new Date(getDate(left) ?? 0).getTime();
    const rightDate = new Date(getDate(right) ?? 0).getTime();
    return rightDate - leftDate;
  });
}

function summarizeFailedChecks(checkRuns) {
  return sortNewestFirst(checkRuns ?? [], (run) => run.completed_at ?? run.started_at)
    .filter((run) => {
      if (!run || typeof run !== 'object') return false;
      if (run.status !== 'completed') return false;
      const conclusion = String(run.conclusion ?? '').toLowerCase();
      return conclusion && !PASSING_CONCLUSIONS.has(conclusion);
    })
    .slice(0, DEFAULT_MAX_ITEMS_PER_SECTION)
    .map((run) => ({
      name: String(run.name ?? 'Unnamed check'),
      conclusion: String(run.conclusion ?? 'failure'),
      detailsUrl: run.details_url ?? run.html_url ?? null,
      summary: truncateText(run.output?.summary ?? run.output?.text ?? run.output?.title ?? ''),
    }));
}

function summarizeIssueComments(issueComments, headCommittedAt) {
  const cutoffMs = headCommittedAt ? new Date(headCommittedAt).getTime() : null;
  return sortNewestFirst(issueComments ?? [], (comment) => comment.updated_at ?? comment.created_at)
    .filter((comment) => {
      if (!comment || typeof comment !== 'object') return false;
      if (isBotActor(comment.user)) return false;
      const body = truncateText(comment.body ?? '');
      if (!body) return false;
      if (cutoffMs == null) return true;
      const updatedAt = new Date(comment.updated_at ?? comment.created_at ?? 0).getTime();
      return Number.isFinite(updatedAt) && updatedAt > cutoffMs;
    })
    .slice(0, DEFAULT_MAX_ITEMS_PER_SECTION)
    .map((comment) => ({
      id: comment.id ?? null,
      author: String(comment.user?.login ?? 'unknown'),
      createdAt: toIsoDate(comment.created_at),
      updatedAt: toIsoDate(comment.updated_at ?? comment.created_at),
      body: truncateText(comment.body ?? ''),
      url: comment.html_url ?? null,
    }));
}

function summarizeReviews(reviews, headCommittedAt) {
  const cutoffMs = headCommittedAt ? new Date(headCommittedAt).getTime() : null;
  return sortNewestFirst(reviews ?? [], (review) => review.submitted_at ?? review.created_at)
    .filter((review) => {
      if (!review || typeof review !== 'object') return false;
      if (isBotActor(review.user)) return false;
      const state = String(review.state ?? '').toUpperCase();
      if (!state || NON_BLOCKING_REVIEW_STATES.has(state)) return false;
      const body = truncateText(review.body ?? '');
      if (!body) return false;
      if (cutoffMs == null) return true;
      const submittedAt = new Date(review.submitted_at ?? review.created_at ?? 0).getTime();
      return Number.isFinite(submittedAt) && submittedAt > cutoffMs;
    })
    .slice(0, DEFAULT_MAX_ITEMS_PER_SECTION)
    .map((review) => ({
      id: review.id ?? null,
      author: String(review.user?.login ?? 'unknown'),
      state: String(review.state ?? 'COMMENTED').toUpperCase(),
      submittedAt: toIsoDate(review.submitted_at ?? review.created_at),
      body: truncateText(review.body ?? ''),
      url: review.html_url ?? null,
    }));
}

function summarizeUnresolvedThreads(reviewThreads) {
  // Thread-level createdAt/updatedAt are not available on PullRequestReviewThread in GitHub's API.
  // Use the newest comment's date as a proxy for thread age.
  const getThreadDate = (thread) => {
    const firstComment = thread.comments?.nodes?.[0];
    return firstComment?.updatedAt ?? firstComment?.createdAt ?? thread.updatedAt ?? thread.createdAt ?? null;
  };
  return sortNewestFirst(reviewThreads ?? [], getThreadDate)
    .filter((thread) => thread && typeof thread === 'object' && thread.isResolved === false)
    .slice(0, DEFAULT_MAX_ITEMS_PER_SECTION)
    .map((thread) => {
      const comments = sortNewestFirst(thread.comments?.nodes ?? [], (comment) => comment.updatedAt ?? comment.createdAt)
        .filter((comment) => !isBotActor(comment.author) && truncateText(comment.body ?? ''))
        .slice(0, 3)
        .map((comment) => ({
          author: String(comment.author?.login ?? 'unknown'),
          createdAt: toIsoDate(comment.createdAt),
          body: truncateText(comment.body ?? ''),
          url: comment.url ?? null,
        }));
      return {
        id: thread.id ?? null,
        path: thread.path ?? null,
        line: thread.line ?? null,
        isOutdated: Boolean(thread.isOutdated),
        url: thread.comments?.nodes?.[0]?.url ?? null,
        comments,
      };
    })
    .filter((thread) => thread.comments.length > 0);
}

function formatChecksSection(failedChecks) {
  if (failedChecks.length === 0) return 'None.';
  return failedChecks
    .map((check, index) => {
      const summary = check.summary ? ` — ${check.summary}` : '';
      const detailsUrl = check.detailsUrl ? ` (${check.detailsUrl})` : '';
      return `${index + 1}. ${check.name} [${check.conclusion}]${detailsUrl}${summary}`;
    })
    .join('\n');
}

function formatTopLevelFeedbackSection(title, items, mapper) {
  if (items.length === 0) return `${title}: None.`;
  return [title + ':', ...items.map((item, index) => mapper(item, index))].join('\n');
}

function buildPrompt({ repo, pullRequest, headCommit, failedChecks, issueComments, reviews, unresolvedThreads }) {
  const header = [
    `You are Forge, the autonomous PR remediation agent for ${repo.fullName}.`,
    `Use Codex with model gpt-5.4-pro to resolve this pull request in-place.`,
    `Work on PR #${pullRequest.number}: ${pullRequest.title}`,
    `Base branch: ${pullRequest.baseRef}`,
    `Head branch: ${pullRequest.headRef}`,
    `Head SHA: ${pullRequest.headSha}`,
    headCommit.committedAt ? `Latest pushed commit: ${headCommit.committedAt}` : null,
  ].filter(Boolean).join('\n');

  const instructions = [
    'Goals:',
    '1. Fix every failing CI check listed below.',
    '2. Address every unresolved review thread and every human PR comment newer than the latest push.',
    '3. Keep changes minimal and focused; do not introduce unrelated churn.',
    '4. Run `npm test` and `npx tsc --noEmit` inside `extensions/memory-hybrid` before pushing.',
    '5. Push fixes back to the same PR branch and resolve review threads when the feedback is satisfied.',
    '6. Stop only when CI is green and there is no remaining open feedback in this payload.',
  ].join('\n');

  const sections = [
    'Failed CI checks:',
    formatChecksSection(failedChecks),
    '',
    formatTopLevelFeedbackSection('Top-level PR comments newer than the latest push', issueComments, (comment, index) => (
      `${index + 1}. @${comment.author} (${comment.updatedAt ?? comment.createdAt ?? 'unknown time'})${comment.url ? ` ${comment.url}` : ''}\n${comment.body}`
    )),
    '',
    formatTopLevelFeedbackSection('Review summaries newer than the latest push', reviews, (review, index) => (
      `${index + 1}. @${review.author} [${review.state}] (${review.submittedAt ?? 'unknown time'})${review.url ? ` ${review.url}` : ''}\n${review.body}`
    )),
    '',
    unresolvedThreads.length === 0
      ? 'Unresolved review threads: None.'
      : ['Unresolved review threads:', ...unresolvedThreads.map((thread, index) => {
          const location = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}` : 'unknown location';
          const details = thread.comments
            .map((comment) => `- @${comment.author} (${comment.createdAt ?? 'unknown time'})${comment.url ? ` ${comment.url}` : ''}\n  ${comment.body}`)
            .join('\n');
          return `${index + 1}. ${location}${thread.isOutdated ? ' [outdated diff context]' : ''}\n${details}`;
        })].join('\n'),
  ];

  return [header, '', instructions, '', ...sections].join('\n');
}

export function buildForgeRemediationRequest(input) {
  const repo = {
    owner: String(input?.repo?.owner ?? ''),
    repo: String(input?.repo?.repo ?? ''),
    fullName: String(input?.repo?.fullName ?? `${input?.repo?.owner ?? ''}/${input?.repo?.repo ?? ''}`),
  };
  const pullRequest = {
    number: Number(input?.pullRequest?.number ?? 0),
    title: String(input?.pullRequest?.title ?? ''),
    url: input?.pullRequest?.url ?? null,
    baseRef: String(input?.pullRequest?.baseRef ?? 'main'),
    headRef: String(input?.pullRequest?.headRef ?? ''),
    headSha: String(input?.pullRequest?.headSha ?? ''),
    author: String(input?.pullRequest?.author ?? ''),
  };
  const headCommit = {
    committedAt: toIsoDate(input?.headCommit?.committedAt),
  };

  const failedChecks = summarizeFailedChecks(input?.checkRuns);
  const issueComments = summarizeIssueComments(input?.issueComments, headCommit.committedAt);
  const reviews = summarizeReviews(input?.reviews, headCommit.committedAt);
  const unresolvedThreads = summarizeUnresolvedThreads(input?.reviewThreads);

  const reasons = [];
  if (failedChecks.length > 0) reasons.push('failed-ci');
  if (issueComments.length > 0 || reviews.length > 0 || unresolvedThreads.length > 0) reasons.push('review-feedback');

  const prompt = buildPrompt({
    repo,
    pullRequest,
    headCommit,
    failedChecks,
    issueComments,
    reviews,
    unresolvedThreads,
  });

  const fingerprintSource = JSON.stringify({
    headSha: pullRequest.headSha,
    failedChecks,
    issueComments,
    reviews,
    unresolvedThreads,
  });
  const fingerprint = createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 20);

  return {
    schemaVersion: 1,
    agent: 'forge',
    provider: 'codex',
    model: 'gpt-5.4-pro',
    repo,
    pullRequest,
    headCommit,
    summary: {
      failedChecks: failedChecks.length,
      newIssueComments: issueComments.length,
      newReviewSummaries: reviews.length,
      unresolvedThreads: unresolvedThreads.length,
      completionReady: reasons.length === 0,
      shouldDispatch: reasons.length > 0,
      reasons,
    },
    failedChecks,
    issueComments,
    reviews,
    unresolvedThreads,
    fingerprint,
    prompt,
  };
}

async function readJson(path) {
  const raw = await readFile(resolve(path), 'utf8');
  return JSON.parse(raw);
}

async function writeJson(path, value) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write('Usage: forge-feedback-loop.mjs build --input <file> [--output <file>]\n');
    return;
  }
  if (command !== 'build') {
    throw new Error(`Unsupported command: ${command}`);
  }

  let inputPath = null;
  let outputPath = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--input') inputPath = rest[index + 1];
    if (token === '--output') outputPath = rest[index + 1];
  }
  if (!inputPath) {
    throw new Error('Missing --input <file>');
  }

  const input = await readJson(inputPath);
  const result = buildForgeRemediationRequest(input);
  if (outputPath) {
    await writeJson(outputPath, result);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
