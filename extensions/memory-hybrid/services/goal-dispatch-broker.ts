/** Supported, plugin-owned broker for native managed work. No core patch required. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DispatchMode = "disabled" | "audit" | "enforce";
export type DispatchBudget = {
  maxDispatches?: number;
  maxTotalTokens?: number;
  maxDispatchTokens?: number;
  maxWallTimeMs?: number;
};
export type CanonicalTarget = {
  repository: string;
  prNumber: number;
  branch: string;
  remoteHead: string;
};
export type ExecutionReceipt = {
  owner: string;
  runId: string;
  sessionId: string;
  requestedModel: string;
  resolvedModel: string;
  modelApplied: boolean;
  startingHead: string;
  endingHead: string;
  outcome: "success" | "failed" | "cancelled";
  evidence: string[];
  recordedAt: string;
};
export type DispatchRecord = {
  id: string;
  goalId: string;
  targetAgent: string;
  runtime: "subagent" | "acp";
  expiresAt: string;
  status: "reserved" | "launched" | "released" | "settled";
  budget: DispatchBudget;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  owner?: string;
  sessionId?: string;
  target?: CanonicalTarget;
  receipt?: ExecutionReceipt;
  reason?: string;
};
type Ledger = { dispatches: Record<string, DispatchRecord> };

/** Local-POSIX only atomic ledger. It is not a distributed transaction or network-FS guarantee. */
export class GoalDispatchBroker {
  constructor(
    private readonly goalsDir: string,
    private readonly now = () => new Date(),
  ) {}
  private get dir() {
    return join(this.goalsDir, "dispatch-broker");
  }
  private get file() {
    return join(this.dir, "ledger.json");
  }
  private get lock() {
    return join(this.dir, ".lock");
  }
  async reserve(input: {
    goalId: string;
    targetAgent: string;
    runtime: "subagent" | "acp";
    budget: DispatchBudget;
    ttlMs: number;
    owner?: string;
    sessionId?: string;
    target?: CanonicalTarget;
  }): Promise<DispatchRecord | null> {
    return this.withLedger((ledger) => {
      this.expire(ledger);
      // A goal's canonical target is part of the same locked reservation decision.
      const active = Object.values(ledger.dispatches).filter(
        (x) => x.goalId === input.goalId && ["reserved", "launched"].includes(x.status),
      );
      if (typeof input.budget.maxDispatches === "number" && active.length >= input.budget.maxDispatches) return null;
      const at = this.now().toISOString();
      const id = randomUUID();
      const r: DispatchRecord = {
        id,
        goalId: input.goalId,
        targetAgent: input.targetAgent,
        runtime: input.runtime,
        budget: input.budget,
        status: "reserved",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
        owner: input.owner,
        sessionId: input.sessionId,
        target: input.target,
      };
      ledger.dispatches[id] = r;
      return r;
    });
  }
  async launch(id: string, runId: string): Promise<boolean> {
    return this.mutate(id, "launched", { runId });
  }
  /** Renew only the exact active reservation. Duplicate/stale heartbeats fail closed. */
  async heartbeat(id: string, owner: string, runId: string, ttlMs: number): Promise<boolean> {
    return this.withLedger((l) => {
      this.expire(l);
      const r = l.dispatches[id];
      if (!r || !["reserved", "launched"].includes(r.status) || r.owner !== owner || (r.runId && r.runId !== runId))
        return false;
      r.runId = runId;
      r.expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
      r.updatedAt = this.now().toISOString();
      return true;
    });
  }
  /** Receipt is accepted only from the leased owner/run/session with complete evidence. */
  async recordReceipt(id: string, receipt: ExecutionReceipt): Promise<boolean> {
    return this.withLedger((l) => {
      this.expire(l);
      const r = l.dispatches[id];
      if (
        !r ||
        r.status !== "launched" ||
        r.owner !== receipt.owner ||
        r.runId !== receipt.runId ||
        r.sessionId !== receipt.sessionId
      )
        return false;
      if (
        !receipt.modelApplied ||
        !receipt.requestedModel ||
        !receipt.resolvedModel ||
        !receipt.startingHead ||
        !receipt.endingHead ||
        receipt.evidence.length === 0
      )
        return false;
      r.receipt = { ...receipt, recordedAt: this.now().toISOString() };
      r.updatedAt = this.now().toISOString();
      return true;
    });
  }
  async release(id: string, reason: string): Promise<boolean> {
    return this.mutate(id, "released", { reason });
  }
  async settle(id: string, reason: string): Promise<boolean> {
    return this.mutate(id, "settled", { reason });
  }
  async settleRun(runId: string, reason: string): Promise<boolean> {
    return this.withLedger((l) => {
      this.expire(l);
      const r = Object.values(l.dispatches).find((x) => x.runId === runId && x.status === "launched");
      if (!r) return false;
      r.status = "settled";
      r.reason = reason;
      r.updatedAt = this.now().toISOString();
      return true;
    });
  }
  token(r: DispatchRecord): string {
    return `gdb1.${r.id}.${createHash("sha256").update(`${r.id}:${r.goalId}:${r.expiresAt}`).digest("base64url")}`;
  }
  private async mutate(id: string, status: DispatchRecord["status"], extra: Partial<DispatchRecord>) {
    return this.withLedger((l) => {
      this.expire(l);
      const r = l.dispatches[id];
      if (!r || !["reserved", "launched"].includes(r.status)) return false;
      Object.assign(r, extra, { status, updatedAt: this.now().toISOString() });
      return true;
    });
  }
  private expire(l: Ledger) {
    const n = this.now().getTime();
    for (const r of Object.values(l.dispatches))
      if (["reserved", "launched"].includes(r.status) && Date.parse(r.expiresAt) <= n) {
        r.status = "released";
        r.reason = "expired";
        r.updatedAt = this.now().toISOString();
      }
  }
  private async withLedger<T>(fn: (l: Ledger) => T | Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    for (let i = 0; i < 200; i++) {
      try {
        await mkdir(this.lock);
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        await new Promise((r) => setTimeout(r, 10));
        if (i === 199) throw new Error("dispatch broker lock timeout");
      }
    }
    try {
      let l: Ledger = { dispatches: {} };
      if (existsSync(this.file)) l = JSON.parse(await readFile(this.file, "utf8"));
      const v = await fn(l);
      const t = `${this.file}.${process.pid}.tmp`;
      await writeFile(t, JSON.stringify(l), "utf8");
      await rename(t, this.file);
      return v;
    } finally {
      await rm(this.lock, { recursive: true, force: true });
    }
  }
}
