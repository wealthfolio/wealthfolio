#!/usr/bin/env node
// @ts-nocheck

/**
 * Addon Development Server
 *
 * A simple development server for hot reloading addons during development.
 * This server watches for file changes and provides a hot reload endpoint.
 */

const express = require("express");
const cors = require("cors");
const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

class AddonDevServer {
  constructor(config) {
    this.config = config;
    this.app = express();
    this.lastModified = new Date();
    this.buildInProgress = false;
    this.viteWatcher = null;

    this.setupMiddleware();
    this.setupRoutes();
    this.setupFileWatcher();
    this.startViteWatcher();
  }

  setupMiddleware() {
    this.app.use(
      cors({
        origin: ["http://localhost:1420", "http://localhost:3000"],
        credentials: true,
      }),
    );
    this.app.use(express.static(this.config.addonPath));
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        addonPath: this.config.addonPath,
      });
    });

    // Addon status endpoint
    this.app.get("/status", (req, res) => {
      res.json({
        lastModified: this.lastModified.toISOString(),
        buildInProgress: this.buildInProgress,
        files: this.getFileList(),
      });
    });

    // Serve addon manifest
    this.app.get("/manifest.json", (req, res) => {
      try {
        const manifestPath = path.resolve(this.config.manifestPath);
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
          res.json(manifest);
        } else {
          res.status(404).json({ error: "Manifest not found" });
        }
      } catch (error) {
        res.status(500).json({ error: "Failed to read manifest" });
      }
    });

    // Serve addon code
    this.app.get("/addon.js", async (req, res) => {
      try {
        const addonFile = path.resolve(this.config.addonPath, "dist/addon.js");
        console.log(`📦 Serving addon.js from: ${addonFile}`);

        // Wait for file to exist (with timeout)
        const fileExists = await this.waitForFile(addonFile, 3000);

        if (fileExists) {
          const code = fs.readFileSync(addonFile, "utf-8");
          res.type("application/javascript").send(code);
        } else {
          console.error(`❌ Addon file not found at: ${addonFile}`);
          res
            .status(404)
            .json({ error: "Addon file not found. Run build first.", path: addonFile });
        }
      } catch (error) {
        console.error(`❌ Error serving addon.js:`, error);
        res.status(500).json({ error: "Failed to read addon file", details: error.message });
      }
    });

    // Hot reload endpoint
    this.app.get("/reload", (req, res) => {
      res.json({
        message: "Reload triggered",
        timestamp: new Date().toISOString(),
      });

      // Trigger rebuild if configured
      if (this.config.buildCommand) {
        this.triggerBuild();
      }
    });

    // File listing for debugging
    this.app.get("/files", (req, res) => {
      res.json({
        files: this.getFileList(),
        watchPaths: this.config.watchPaths,
      });
    });

    // Test endpoint for connectivity
    this.app.get("/test", (req, res) => {
      res.json({
        message: "Addon development server is working!",
        addonPath: this.config.addonPath,
        timestamp: new Date().toISOString(),
        manifest: this.getManifestInfo(),
      });
    });

    // Debug endpoint for troubleshooting
    this.app.get("/debug", (req, res) => {
      const addonFile = path.resolve(this.config.addonPath, "dist/addon.js");
      res.json({
        lastModified: this.lastModified.toISOString(),
        buildInProgress: this.buildInProgress,
        files: this.getFileList(),
        watchPaths: this.config.watchPaths,
        viteWatcherRunning: this.viteWatcher !== null,
        addonFile: {
          path: addonFile,
          exists: fs.existsSync(addonFile),
          size: fs.existsSync(addonFile) ? fs.statSync(addonFile).size : 0,
        },
        config: {
          port: this.config.port,
          buildCommand: this.config.buildCommand,
        },
      });
    });

    // Simple ping endpoint
    this.app.get("/ping", (req, res) => {
      res.json({ message: "pong", timestamp: new Date().toISOString() });
    });
  }

  setupFileWatcher() {
    const watcher = chokidar.watch(this.config.watchPaths, {
      ignored: /node_modules|\.git/,
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on("change", (filePath) => {
      console.log(`📝 File changed: ${filePath}`);
      // Don't trigger manual build since Vite is already watching
      // Just update the timestamp for status endpoint
      this.lastModified = new Date();
    });

    watcher.on("add", (filePath) => {
      console.log(`➕ File added: ${filePath}`);
      this.lastModified = new Date();
    });

    watcher.on("unlink", (filePath) => {
      console.log(`➖ File removed: ${filePath}`);
      this.lastModified = new Date();
    });

    console.log(`👀 Watching files: ${this.config.watchPaths.join(", ")}`);
  }

  async triggerBuild() {
    if (this.buildInProgress || !this.config.buildCommand) return;

    this.buildInProgress = true;
    console.log(`🔨 Building addon with: ${this.config.buildCommand}`);

    try {
      await execAsync(this.config.buildCommand, {
        cwd: this.config.addonPath,
      });

      console.log("✅ Build completed successfully");
      this.lastModified = new Date();
    } catch (error) {
      console.error("❌ Build failed:", error);
    } finally {
      this.buildInProgress = false;
    }
  }

  getFileList() {
    try {
      const distPath = path.resolve(this.config.addonPath, "dist");
      if (fs.existsSync(distPath)) {
        return fs.readdirSync(distPath).map((file) => `dist/${file}`);
      }
      return [];
    } catch (error) {
      return [];
    }
  }

  getManifestInfo() {
    try {
      const manifestPath = path.resolve(this.config.manifestPath);
      if (fs.existsSync(manifestPath)) {
        return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Wait for a file to exist with timeout
   */
  async waitForFile(filePath, timeout = 3000) {
    const startTime = Date.now();
    const checkInterval = 100;

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(filePath)) {
        // Additional check to ensure file is fully written
        try {
          const stats = fs.statSync(filePath);
          if (stats.size > 0) {
            return true;
          }
        } catch (err) {
          // File might be in the process of being written
        }
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return false;
  }

  startViteWatcher() {
    if (!this.config.buildCommand) return;

    console.log("🔨 Starting Vite in watch mode...");

    // Start vite build in watch mode
    const { spawn } = require("child_process");
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    this.viteWatcher = spawn(pnpmCommand, ["run", "dev"], {
      cwd: this.config.addonPath,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    this.viteWatcher.stdout.on("data", (data) => {
      const output = data.toString();
      console.log(`Vite output: ${output.trim()}`);

      if (output.includes("build started")) {
        this.buildInProgress = true;
      }

      if (output.includes("built in")) {
        console.log(`✅ Vite rebuild completed`);
        this.lastModified = new Date();
        this.buildInProgress = false;
      }

      if (output.includes("watching for file changes")) {
        console.log(`✅ Vite watcher ready`);
        this.buildInProgress = false;
      }
    });

    this.viteWatcher.stderr.on("data", (data) => {
      console.error(`Vite error: ${data}`);
    });

    this.viteWatcher.on("close", (code) => {
      if (code !== 0) {
        console.error(`Vite watcher exited with code ${code}`);
      }
    });
  }

  start() {
    this.app.listen(this.config.port, () => {
      console.log(`🚀 Addon dev server running on http://localhost:${this.config.port}`);
      console.log(`📁 Serving from: ${this.config.addonPath}`);
      console.log(`📋 Manifest: ${this.config.manifestPath}`);
      console.log(`👀 Watching files: ${this.config.watchPaths.join(", ")}`);

      if (this.config.buildCommand) {
        console.log(`🔨 Build command: ${this.config.buildCommand}`);
      }
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      this.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      this.stop();
      process.exit(0);
    });
  }

  stop() {
    console.log("🛑 Shutting down dev server...");

    if (this.viteWatcher) {
      this.viteWatcher.kill("SIGTERM");
      this.viteWatcher = null;
    }
  }
}

// CLI interface
function main() {
  const args = process.argv.slice(2);
  const addonPath = args[0] || process.cwd();
  const port = parseInt(args[1]) || 3001;

  const config = {
    port,
    addonPath: path.resolve(addonPath),
    manifestPath: path.resolve(addonPath, "manifest.json"),
    buildCommand: "pnpm run build",
    watchPaths: [path.resolve(addonPath, "src"), path.resolve(addonPath, "manifest.json")],
  };

  // Check if addon directory exists
  if (!fs.existsSync(config.addonPath)) {
    console.error(`❌ Addon directory not found: ${config.addonPath}`);
    process.exit(1);
  }

  // Check if manifest exists
  if (!fs.existsSync(config.manifestPath)) {
    console.error(`❌ Manifest not found: ${config.manifestPath}`);
    process.exit(1);
  }

  const server = new AddonDevServer(config);
  server.start();
}

// Export for use as a module
module.exports = { AddonDevServer };

// Run if called directly
if (require.main === module) {
  main();
}
