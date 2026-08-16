import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.resolve(import.meta.dirname, "popup.html"),
        background: path.resolve(import.meta.dirname, "src/background.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
