import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    open: true,
    proxy: {
      "/api": "http://127.0.0.1:43117"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2017",
    cssTarget: "chrome61"
  }
});
