import { defineConfig } from "vite";

// The Pages workflow passes BASE_PATH (e.g. "/whatcmd/"); local builds serve from "/".
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  build: { outDir: "dist", emptyOutDir: true },
});
