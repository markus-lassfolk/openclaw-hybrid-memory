/**
 * Session focus topic (Issue #1917).
 * Stored in per-session JSON file, not SQLite.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FOCUS_DIR = join(homedir(), ".openclaw", "hybrid-memory", "focus");

export type FocusTopicState = {
  topic: string;
  setAt: string;
  sessionId: string;
};

/** Override focus dir for tests. */
let focusDirOverride: string | null = null;

export function setFocusDirForTests(dir: string | null): void {
  focusDirOverride = dir;
}

function resolveFocusDir(): string {
  return focusDirOverride ?? FOCUS_DIR;
}

function focusPath(sessionId: string, dir?: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir ?? resolveFocusDir(), `${safe}.json`);
}

export function setFocusTopic(sessionId: string, topic: string): FocusTopicState {
  const base = resolveFocusDir();
  mkdirSync(base, { recursive: true });
  const state: FocusTopicState = {
    topic: topic.trim(),
    setAt: new Date().toISOString(),
    sessionId,
  };
  writeFileSync(focusPath(sessionId, base), JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function getFocusTopic(sessionId: string): FocusTopicState | null {
  const path = focusPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as FocusTopicState;
    if (typeof parsed.topic !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearFocusTopic(sessionId: string): boolean {
  const path = focusPath(sessionId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function setFocusTopicInDir(sessionId: string, topic: string, dir?: string): FocusTopicState {
  const base = dir ?? resolveFocusDir();
  mkdirSync(base, { recursive: true });
  const state: FocusTopicState = {
    topic: topic.trim(),
    setAt: new Date().toISOString(),
    sessionId,
  };
  writeFileSync(focusPath(sessionId, base), JSON.stringify(state), "utf8");
  return state;
}

export function getFocusTopicFromDir(sessionId: string, dir?: string): FocusTopicState | null {
  const path = focusPath(sessionId, dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FocusTopicState;
  } catch {
    return null;
  }
}
