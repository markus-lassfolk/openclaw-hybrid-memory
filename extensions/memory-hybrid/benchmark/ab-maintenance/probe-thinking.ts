import type { AbThinkingMode } from "./types.js";

const BASE_URL = "https://api.minimax.io/v1";

export type ThinkingProbeResult = {
  model: string;
  accepted: AbThinkingMode[];
  rejected: Array<{ mode: AbThinkingMode; status: number; message: string }>;
};

const CANDIDATES: AbThinkingMode[] = ["disabled", "adaptive", "enabled"];

/** Probe MiniMax API for accepted thinking modes (cheap single-token prompt). */
export async function probeThinkingLevels(apiKey: string, model: string): Promise<ThinkingProbeResult> {
  const accepted: AbThinkingMode[] = [];
  const rejected: ThinkingProbeResult["rejected"] = [];

  for (const mode of CANDIDATES) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_completion_tokens: 8,
          thinking: { type: mode },
        }),
      });
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
        base_resp?: { status_msg?: string };
      };
      if (res.ok && !json.error) {
        accepted.push(mode);
      } else {
        rejected.push({
          mode,
          status: res.status,
          message: json.error?.message ?? json.base_resp?.status_msg ?? res.statusText,
        });
      }
    } catch (err) {
      rejected.push({ mode, status: 0, message: String(err) });
    }
  }

  return { model, accepted, rejected };
}

/** Default sweep: always disabled; add adaptive/enabled only if API accepts them. */
export async function resolveThinkingSweep(apiKey: string): Promise<AbThinkingMode[]> {
  const m3 = await probeThinkingLevels(apiKey, "MiniMax-M3");
  const m27 = await probeThinkingLevels(apiKey, "MiniMax-M2.7-highspeed");
  const union = new Set<AbThinkingMode>(["disabled"]);
  for (const m of [...m3.accepted, ...m27.accepted]) union.add(m);
  return [...union];
}

export async function writeThinkingProbeReport(
  apiKey: string,
  outPath: string,
): Promise<{ m3: ThinkingProbeResult; m27: ThinkingProbeResult; sweep: AbThinkingMode[] }> {
  const m3 = await probeThinkingLevels(apiKey, "MiniMax-M3");
  const m27 = await probeThinkingLevels(apiKey, "MiniMax-M2.7-highspeed");
  const sweep = [...new Set<AbThinkingMode>(["disabled", ...m3.accepted.filter((m) => m27.accepted.includes(m))])];
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify({ m3, m27, sweep }, null, 2), "utf-8");
  return { m3, m27, sweep };
}
