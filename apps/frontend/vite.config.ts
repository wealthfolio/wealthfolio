import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const apiTarget =
  process.env.VITE_API_TARGET || process.env.WF_API_TARGET || "http://127.0.0.1:8088";
const enableProxy = process.env.WF_ENABLE_VITE_PROXY === "true";
const devPort = Number.parseInt(process.env.VITE_DEV_PORT || "1420", 10);
const serverProxy = enableProxy
  ? {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/docs": {
        target: apiTarget,
        changeOrigin: true,
      },
    }
  : undefined;

// Determine build target: "tauri" for desktop, "web" for browser
// Default to "tauri" for local development - use BUILD_TARGET=web for web builds
// TAURI_DEV_HOST is only set for mobile/network dev, so we can't rely on it
const buildTarget = process.env.BUILD_TARGET || "tauri";

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "../..",
  plugins: [react(), tailwindcss()],
  publicDir: "public",
  optimizeDeps: {
    include: ["lucide-react", "recharts"],
  },
  define: {
    __BUILD_TARGET__: JSON.stringify(buildTarget),
  },
  resolve: {
    alias: {
      "@wealthfolio/addon-sdk": path.resolve(__dirname, "../../packages/addon-sdk/src"),
      "@wealthfolio/ui": path.resolve(__dirname, "../../packages/ui/src"),
      // Conditional adapter alias based on build target
      "@/adapters": path.resolve(
        __dirname,
        buildTarget === "tauri" ? "./src/adapters/tauri" : "./src/adapters/web",
      ),
      // Platform-specific core module for shared adapters
      "#platform": path.resolve(
        __dirname,
        buildTarget === "tauri" ? "./src/adapters/tauri/core" : "./src/adapters/web/core",
      ),
      "@": path.resolve(__dirname, "./src"),
    },
    extensions: [".js", ".ts", ".jsx", ".tsx", ".json"],
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: Number.isFinite(devPort) ? devPort : 1420,
    strictPort: true,
    host: host ? "0.0.0.0" : false,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    proxy: serverProxy,
    watch: {
      // 3. tell vite to ignore watching `apps/desktop`
      ignored: ["**/apps/tauri/**"],
    },
  },
  // 3. to make use of `TAURI_DEBUG` and other env variables
  // https://tauri.app/v1/api/config#buildconfig.beforedevcommand
  envPrefix: ["VITE_", "TAURI_", "CONNECT_"],
  build: {
    // Output to project root's dist folder (for Tauri)
    outDir: "../../dist",
    // outDir is outside the Vite root, so Vite won't clean it by default —
    // stale hashed bundles then accumulate and Tauri embeds the ENTIRE dist
    // tree into release builds (tauri.conf.json frontendDist).
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        "addon-sandbox": path.resolve(__dirname, "addon-sandbox.html"),
      },
    },
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    // Keep target unset to use modern defaults for desktop WebView engines.
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
  },
} as unknown as import("vitest/config").UserConfigExport);
