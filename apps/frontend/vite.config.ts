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
        // Profile admission validates the browser Origin against the original Host.
        changeOrigin: false,
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

// Modules that are imported both statically and with import(), on purpose:
// addons-core breaks its import cycle with addons-loader, i18n.ts loads every
// catalog lazily while a few English catalogs are needed synchronously, and the
// Tauri adapter imports these Tauri APIs statically. Rolldown warns
// (INEFFECTIVE_DYNAMIC_IMPORT) that such an import() can't split the module out;
// the warning stays on for other module paths.
const intendedMixedImports = [
  "/@tauri-apps/api/core.js",
  "/@tauri-apps/api/event.js",
  "/@tauri-apps/plugin-dialog/dist-js/index.js",
  "/@tauri-apps/plugin-fs/dist-js/index.js",
  "/src/addons/addons-loader.ts",
  "/src/i18n/locales/en/activity.json",
  "/src/i18n/locales/en/settings.json",
  "/src/i18n/locales/en/spending.json",
  "/src/i18n/locales/en/taxonomies.json",
];

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "../..",
  plugins: [react(), tailwindcss()],
  publicDir: "public",
  optimizeDeps: {
    include: ["lucide-react", "recharts", "@tauri-apps/plugin-barcode-scanner"],
  },
  define: {
    __BUILD_TARGET__: JSON.stringify(buildTarget),
  },
  resolve: {
    alias: {
      "@wealthfolio/addon-sdk": path.resolve(import.meta.dirname, "../../packages/addon-sdk/src"),
      "@wealthfolio/ui": path.resolve(import.meta.dirname, "../../packages/ui/src"),
      // Conditional adapter alias based on build target
      "@/adapters": path.resolve(
        import.meta.dirname,
        buildTarget === "tauri" ? "./src/adapters/tauri" : "./src/adapters/web",
      ),
      // Platform-specific core module for shared adapters
      "#platform": path.resolve(
        import.meta.dirname,
        buildTarget === "tauri" ? "./src/adapters/tauri/core" : "./src/adapters/web/core",
      ),
      "@": path.resolve(import.meta.dirname, "./src"),
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
  // Connect storage settings belong to Rust; expose only public app configuration.
  envPrefix: [
    "VITE_",
    "TAURI_",
    "CONNECT_API_URL",
    "CONNECT_AUTH_URL",
    "CONNECT_AUTH_PUBLISHABLE_KEY",
    "CONNECT_OAUTH_CALLBACK_URL",
  ],
  build: {
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    // Output to project root's dist folder (for Tauri)
    outDir: "../../dist",
    // outDir is outside the Vite root, so Vite won't clean it by default —
    // stale hashed bundles then accumulate and Tauri embeds the ENTIRE dist
    // tree into release builds (tauri.conf.json frontendDist).
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        "addon-sandbox": path.resolve(import.meta.dirname, "addon-sandbox.html"),
      },
      onwarn(warning, warn) {
        const id = warning.code === "INEFFECTIVE_DYNAMIC_IMPORT" ? warning.id : undefined;
        if (id && intendedMixedImports.some((suffix) => id.endsWith(suffix))) return;
        warn(warning);
      },
    },
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? "oxc" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    // Vitest 5 clears mock calls before every test by default; keep Vitest 4's
    // behaviour so tests that count calls made in beforeAll or at module load hold.
    clearMocks: false,
  },
} as unknown as import("vitest/config").UserConfigExport);
