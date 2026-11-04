import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local only: bound to 127.0.0.1; /api goes to the JobOps API (node api/src/server.ts).
const api = process.env.JOBOPS_API ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.UI_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: api, rewrite: (p) => p.replace(/^\/api/, "") } }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
