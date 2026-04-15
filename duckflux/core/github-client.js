const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export class GitHubRateLimitError extends Error {
  /** @param {{retryAfterSeconds?: number|null, resetAtEpochSeconds?: number|null, scope?: string|null, request?: string}} details */
  constructor(message, details = {}) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.resetAtEpochSeconds = details.resetAtEpochSeconds ?? null;
    this.scope = details.scope ?? null;
    this.request = details.request ?? "";
  }
}

/**
 * @typedef {{type:string, method:string, path:string, body?:unknown}} RecordedOperation
 */

function parseLinkHeader(linkHeader) {
  if (!linkHeader) return new Map();
  const links = new Map();
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links.set(match[2], match[1]);
  }
  return links;
}

function normalizeRepo(repo) {
  if (!repo || typeof repo !== "string") {
    throw new Error("Repository must be provided as 'owner/repo'");
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repository '${repo}', expected 'owner/repo'`);
  }
  return { owner, repo: name };
}

function labelName(label) {
  return typeof label === "string" ? label : label?.name ?? "";
}

export function createGitHubClient({
  token,
  dryRun = false,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  /** @type {RecordedOperation[]} */
  const recordedOperations = [];
  let lastRateLimit = null;

  async function request(method, path, { query, body, headers } = {}) {
    const url = new URL(path, baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const mergedHeaders = {
      ...DEFAULT_HEADERS,
      ...(headers ?? {}),
    };
    if (token) mergedHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined) mergedHeaders["Content-Type"] = "application/json";

    const response = await fetchImpl(url, {
      method,
      headers: mergedHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    lastRateLimit = {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: remaining === null ? null : Number(remaining),
      resetAtEpochSeconds: reset === null ? null : Number(reset),
      retryAfterSeconds: retryAfter === null ? null : Number(retryAfter),
      used: response.headers.get("x-ratelimit-used"),
      resource: response.headers.get("x-ratelimit-resource"),
    };

    if (response.status === 429 || response.status === 403) {
      const exhausted = remaining === "0" || retryAfter !== null;
      if (exhausted) {
        throw new GitHubRateLimitError(
          `GitHub API rate limit hit for ${method} ${url.pathname}`,
          {
            retryAfterSeconds: retryAfter === null ? null : Number(retryAfter),
            resetAtEpochSeconds: reset === null ? null : Number(reset),
            scope: response.headers.get("x-ratelimit-resource"),
            request: `${method} ${url.pathname}`,
          },
        );
      }
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const parsed = text.length === 0
      ? null
      : contentType.includes("application/json")
      ? JSON.parse(text)
      : (() => {
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        })();

    if (!response.ok) {
      const message = typeof parsed === "object" && parsed && "message" in parsed
        ? String(parsed.message)
        : typeof parsed === "string"
        ? parsed
        : `GitHub API error ${response.status}`;
      throw new Error(`${message} (${method} ${url.pathname})`);
    }

    return { data: parsed, headers: response.headers, status: response.status };
  }

  async function paginate(path, query) {
    const items = [];
    let nextUrl = null;
    let currentQuery = { ...(query ?? {}), per_page: query?.per_page ?? 100 };

    while (true) {
      const { data, headers } = nextUrl
        ? await request("GET", nextUrl.replace(baseUrl, ""))
        : await request("GET", path, { query: currentQuery });

      if (Array.isArray(data)) items.push(...data);
      else if (data && Array.isArray(data.items)) items.push(...data.items);
      else if (data != null) items.push(data);

      const links = parseLinkHeader(headers.get("link"));
      nextUrl = links.get("next") ?? null;
      if (!nextUrl) break;
      currentQuery = undefined;
    }

    return items;
  }

  async function getOpenPullRequests(repoRef) {
    const { owner, repo } = normalizeRepo(repoRef);
    return paginate(`/repos/${owner}/${repo}/pulls`, { state: "open" });
  }

  async function listOpenIssues(repoRef, { labels } = {}) {
    const { owner, repo } = normalizeRepo(repoRef);
    return paginate(`/repos/${owner}/${repo}/issues`, {
      state: "open",
      labels,
    });
  }

  async function getIssueLabels(repoRef, issueNumber) {
    const { owner, repo } = normalizeRepo(repoRef);
    const { data } = await request("GET", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
    return Array.isArray(data) ? data : [];
  }

  async function addLabels(repoRef, issueNumber, labels) {
    const { owner, repo } = normalizeRepo(repoRef);
    const normalized = labels.map(labelName).filter(Boolean);
    if (dryRun) {
      recordedOperations.push({
        type: "addLabels",
        method: "POST",
        path: `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
        body: { labels: normalized },
      });
      return { dryRun: true, labels: normalized };
    }
    const { data } = await request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      body: { labels: normalized },
    });
    return data;
  }

  async function removeLabel(repoRef, issueNumber, label) {
    const { owner, repo } = normalizeRepo(repoRef);
    const normalized = labelName(label);
    const encoded = encodeURIComponent(normalized);
    if (dryRun) {
      recordedOperations.push({
        type: "removeLabel",
        method: "DELETE",
        path: `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encoded}`,
      });
      return { dryRun: true, label: normalized };
    }
    const { data } = await request("DELETE", `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encoded}`);
    return data;
  }

  async function removeLabels(repoRef, issueNumber, labels) {
    const results = [];
    for (const label of labels.map(labelName).filter(Boolean)) {
      results.push(await removeLabel(repoRef, issueNumber, label));
    }
    return results;
  }

  async function postComment(repoRef, issueNumber, body) {
    const { owner, repo } = normalizeRepo(repoRef);
    if (dryRun) {
      recordedOperations.push({
        type: "postComment",
        method: "POST",
        path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        body: { body },
      });
      return { dryRun: true, body };
    }
    const { data } = await request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      body: { body },
    });
    return data;
  }

  async function getPullRequest(repoRef, pullNumber) {
    const { owner, repo } = normalizeRepo(repoRef);
    const { data } = await request("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}`);
    return data;
  }

  async function mergePullRequest(repoRef, pullNumber, { commit_title, merge_method = "squash" } = {}) {
    const { owner, repo } = normalizeRepo(repoRef);
    const body = { merge_method };
    if (commit_title) body.commit_title = commit_title;
    if (dryRun) {
      recordedOperations.push({
        type: "mergePullRequest",
        method: "PUT",
        path: `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
        body,
      });
      return { dryRun: true, merged: true, merge_method };
    }
    const { data } = await request("PUT", `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      body,
    });
    return data;
  }

  async function findEligibleIssue(repoRef, { author = "markus-lassfolk" } = {}) {
    const issues = await listOpenIssues(repoRef, { labels: "enriched" });
    const eligible = issues
      .filter((issue) => !issue.pull_request)
      .filter((issue) => issue.user?.login === author)
      .map((issue) => ({
        ...issue,
        _labels: Array.isArray(issue.labels) ? issue.labels.map(labelName).filter(Boolean) : [],
      }))
      .filter((issue) => !issue._labels.includes("stage/dispatched"))
      .filter((issue) => !issue._labels.includes("declined"))
      .sort((a, b) => {
        const pa = priorityScore(a._labels);
        const pb = priorityScore(b._labels);
        if (pa !== pb) return pa - pb;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

    return eligible[0] ?? null;
  }

  function priorityScore(labels) {
    const lowered = labels.map((label) => label.toLowerCase());
    if (lowered.includes("queue:critical") || lowered.includes("priority:critical")) return 0;
    if (lowered.includes("queue:high") || lowered.includes("priority:high")) return 1;
    if (lowered.includes("queue:medium") || lowered.includes("priority:medium")) return 2;
    if (lowered.includes("queue:low") || lowered.includes("priority:low")) return 3;
    return 4;
  }

  return {
    dryRun,
    getOpenPullRequests,
    listOpenIssues,
    findEligibleIssue,
    getIssueLabels,
    addLabels,
    removeLabel,
    removeLabels,
    postComment,
    getPullRequest,
    mergePullRequest,
    getRecordedOperations: () => [...recordedOperations],
    getRateLimit: () => (lastRateLimit ? { ...lastRateLimit } : null),
  };
}
