import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  resolve: {
    alias: {
      "@drift/core": path.resolve(__dirname, "../../packages/core/src"),
      "@drift/host-local": path.resolve(
        __dirname,
        "../../packages/host-local/src"
      ),
      "@drift/host-ssh": path.resolve(
        __dirname,
        "../../packages/host-ssh/src"
      ),
      "@drift/agent-cursor": path.resolve(
        __dirname,
        "../../packages/agent-cursor/src"
      ),
    },
  },
  plugins: [
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: [
                "electron",
                "electron-updater",
                "node-pty",
                "@cursor/sdk",
              ],
            },
          },
          resolve: {
            alias: {
              "@drift/core": path.resolve(
                __dirname,
                "../../packages/core/src"
              ),
              "@drift/host-local": path.resolve(
                __dirname,
                "../../packages/host-local/src"
              ),
              "@drift/host-ssh": path.resolve(
                __dirname,
                "../../packages/host-ssh/src"
              ),
              "@drift/agent-cursor": path.resolve(
                __dirname,
                "../../packages/agent-cursor/src"
              ),
            },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
