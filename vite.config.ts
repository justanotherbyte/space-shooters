import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    // `npm run worker` serves the Python agents on 8787.
    proxy: { "/agents": { target: "http://localhost:8787", ws: true } },
  },
});
