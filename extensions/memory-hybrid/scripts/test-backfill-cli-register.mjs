import { Command } from "commander";
import { registerBackfillMaintenanceCommands } from "../cli/commands/manage/register-backfill-maintenance.ts";

const mem = new Command("hybrid-mem");
const b = { factsDb: { getRawDb: () => ({}), sqlitePath: "/tmp/x", setMaintenanceState: () => {}, searchProcedures: () => [], procedureFeedback: () => null }, cfg: { procedures: { sessionsDir: "/tmp", allAgentSessions: false } } };
registerBackfillMaintenanceCommands(mem, b);
console.log(mem.commands.map((c) => c.name()).join(", "));
