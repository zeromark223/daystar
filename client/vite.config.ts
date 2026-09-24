import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep hashed build output apart from the static game assets in public/assets.
    assetsDir: "assets-build",
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
