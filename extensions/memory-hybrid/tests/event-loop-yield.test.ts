import { describe, expect, it } from "vitest";
import { yieldEventLoop } from "../utils/event-loop-yield.js";

describe("yieldEventLoop", () => {
	it("runs after synchronous work in the same tick", async () => {
		const order: string[] = [];
		order.push("a");
		const p = yieldEventLoop().then(() => {
			order.push("c");
		});
		order.push("b");
		await p;
		expect(order).toEqual(["a", "b", "c"]);
	});
});
