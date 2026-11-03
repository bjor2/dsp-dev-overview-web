import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// Overview API (ADR-000). The SPA only ever calls /api/...; the dev server forwards it.
const API_TARGET = process.env.OVERVIEW_API ?? "http://localhost:5090";

// ADDENDA-007: the API requires X-Frontdoor-Secret (no dev bypass). The dev proxy adds it server-side; the browser never sees it.
function frontdoorSecret(): string | undefined {
  if (process.env.FRONTDOOR_SHARED_SECRET) return process.env.FRONTDOOR_SHARED_SECRET;
  try {
    return readFileSync(process.env.FRONTDOOR_SECRET_FILE ?? `${homedir()}/.dsp-overview-frontdoor-secret`, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
const FRONTDOOR = frontdoorSecret();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true, headers: FRONTDOOR ? { "X-Frontdoor-Secret": FRONTDOOR } : undefined },
    },
  },
});
