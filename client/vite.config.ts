import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client never talks to a model provider directly. Everything goes to the
// local FastAPI server, which is the only place the API key exists.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  build: { sourcemap: false, target: "es2022" },
});
