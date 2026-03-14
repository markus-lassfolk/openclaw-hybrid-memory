import { Type } from "@sinclair/typebox";

/**
 * Mock for openclaw/plugin-sdk — provides just the exports
 * that index.ts actually uses so tests can import the module.
 */

export function stringEnum<T extends readonly string[]>(values: T) {
  return Type.Union(values.map((v) => Type.Literal(v)));
}

/** CLI program type for registerCli — use any for action callback to accept Commander-style handlers. */
type CliProgram = {
  command: (name: string) => CliProgram;
  description: (d: string) => CliProgram;
  option: (flags: string, desc: string, defaultValue?: string) => CliProgram;
  requiredOption: (flags: string, desc: string, defaultValue?: string) => CliProgram;
  argument: (name: string, desc?: string, defaultValue?: string) => CliProgram;
  action: (fn: (...args: any[]) => any) => CliProgram;
};

export type ClawdbotPluginApi = {
  resolvePath: (p: string) => string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerCli: (fn: (opts: { program: CliProgram }) => void, options?: { commands?: string[] }) => void;
  on: (event: string, handler: (ev: unknown) => void | Promise<void> | Promise<unknown>) => void;
  /** Register an HTTP route with the OpenClaw gateway (v2026.3.8+). */
  registerHttpRoute: (
    path: string,
    handler: (req: {
      method: string;
      url: string;
      headers: Record<string, string>;
    }) => Promise<{ status: number; headers?: Record<string, string>; body: string }>,
    opts: { authenticated: boolean },
  ) => void;
  [key: string]: unknown;
};
