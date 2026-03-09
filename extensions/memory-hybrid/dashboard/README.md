# Memory Dashboard

Web UI for the OpenClaw Hybrid Memory extension. Built with React, Tailwind, shadcn/ui, and Recharts.

## Run with real data

1. **Build the dashboard** (first time and after pulling changes):

   ```bash
   cd extensions/memory-hybrid/dashboard
   npm install
   npm run build
   ```

2. **Start the dashboard server** (from the repo root or wherever OpenClaw is run):

   ```bash
   openclaw hybrid-mem dashboard
   ```

   Default port is 18789. Use `--port 3000` to change it.

3. **Open in browser**

   - UI: http://localhost:18789/plugins/memory-dashboard/
   - API: http://localhost:18789/api/

The server serves the built SPA and the REST API that reads from your real memory DB (facts, issues, workflows, clusters, config). Cost data is stubbed (zeros) until wired to your LLM cost tracking.

## Development

- **UI only (mock API):** `npm run dev` — Vite dev server with mock data.
- **UI + real API:** Start `openclaw hybrid-mem dashboard` in one terminal, then in the dashboard folder set `VITE_API_BASE=http://localhost:18789` and run `npm run dev`; the Vite proxy will forward `/api` to the dashboard server.
