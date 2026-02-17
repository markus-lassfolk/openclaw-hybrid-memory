import { Type } from "@sinclair/typebox";

/**
 * Mock for openclaw/plugin-sdk — provides just the exports
 * that index.ts actually uses so tests can import the module.
 */

export function stringEnum<T extends readonly string[]>(values: T) {
  return Type.Union(values.map((v) => Type.Literal(v)));
}

export type ClawdbotPluginApi = {
  resolvePath: (p: string) => string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  [key: string]: unknown;
};
