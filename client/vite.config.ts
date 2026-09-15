import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is served by the local JARVIS agent itself (default http://127.0.0.1:8765).
// In dev, proxy the API and the event stream to a running agent.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: false },
      "/preview": { target: "http://127.0.0.1:8765", changeOrigin: false },
    },
  },
  build: { sourcemap: false, target: "es2022" },
});
