import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app is served by the dashboard server under /graph. Using the ABSOLUTE base "/graph/" makes
// every asset URL resolve to /graph/assets/... regardless of the current path depth or a missing
// trailing slash — relative "./" bases break at bare /graph and on nested client routes. In dev the
// app is therefore served at http://localhost:5173/graph/; /graphql (+ its SSE subscriptions) and
// /api/* are proxied to the dashboard server (default 127.0.0.1:7700).
export default defineConfig({
  plugins: [react()],
  base: "/graph/",
  server: {
    proxy: {
      "/graphql": {
        target: "http://127.0.0.1:7700",
        changeOrigin: true,
        // SSE subscriptions are long-lived HTTP responses — disable buffering/timeouts.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("accept-encoding", "identity"));
        },
      },
      "/api": { target: "http://127.0.0.1:7700", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep the chunk graph simple; the graph libs are the bulk of the bundle.
    chunkSizeWarningLimit: 1500,
  },
});
