import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../utils/timeout.js";

describe("withTimeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the resolved value when fn resolves before timeout", async () => {
		const result = await withTimeout(10_000, async () => "ok");
		expect(result).toBe("ok");
	});

	it("returns null when timeout fires before fn resolves", async () => {
		vi.useFakeTimers();
		const slow = new Promise<string>((resolve) =>
			setTimeout(() => resolve("slow"), 5_000),
		);
		const p = withTimeout(100, () => slow);
		vi.advanceTimersByTime(200);
		const result = await p;
		expect(result).toBeNull();
	});

	it("returns custom fallback when timeout fires", async () => {
		vi.useFakeTimers();
		const slow = new Promise<string>((resolve) =>
			setTimeout(() => resolve("slow"), 5_000),
		);
		const p = withTimeout(100, () => slow, "fallback");
		vi.advanceTimersByTime(200);
		const result = await p;
		expect(result).toBe("fallback");
	});

	it("clears the timer after fast resolution (no dangling handle)", async () => {
		vi.useFakeTimers();
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		await withTimeout(30_000, async () => "fast");
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});

	it("clears the timer after timeout fires", async () => {
		vi.useFakeTimers();
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		const slow = new Promise<string>((resolve) =>
			setTimeout(() => resolve("slow"), 5_000),
		);
		const p = withTimeout(100, () => slow);
		vi.advanceTimersByTime(200);
		await p;
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});
});
