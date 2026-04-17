import { randomUUID } from "node:crypto";

export type RecallTimingMode = "off" | "basic" | "verbose";

type RecallTimingValue = string | number | boolean | undefined | null;

export interface RecallTimingLogger {
	span: string;
	mode: RecallTimingMode;
	phaseStarted: (
		phase: string,
		fields?: Record<string, RecallTimingValue>,
	) => number;
	phaseCompleted: (
		phase: string,
		startedAtMs: number,
		fields?: Record<string, RecallTimingValue>,
	) => number;
	event: (
		phase: string,
		event: "started" | "completed",
		fields?: Record<string, RecallTimingValue>,
	) => void;
}

function sanitize(value: string): string {
	return value.replace(/\s+/g, "_");
}

function toFieldParts(
	fields: Record<string, RecallTimingValue> | undefined,
): string[] {
	if (!fields) return [];
	const parts: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null) continue;
		parts.push(`${sanitize(key)}=${sanitize(String(value))}`);
	}
	return parts;
}

export function createRecallSpan(prefix = "recall"): string {
	return `${prefix}-${randomUUID().split("-")[0]}`;
}

export function createRecallTimingLogger(args: {
	logger: { debug?: (msg: string) => void };
	mode: RecallTimingMode;
	span: string;
	op: string;
	subsystem?: string;
}): RecallTimingLogger {
	const { logger, mode, span, op, subsystem = "recall" } = args;

	function event(
		phase: string,
		eventType: "started" | "completed",
		fields?: Record<string, RecallTimingValue>,
	): void {
		if (mode === "off") return;
		if (eventType === "started" && mode !== "verbose") return;
		const parts = [
			`span=${sanitize(span)}`,
			`phase=${sanitize(phase)}`,
			`op=${sanitize(op)}`,
			`event=${eventType}`,
			...toFieldParts(fields),
		];
		if (mode === "verbose") {
			parts.push(`ts=${new Date().toISOString()}`);
		}
		logger.debug?.(`memory-hybrid: ${subsystem} ${parts.join(" ")}`);
	}

	return {
		span,
		mode,
		phaseStarted(phase, fields) {
			const startedAtMs = Date.now();
			event(phase, "started", fields);
			return startedAtMs;
		},
		phaseCompleted(phase, startedAtMs, fields) {
			const durationMs = Math.max(0, Date.now() - startedAtMs);
			event(phase, "completed", { ...fields, duration_ms: durationMs });
			return durationMs;
		},
		event,
	};
}
