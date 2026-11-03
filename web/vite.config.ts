import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Build SHA shown in the header: Render's commit, else local git, else "dev".
function buildSha(): string {
  const r = process.env.RENDER_GIT_COMMIT;
  if (r) return r.slice(0, 7);
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev"; } catch { return "dev"; }
}

// Overview API (ADR-000). The SPA only ever calls /api/...; the dev server forwards it.
const API_TARGET = process.env.OVERVIEW_API ?? "http://localhost:5090";

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_SHA__: JSON.stringify(buildSha()) },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
