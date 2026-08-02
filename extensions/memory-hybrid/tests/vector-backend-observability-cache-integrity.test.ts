/**
 * Tests for the semantic query cache integrity health check in
 * services/vector-backend-observability.ts (GlitchTip #34 / issue #2213, recurred as #2227,
 * remediation idea #4: "add a health check ... and fire a GlitchTip error").
 *
 * The per-call "missing fragment" error is intentionally dropped as noisy
 * (services/error-reporter/noisy-errors.ts) so VectorDB can self-heal without spamming GlitchTip
 * on every cache lookup/store — these functions are the surface that instead reports it once,
 * from a periodic health/verify surface, when self-heal has had to run at all.
 */
import { vi } from "vitest";

const { mockCapturePluginError } = vi.hoisted(() => ({
  mockCapturePluginError: vi.fn(),
}));

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: mockCapturePluginError,
}));

import { beforeEach, describe, expect, it } from "vitest";
import type { VectorDB } from "../backends/vector-db.js";
import {
  collectVectorBackendObservability,
  evaluateSemanticQueryCacheIntegrity,
  reportSemanticQueryCacheIntegrityIssue,
  type SemanticCacheFragmentErrorTelemetry,
} from "../services/vector-backend-observability.js";

function makeFakeVectorDb(telemetry?: SemanticCacheFragmentErrorTelemetry, withPath = false): VectorDB {
  const fake: Record<string, unknown> = {};
  if (telemetry) {
    fake.getSemanticCacheFragmentErrorTelemetry = () => telemetry;
  }
  if (withPath) {
    fake.getPath = () => "/tmp/does-not-exist-vector-backend-observability-test";
  }
  return fake as unknown as VectorDB;
}

const HEALTHY_TELEMETRY: SemanticCacheFragmentErrorTelemetry = {
  occurrences: 0,
  firstAtEpochMs: null,
  lastAtEpochMs: null,
  lastRecoveryAttemptEpochMs: null,
  lastRecoveryAction: null,
  lastRecoverySucceeded: null,
};

const RECOVERED_TELEMETRY: SemanticCacheFragmentErrorTelemetry = {
  occurrences: 2,
  firstAtEpochMs: 1000,
  lastAtEpochMs: 5000,
  lastRecoveryAttemptEpochMs: 5000,
  lastRecoveryAction: "checkout",
  lastRecoverySucceeded: true,
};

const UNRECOVERED_TELEMETRY: SemanticCacheFragmentErrorTelemetry = {
  occurrences: 5,
  firstAtEpochMs: 1000,
  lastAtEpochMs: 9000,
  lastRecoveryAttemptEpochMs: 9000,
  lastRecoveryAction: "rebuild",
  lastRecoverySucceeded: false,
};

describe("evaluateSemanticQueryCacheIntegrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports healthy with zero occurrences when the VectorDB has no fragment-error telemetry getter", () => {
    const status = evaluateSemanticQueryCacheIntegrity(makeFakeVectorDb());
    expect(status.healthy).toBe(true);
    expect(status.occurrences).toBe(0);
  });

  it("reports healthy with zero occurrences when the cache has never hit the error", () => {
    const status = evaluateSemanticQueryCacheIntegrity(makeFakeVectorDb(HEALTHY_TELEMETRY));
    expect(status.healthy).toBe(true);
    expect(status.occurrences).toBe(0);
  });

  it("reports healthy (but with a non-zero occurrence count) when self-heal succeeded", () => {
    const status = evaluateSemanticQueryCacheIntegrity(makeFakeVectorDb(RECOVERED_TELEMETRY));
    expect(status.healthy).toBe(true);
    expect(status.occurrences).toBe(2);
    expect(status.lastRecoveryAction).toBe("checkout");
  });

  it("reports unhealthy when self-heal did not succeed", () => {
    const status = evaluateSemanticQueryCacheIntegrity(makeFakeVectorDb(UNRECOVERED_TELEMETRY));
    expect(status.healthy).toBe(false);
    expect(status.occurrences).toBe(5);
    expect(status.lastRecoveryAction).toBe("rebuild");
  });
});

describe("reportSemanticQueryCacheIntegrityIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call capturePluginError when the cache has never hit the error", () => {
    const status = reportSemanticQueryCacheIntegrityIssue(makeFakeVectorDb(HEALTHY_TELEMETRY));
    expect(status.occurrences).toBe(0);
    expect(mockCapturePluginError).not.toHaveBeenCalled();
  });

  it("does not call capturePluginError when there is no telemetry getter at all", () => {
    reportSemanticQueryCacheIntegrityIssue(makeFakeVectorDb());
    expect(mockCapturePluginError).not.toHaveBeenCalled();
  });

  it("reports a single GlitchTip alert (severity=warning) when self-heal already succeeded", () => {
    reportSemanticQueryCacheIntegrityIssue(makeFakeVectorDb(RECOVERED_TELEMETRY));

    expect(mockCapturePluginError).toHaveBeenCalledOnce();
    const [err, context] = mockCapturePluginError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("2 time(s)");
    expect(context).toMatchObject({
      operation: "semantic-query-cache-integrity",
      subsystem: "vector",
      severity: "warning",
      fingerprint: ["semantic-query-cache-integrity"],
    });
  });

  it("reports a GlitchTip alert (severity=error) when self-heal has not succeeded", () => {
    reportSemanticQueryCacheIntegrityIssue(makeFakeVectorDb(UNRECOVERED_TELEMETRY));

    expect(mockCapturePluginError).toHaveBeenCalledOnce();
    const [, context] = mockCapturePluginError.mock.calls[0];
    expect(context).toMatchObject({
      operation: "semantic-query-cache-integrity",
      subsystem: "vector",
      severity: "error",
      fingerprint: ["semantic-query-cache-integrity"],
    });
  });

  it("uses a stable fingerprint so GlitchTip/capturePluginError's own dedupe collapses repeated calls, rather than reporting once per occurrence (14x under issue #2227)", () => {
    reportSemanticQueryCacheIntegrityIssue(makeFakeVectorDb(UNRECOVERED_TELEMETRY));
    reportSemanticQueryCacheIntegrityIssue(makeFakeVectorDb(UNRECOVERED_TELEMETRY));

    expect(mockCapturePluginError).toHaveBeenCalledTimes(2);
    const [, firstContext] = mockCapturePluginError.mock.calls[0];
    const [, secondContext] = mockCapturePluginError.mock.calls[1];
    expect(firstContext.fingerprint).toEqual(secondContext.fingerprint);
  });
});

describe("collectVectorBackendObservability — cacheFragmentErrors field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes fragment-error telemetry when the VectorDB exposes it", async () => {
    const vectorDb = makeFakeVectorDb(UNRECOVERED_TELEMETRY, true);

    const snapshot = await collectVectorBackendObservability({ vectorDb });
    expect(snapshot.vectorDb.cacheFragmentErrors).toEqual(UNRECOVERED_TELEMETRY);
  });

  it("is null when the VectorDB does not expose fragment-error telemetry", async () => {
    const vectorDb = makeFakeVectorDb(undefined, true);

    const snapshot = await collectVectorBackendObservability({ vectorDb });
    expect(snapshot.vectorDb.cacheFragmentErrors).toBeNull();
  });
});
