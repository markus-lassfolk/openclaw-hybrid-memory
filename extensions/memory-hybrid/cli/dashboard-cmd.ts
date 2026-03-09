/**
 * CLI command: hybrid-mem dashboard — start the memory dashboard server.
 */

import type { Chainable } from "./shared.js";
import type { HybridMemCliContext } from "./register.js";

export function registerDashboardCommand(mem: Chainable, ctx: HybridMemCliContext): void {
  mem
    .command("dashboard")
    .description("Start the memory dashboard (API + UI). Open http://localhost:18789/plugins/memory-dashboard/")
    .option("--port <port>", "Port to listen on", "18789")
    .action(async (opts?: { port?: string }) => {
      const port = parseInt(opts?.port ?? "18789", 10);
      const { createDashboardServer } = await import("../dashboard/server.js");
      const server = createDashboardServer({
        factsDb: ctx.factsDb,
        issueStore: ctx.issueStore ?? null,
        workflowStore: ctx.workflowStore ?? null,
        cfg: ctx.cfg,
      });
      server.listen(port, () => {
        console.log(`Memory Dashboard: http://localhost:${port}/plugins/memory-dashboard/`);
        console.log("API base: http://localhost:" + port + "/api");
        console.log("(Build the UI first: cd extensions/memory-hybrid/dashboard && npm install && npm run build)");
      });
    });
}
