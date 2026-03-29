/**
 * Validate `gh --repo` argument to prevent flag injection (issue #869).
 * Accepts `owner/name` with safe characters; rejects leading `-` and path separators.
 */

const GH_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export function isValidGhRepoArg(repo: string | undefined | null): repo is string {
  if (repo == null || repo.length === 0) return false;
  if (repo.startsWith("-")) return false;
  if (repo.includes("/") && repo.split("/").length !== 2) return false;
  if (repo.includes("\\") || repo.includes("\0")) return false;
  return GH_REPO.test(repo);
}
