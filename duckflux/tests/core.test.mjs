import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubRateLimitError } from '../core/github-client.js';
import { runWorkflowFromFile } from '../core/index.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function writeWorkflow(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'duckflux-test-'));
  const file = path.join(dir, name);
  await writeFile(file, 'version: "1"\nparticipants: {}\nflow: []\n', 'utf8');
  return file;
}

test('dispatch workflow dry-run selects eligible issue and records label mutations', async () => {
  const workflow = await writeWorkflow('dispatch.duck.yaml');
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${parsed.pathname}${parsed.search}`);

    if (parsed.pathname === '/repos/owner/repo/pulls') {
      return jsonResponse([]);
    }
    if (parsed.pathname === '/repos/owner/repo/issues' && parsed.searchParams.get('labels') === 'enriched') {
      return jsonResponse([
        {
          number: 123,
          title: 'Critical issue',
          created_at: '2026-04-01T00:00:00Z',
          user: { login: 'markus-lassfolk' },
          labels: [{ name: 'enriched' }, { name: 'Queue:Critical' }],
          html_url: 'https://example.test/issues/123',
        },
        {
          number: 124,
          title: 'Already dispatched',
          created_at: '2026-04-02T00:00:00Z',
          user: { login: 'markus-lassfolk' },
          labels: [{ name: 'enriched' }, { name: 'stage/dispatched' }],
        },
      ]);
    }
    if (parsed.pathname === '/repos/owner/repo/issues/123/labels') {
      return jsonResponse([{ name: 'enriched' }, { name: 'Queue:Critical' }]);
    }
    throw new Error(`Unexpected request: ${parsed.pathname}${parsed.search}`);
  };

  const result = await runWorkflowFromFile(
    workflow,
    { repo: 'owner/repo', max_open_prs: 9 },
    { dryRun: true, fetchImpl: mockFetch, token: 'test-token' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.stub, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.check_capacity.count, 0);
  assert.equal(result.check_capacity.within_limit, true);
  assert.equal(result.eligible_issue.found, true);
  assert.equal(result.eligible_issue.issue.number, 123);
  assert.equal(result.dispatched, true);
  assert.deepEqual(
    result.operations.map((op) => op.type),
    ['addLabels', 'removeLabel'],
  );
  assert.ok(calls.some((entry) => entry.startsWith('GET /repos/owner/repo/pulls')));
});

test('dispatch workflow skips selection when capacity is full', async () => {
  const workflow = await writeWorkflow('dispatch.duck.yaml');
  const mockFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/owner/repo/pulls') {
      return jsonResponse(Array.from({ length: 9 }, (_, index) => ({ number: index + 1 })));
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const result = await runWorkflowFromFile(
    workflow,
    { repo: 'owner/repo', max_open_prs: 9 },
    { dryRun: true, fetchImpl: mockFetch, token: 'test-token' },
  );

  assert.equal(result.check_capacity.within_limit, false);
  assert.equal(result.eligible_issue.found, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.operations.length, 0);
});

test('lifecycle workflow dry-run records comment mutation', async () => {
  const workflow = await writeWorkflow('lifecycle.duck.yaml');
  const mockFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/owner/repo/pulls/5') {
      return jsonResponse({
        number: 5,
        title: 'Example PR',
        state: 'open',
        draft: false,
        mergeable: true,
        head: { ref: 'feature/test' },
        base: { ref: 'main' },
        html_url: 'https://example.test/pulls/5',
      });
    }
    if (parsed.pathname === '/repos/owner/repo/issues/5/labels') {
      return jsonResponse([{ name: 'needs-review' }]);
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const result = await runWorkflowFromFile(
    workflow,
    { repo: 'owner/repo', pr_num: 5, action: 'comment', body_text: 'hello world' },
    { dryRun: true, fetchImpl: mockFetch, token: 'test-token' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.pr.number, 5);
  assert.equal(result.action, 'comment');
  assert.deepEqual(result.operations.map((op) => op.type), ['postComment']);
});

test('rate limit responses raise GitHubRateLimitError', async () => {
  const workflow = await writeWorkflow('dispatch.duck.yaml');
  const mockFetch = async () => new Response(JSON.stringify({ message: 'rate limited' }), {
    status: 403,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '9999999999',
      'x-ratelimit-resource': 'core',
    },
  });

  const result = await runWorkflowFromFile(
    workflow,
    { repo: 'owner/repo', max_open_prs: 9 },
    { dryRun: true, fetchImpl: mockFetch, token: 'test-token' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
  assert.equal(result.workflow, 'dispatch.duck.yaml');
  assert.equal(result.retryAfterSeconds, null);
});
