import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true } },
  },
});
