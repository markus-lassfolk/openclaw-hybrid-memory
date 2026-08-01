import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DispatchBudgetCaps } from "../contracts/core-dispatch-authorization.js";

export type DispatchGrantRecord = {
  id: string;
  goalId: string;
  expiresAt: string;
  budget: DispatchBudgetCaps;
  status: "reserved" | "released" | "settled";
  createdAt: string;
  updatedAt: string;
  outcome?: "completed" | "failed" | "cancelled";
};

type Ledger = { grants: Record<string, DispatchGrantRecord> };

/**
 * File-backed, same-host grant accounting. mkdir is the cross-process critical
 * section on a local POSIX filesystem; it is deliberately not represented as a
 * distributed lock. Network/weakly-consistent filesystems are unsupported.
 */
export class CoreDispatchGrantStore {
  constructor(private readonly goalsDir: string, private readonly now: () => Date = () => new Date()) {}
  private get dir() { return join(this.goalsDir, "core-dispatch-grants"); }
  private get lock() { return join(this.dir, ".ledger.lock"); }
  private get ledgerPath() { return join(this.dir, "ledger.json"); }

  async reserve(record: Omit<DispatchGrantRecord, "status" | "createdAt" | "updatedAt">): Promise<boolean> {
    return this.withLedger(async (ledger) => {
      this.expire(ledger);
      const max = record.budget.maxDispatches;
      const active = Object.values(ledger.grants).filter((g) => g.goalId === record.goalId && g.status === "reserved");
      if (typeof max === "number" && active.length >= max) return false;
      const at = this.now().toISOString();
      ledger.grants[record.id] = { ...record, status: "reserved", createdAt: at, updatedAt: at };
      return true;
    });
  }

  async release(id: string, outcome: "completed" | "failed" | "cancelled"): Promise<boolean> {
    return this.withLedger(async (ledger) => {
      this.expire(ledger);
      const grant = ledger.grants[id];
      if (!grant || grant.status !== "reserved") return false;
      grant.status = outcome === "completed" ? "settled" : "released";
      grant.outcome = outcome;
      grant.updatedAt = this.now().toISOString();
      return true;
    });
  }

  async get(id: string): Promise<DispatchGrantRecord | null> {
    return this.withLedger(async (ledger) => {
      this.expire(ledger);
      return ledger.grants[id] ?? null;
    });
  }

  private expire(ledger: Ledger): void {
    const now = this.now().getTime();
    for (const grant of Object.values(ledger.grants)) {
      if (grant.status === "reserved" && Date.parse(grant.expiresAt) <= now) {
        grant.status = "released";
        grant.outcome = "cancelled";
        grant.updatedAt = this.now().toISOString();
      }
    }
  }

  private async withLedger<T>(fn: (ledger: Ledger) => Promise<T> | T): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    for (let i = 0; i < 200; i++) {
      try { await mkdir(this.lock); break; } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        await new Promise((r) => setTimeout(r, 10));
        if (i === 199) throw new Error("core dispatch grant ledger lock timeout");
      }
    }
    try {
      let ledger: Ledger = { grants: {} };
      if (existsSync(this.ledgerPath)) {
        try { ledger = JSON.parse(await readFile(this.ledgerPath, "utf8")) as Ledger; } catch { throw new Error("core dispatch grant ledger is unreadable"); }
      }
      const value = await fn(ledger);
      const tmp = `${this.ledgerPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(ledger), "utf8");
      await rename(tmp, this.ledgerPath);
      return value;
    } finally { await rm(this.lock, { recursive: true, force: true }); }
  }
}
