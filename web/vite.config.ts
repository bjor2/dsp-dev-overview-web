import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Overview API (ADR-000). The SPA only ever calls /api/...; the dev server forwards it.
const API_TARGET = process.env.OVERVIEW_API ?? "http://localhost:5090";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
