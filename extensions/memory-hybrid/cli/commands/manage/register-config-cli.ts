import { capturePluginError } from "../../../services/error-reporter.js";
import type { Command } from "commander";
import { createConfigOutputSink } from "../../config-output-sink.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageConfigCli(mem: Chainable, b: ManageBindings): void {
  const { runConfigView, runConfigMode, runConfigSet, runConfigSetHelp } = b;

  const configCommand = mem
    .command("config")
    .description("Show current configuration and feature toggles (good first stop for understanding your setup)");
  configCommand.alias?.("settings");
  configCommand
    .option("--json", "Output configuration as JSON")
    .option("--format <format>", "Output format: text (default) or json")
    .action(
      withExit(async (opts?: { json?: boolean; format?: string }) => {
        try {
          const fmtRaw = (opts?.format ?? "text").trim().toLowerCase();
          if (opts?.json && opts.format && fmtRaw !== "json") {
            console.error("Error: do not combine --json with --format text.");
            process.exitCode = 1;
            return;
          }
          if (!opts?.json && fmtRaw !== "text" && fmtRaw !== "json") {
            console.error(`Error: invalid --format "${opts?.format ?? ""}". Use text or json.`);
            process.exitCode = 1;
            return;
          }
          // Determine format: --json takes precedence, then --format, default to text
          const format = opts?.json ? "json" : fmtRaw === "json" ? "json" : "text";
          await runConfigView(createConfigOutputSink(format), { format });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config",
          });
          throw err;
        }
      }),
    );

  mem
    .command("features")
    .description("Emit feature toggles only as JSON (same keys as config --format json `features` object)")
    .action(
      withExit(async () => {
        try {
          await runConfigView(createConfigOutputSink("json"), { format: "json", featuresOnly: true });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "features",
          });
          throw err;
        }
      }),
    );

  const configModeCommand = mem
    .command("config-mode <mode>")
    .description("Set a preset: local (offline), minimal (cheap), enhanced (balanced), complete (verbose)");
  configModeCommand.alias?.("mode");
  configModeCommand.action(
    withExit(async (mode: string) => {
      let res;
      try {
        res = await runConfigMode(mode);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "config-mode",
        });
        throw err;
      }
      if (res.ok) {
        console.log(res.message);
      } else {
        console.error(`Error: ${res.error}`);
        process.exitCode = 1;
      }
    }),
  );

  const configSetCommand = mem
    .command("config-set <key> <value>")
    .description(
      'Set a config key in plugins.entries[…].config. Toggles: config-set <feature> enabled|disabled (e.g. nightlyCycle, goalStewardship, activeTask, extraction). Other keys: errorReporting.botName "MyBot". For help: hybrid-mem help config-set <key>',
    );
  configSetCommand.alias?.("set");
  configSetCommand.action(
    withExit(async (key: string, value: string) => {
      let res;
      try {
        res = await runConfigSet(key, value);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "config-set",
        });
        throw err;
      }
      if (res.ok) {
        console.log(res.message);
      } else {
        console.error(`Error: ${res.error}`);
        process.exitCode = 1;
      }
    }),
  );

  const helpCommand = (mem as Command).commands.find((command) => command.name() === "help");
  const configSetHelpRegistrar = helpCommand ?? mem;
  const configSetHelpName = helpCommand ? "config-set <key>" : "help config-set <key>";
  configSetHelpRegistrar
    .command(configSetHelpName)
    .description("Show help for a config key")
    .action(
      withExit(async (key: string) => {
        let res;
        try {
          res = await runConfigSetHelp(key);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-set-help",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );
}
