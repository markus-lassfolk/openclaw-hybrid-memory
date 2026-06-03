/**
 * Structured progress reporting for `active-tasks reconcile` (#1864).
 */

export type ActiveTaskReconcilePhase = "session-index" | "fact-write" | "file-write";

export type ActiveTaskReconcileMode = "apply" | "dry-run";

export type ActiveTaskReconcileLedger = "markdown" | "facts";

export type ActiveTaskReconcileItemAction = "mark_done" | "skip";

export interface ActiveTaskReconcileProgressOptions {
  mode: ActiveTaskReconcileMode;
  ledger: ActiveTaskReconcileLedger;
  /** Per-item decision logs when true; periodic heartbeats always emit when reporter is active. */
  verbose?: boolean;
  heartbeatIntervalMs?: number;
  /** Emit numbered progress at least every N processed items (default 1 for apply, 10 for scan). */
  itemProgressEvery?: number;
  emit?: (line: string) => void;
}

export interface ActiveTaskReconcileItemEvent {
  index: number;
  total: number;
  entity: string;
  action: ActiveTaskReconcileItemAction;
  reason: string;
  previousStatus?: string;
  elapsedMs: number;
}

export interface ActiveTaskReconcileCompleteEvent {
  event: "active_tasks_reconcile_complete";
  mode: ActiveTaskReconcileMode;
  ledger: ActiveTaskReconcileLedger;
  candidates: number;
  reconciled: number;
  skipped: number;
  failed: number;
  scanned: number;
  elapsedMs: number;
  factsWritten?: number;
}

function defaultEmit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

export class ActiveTaskReconcileProgressReporter {
  private readonly startedAt = Date.now();
  private phaseStartedAt = this.startedAt;
  private currentPhase: ActiveTaskReconcilePhase | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeartbeatAt = this.startedAt;
  private lastProgressItemAt = 0;

  scanned = 0;
  candidates = 0;
  reconciled = 0;
  skipped = 0;
  failed = 0;
  factsWritten = 0;
  scanTotal = 0;
  writeTotal = 0;
  private scanMarked = 0;

  private readonly emit: (line: string) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly itemProgressEvery: number;

  constructor(private readonly opts: ActiveTaskReconcileProgressOptions) {
    this.emit = opts.emit ?? defaultEmit;
    this.heartbeatIntervalMs = Math.max(5_000, opts.heartbeatIntervalMs ?? 15_000);
    this.itemProgressEvery = Math.max(1, opts.itemProgressEvery ?? (opts.mode === "apply" ? 1 : 10));
  }

  start(): void {
    this.emit(
      `active-tasks reconcile: start mode=${this.opts.mode} ledger=${this.opts.ledger}`,
    );
    this.startHeartbeat();
  }

  phaseStart(phase: ActiveTaskReconcilePhase, meta?: Record<string, string | number | boolean>): void {
    this.currentPhase = phase;
    this.phaseStartedAt = Date.now();
    const suffix = meta ? ` ${formatMeta(meta)}` : "";
    this.emit(`active-tasks reconcile: phase=${phase} start${suffix}`);
  }

  phaseComplete(phase: ActiveTaskReconcilePhase, meta?: Record<string, string | number | boolean>): void {
    const elapsedMs = Date.now() - this.phaseStartedAt;
    const suffix = meta ? ` ${formatMeta({ ...meta, elapsedMs })}` : ` elapsedMs=${elapsedMs}`;
    this.emit(`active-tasks reconcile: phase=${phase} complete${suffix}`);
    if (this.currentPhase === phase) {
      this.currentPhase = null;
    }
  }

  setScanTotal(total: number): void {
    this.scanTotal = total;
  }

  setWriteTotal(total: number): void {
    this.writeTotal = total;
    this.candidates = total;
  }

  onScanItem(event: ActiveTaskReconcileItemEvent): void {
    this.scanned = event.index;
    if (event.action === "mark_done") {
      this.scanMarked += 1;
    } else {
      this.skipped += 1;
    }
    if (this.opts.verbose) {
      this.emit(formatItemLine(event));
    } else if (shouldEmitItemProgress(event.index, this.itemProgressEvery, this.lastProgressItemAt)) {
      this.lastProgressItemAt = event.index;
      this.emitProgress("session-index", event.index, event.total);
    }
    this.maybeHeartbeat();
  }

  onWriteItem(entity: string, index: number, total: number, failed = false): void {
    if (failed) {
      this.failed += 1;
    } else {
      this.factsWritten += 1;
    }
    this.reconciled = this.factsWritten;
    const elapsedMs = Date.now() - this.startedAt;
    if (this.opts.verbose) {
      this.emit(
        `active-tasks reconcile: progress ${index}/${total} entity=${entity} action=${failed ? "failed" : "mark_done"} reason=${failed ? "write_failed" : "session_missing"} elapsedMs=${elapsedMs}`,
      );
    } else if (shouldEmitItemProgress(index, this.itemProgressEvery, this.lastProgressItemAt)) {
      this.lastProgressItemAt = index;
      this.emitProgress("fact-write", index, total);
    }
    this.maybeHeartbeat();
  }

  complete(): ActiveTaskReconcileCompleteEvent {
    this.stopHeartbeat();
    const elapsedMs = Date.now() - this.startedAt;
    const reconciled = this.opts.mode === "dry-run" ? this.scanMarked : (this.opts.ledger === "markdown" ? this.candidates - this.skipped - this.failed : this.factsWritten);
    const summary: ActiveTaskReconcileCompleteEvent = {
      event: "active_tasks_reconcile_complete",
      mode: this.opts.mode,
      ledger: this.opts.ledger,
      candidates: this.candidates,
      reconciled,
      skipped: this.skipped,
      failed: this.failed,
      scanned: this.scanned,
      elapsedMs,
      ...(this.factsWritten > 0 ? { factsWritten: this.factsWritten } : {}),
    };
    this.emit(
      `active-tasks reconcile: complete reconciled=${summary.reconciled} skipped=${summary.skipped} failed=${summary.failed} elapsedMs=${elapsedMs}`,
    );
    this.emit(JSON.stringify(summary));
    return summary;
  }

  private emitProgress(phase: string, processed: number, total: number): void {
    const elapsedMs = Date.now() - this.startedAt;
    this.emit(
      `active-tasks reconcile: progress ${processed}/${total} phase=${phase} elapsedMs=${elapsedMs} rssMb=${rssMb()} factsWritten=${this.factsWritten}`,
    );
  }

  private maybeHeartbeat(): void {
    const now = Date.now();
    if (now - this.lastHeartbeatAt < this.heartbeatIntervalMs) return;
    this.lastHeartbeatAt = now;
    const phase = this.currentPhase ?? "idle";
    const total = phase === "fact-write" || phase === "file-write" ? this.writeTotal : this.scanTotal;
    const processed =
      phase === "fact-write" || phase === "file-write" ? this.factsWritten + this.failed : this.scanned;
    this.emitProgress(phase, processed, Math.max(total, processed, 1));
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.maybeHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

function shouldEmitItemProgress(index: number, every: number, lastAt: number): boolean {
  if (index <= 1) return true;
  if (index === lastAt) return false;
  return index % every === 0;
}

function formatItemLine(event: ActiveTaskReconcileItemEvent): string {
  const status = event.previousStatus ? ` previousStatus=${event.previousStatus}` : "";
  return `active-tasks reconcile: progress ${event.index}/${event.total} entity=${event.entity} action=${event.action} reason=${event.reason}${status} elapsedMs=${event.elapsedMs}`;
}

function formatMeta(meta: Record<string, string | number | boolean>): string {
  return Object.entries(meta)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}
