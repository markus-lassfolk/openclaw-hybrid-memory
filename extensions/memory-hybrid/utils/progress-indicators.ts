/**
 * Progress indicators, spinners, and status feedback for CLI operations
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ProgressSpinner {
  private interval: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private message: string;
  private startTime: number;

  constructor(message: string) {
    this.message = message;
    this.startTime = Date.now();
  }

  start(): void {
    if (this.interval) return;

    // Only show spinner in TTY mode
    if (!process.stdout.isTTY) {
      return;
    }

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex];
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const elapsedStr = elapsed > 0 ? ` (${elapsed}s)` : "";
      process.stdout.write(`\r${frame} ${this.message}${elapsedStr}`);
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
    }, 80);
  }

  update(message: string): void {
    this.message = message;
  }

  success(_message?: string): void {
    this.stop();
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const _elapsedStr = elapsed > 0 ? ` in ${elapsed}s` : "";
  }

  fail(_message?: string): void {
    this.stop();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K"); // Clear line
    }
  }
}

export class ProgressBar {
  private message: string;
  private total: number;
  private current = 0;
  private startTime: number;
  private width = 40;
  private lastLoggedPercent = -1;

  constructor(message: string, total: number) {
    this.message = message;
    this.total = total;
    this.startTime = Date.now();
  }

  update(current: number, status?: string): void {
    this.current = current;

    const safeTotal = Math.max(1, this.total);
    const percent = Math.max(0, Math.min(100, Math.floor((current / safeTotal) * 100)));

    if (!process.stdout.isTTY) {
      const milestone = Math.floor(percent / 10) * 10;
      if (milestone > this.lastLoggedPercent) {
        this.lastLoggedPercent = milestone;
        const statusStr = status ? ` - ${status}` : "";
        process.stdout.write(`${this.message}: ${milestone}% (${current}/${this.total})${statusStr}\n`);
      }
      return;
    }

    const filled = Math.floor((current / safeTotal) * this.width);
    const empty = this.width - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);

    // Calculate ETA
    const elapsed = Date.now() - this.startTime;
    const rate = current / (elapsed / 1000);
    const remaining = Math.max(0, this.total - current);
    const eta = remaining / rate;
    const etaStr = eta > 0 && Number.isFinite(eta) ? ` ETA ${formatDuration(eta)}` : "";

    const statusStr = status ? ` - ${status}` : "";
    process.stdout.write(`\r${this.message}: [${bar}] ${percent}% (${current}/${this.total})${etaStr}${statusStr}`);
  }

  complete(_message?: string): void {
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K"); // Clear line
    }
    const _elapsed = Math.floor((Date.now() - this.startTime) / 1000);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

/**
 * Simple status message with icon
 */
export function statusMessage(_type: "info" | "success" | "warning" | "error", _message: string): void {
  const _icons = {
    info: "ℹ️",
    success: "✓",
    warning: "⚠️",
    error: "✗",
  };
}

/**
 * Show a completion summary with stats
 */
export function showCompletionSummary(
  _operation: string,
  stats: Record<string, number | string>,
  durationMs: number,
): void {
  const _durationStr = formatDuration(durationMs / 1000);

  for (const [_key, _value] of Object.entries(stats)) {
  }
}
