/**
 * Type declarations for openclaw/plugin-sdk.
 * The actual implementation is provided by the OpenClaw runtime at runtime.
 */
declare module "openclaw/plugin-sdk" {
  import type { TSchema } from "@sinclair/typebox";

  export function stringEnum<T extends readonly string[]>(values: T): TSchema;

  type CliProgram = {
    command: (name: string) => CliProgram;
    description: (d: string) => CliProgram;
    option: (flags: string, desc: string, defaultValue?: string) => CliProgram;
    requiredOption: (flags: string, desc: string, defaultValue?: string) => CliProgram;
    argument: (name: string, desc?: string, defaultValue?: string) => CliProgram;
    action: (fn: (...args: any[]) => any) => CliProgram;
  };

  export type ClawdbotPluginApi = {
    resolvePath: (path: string) => string;
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    registerService: (opts: { id: string; start: () => void; stop?: () => void }) => void;
    registerTool: (
      opts: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => void;
    registerCli: (fn: (opts: { program: CliProgram }) => void, options?: { commands?: string[] }) => void;
    on: (event: string, handler: (ev: unknown) => void | Promise<void> | Promise<unknown>) => void;
    [key: string]: unknown;
  };
}
