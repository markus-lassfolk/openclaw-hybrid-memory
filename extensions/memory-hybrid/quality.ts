import type { MemoryEntry } from "./types/memory.js";

/** Minimum confidence for a memory to self-reinforce via recall frequency. */
export const QUALITY_PINNING_MIN_CONFIDENCE = 0.6;

/** Minimum importance for a memory to self-reinforce via recall frequency. */
export const QUALITY_PINNING_MIN_IMPORTANCE = 0.7;

type QualityGateEntry = Pick<MemoryEntry, "confidence" | "importance">;

type RecallPinningEntry = QualityGateEntry & Pick<MemoryEntry, "decayClass" | "recallCount">;

/**
 * True when a memory has enough signal to benefit from recall-count reinforcement.
 * Low-quality memories must not become more prominent solely because they were recalled often (#1559).
 */
export function hasDemonstratedRecallQuality(entry: QualityGateEntry): boolean {
  return entry.confidence >= QUALITY_PINNING_MIN_CONFIDENCE || entry.importance >= QUALITY_PINNING_MIN_IMPORTANCE;
}

/**
 * True when a memory should be injected as pinned context.
 * Permanent entries remain pinned by decay policy; the quality gate only controls recall-count pinning.
 */
export function shouldPinForRecallQuality(entry: RecallPinningEntry, pinnedRecallThreshold: number): boolean {
  return (
    entry.decayClass === "permanent" ||
    (hasDemonstratedRecallQuality(entry) && (entry.recallCount ?? 0) >= pinnedRecallThreshold)
  );
}
