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
const { createHash } = require("crypto");

const execAsync = promisify(exec);
const MAX_RUNTIME_PACKAGE_ENTRIES = 256;
const MAX_RUNTIME_ASSET_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RUNTIME_ASSET_TOTAL_SIZE = 25 * 1024 * 1024;
const MAX_RUNTIME_PACKAGE_GENERATIONS = 4;

function runtimeAssetMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".avif": "image/avif",
      ".bmp": "image/bmp",
      ".css": "text/css",
      ".csv": "text/csv",
      ".gif": "image/gif",
      ".html": "text/html",
      ".ico": "image/x-icon",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".md": "text/markdown",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".ogg": "audio/ogg",
      ".otf": "font/otf",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".txt": "text/plain",
      ".wasm": "application/wasm",
      ".wav": "audio/wav",
      ".webm": "video/webm",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".xml": "application/xml",
    }[extension] || "application/octet-stream"
  );
}

function walkRuntimeFiles(rootPath, visit) {
  if (!fs.existsSync(rootPath)) return;
  const rootStats = fs.lstatSync(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Runtime asset root is not a regular directory: ${rootPath}`);
  }
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Runtime assets cannot contain symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      walkRuntimeFiles(entryPath, visit);
    } else if (entry.isFile()) {
      visit(entryPath);
    }
  }
}

function getRuntimePackageEntries(addonPath) {
  const entries = [];
  let totalSize = 0;
  for (const root of [path.join(addonPath, "dist"), path.join(addonPath, "assets")]) {
    walkRuntimeFiles(root, (filePath) => {
      const logicalPath = path.relative(addonPath, filePath).split(path.sep).join("/");
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".map") return;
      if ([".gitkeep", ".ds_store"].includes(path.basename(filePath).toLowerCase())) return;
      const kind =
        extension === ".js" || extension === ".css"
          ? "text"
          : logicalPath.startsWith("assets/") || logicalPath.startsWith("dist/assets/")
            ? "asset"
            : undefined;
      if (!kind) return;
      if (entries.length >= MAX_RUNTIME_PACKAGE_ENTRIES) {
        throw new Error("Runtime package contains more than 256 files");
      }
      const size = fs.statSync(filePath).size;
      if (size > MAX_RUNTIME_ASSET_FILE_SIZE) {
        throw new Error(`Runtime package file exceeds 5 MiB: ${filePath}`);
      }
      totalSize += size;
      if (totalSize > MAX_RUNTIME_ASSET_TOTAL_SIZE) {
        throw new Error("Runtime package exceeds the 25 MiB package limit");
      }
      entries.push({ extension, filePath, kind, logicalPath, size });
    });
  }
  return entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function runtimeAssetId(logicalPath, content) {
  return createHash("sha256").update(logicalPath).update("\0").update(content).digest("hex");
}

function readRuntimeEntry(entry) {
  const content = fs.readFileSync(entry.filePath);
  if (content.length !== entry.size) {
    throw new Error(`Runtime package changed while it was being indexed: ${entry.filePath}`);
  }
  return content;
}

function runtimeAssetsFromEntries(entries) {
  return entries
    .filter((entry) => entry.kind === "asset")
    .map((entry) => {
      const content = readRuntimeEntry(entry);
      return {
        content,
        descriptor: {
          id: runtimeAssetId(entry.logicalPath, content),
          mimeType: runtimeAssetMimeType(entry.filePath),
          path: entry.logicalPath,
          size: content.length,
        },
      };
    });
}

function runtimeTextFilesFromEntries(entries) {
  return entries
    .filter((entry) => entry.kind === "text")
    .map((entry) => ({
      content: readRuntimeEntry(entry).toString("utf8"),
      isMain: entry.logicalPath === "dist/addon.js",
      name: entry.logicalPath,
    }));
}

function getRuntimeAssets(addonPath) {
  return runtimeAssetsFromEntries(getRuntimePackageEntries(addonPath));
}

function getRuntimeTextFiles(addonPath) {
  return runtimeTextFilesFromEntries(getRuntimePackageEntries(addonPath));
}

function shouldPublishRuntimeFileChange(config, filePath) {
  if (!config.buildCommand) return true;
  const absolutePath = path.resolve(filePath);
  const manifestPath = path.resolve(config.manifestPath);
  const assetRoot = path.resolve(config.addonPath, "assets");
  return absolutePath === manifestPath || absolutePath.startsWith(`${assetRoot}${path.sep}`);
}

class RuntimePackageRegistry {
  constructor(addonPath, manifestPath = path.join(addonPath, "manifest.json")) {
    this.addonPath = addonPath;
    this.manifestPath = manifestPath;
    this.currentGeneration = 0;
    this.snapshots = new Map();
  }

  createSnapshot() {
    const entries = getRuntimePackageEntries(this.addonPath);
    const manifest = fs.existsSync(this.manifestPath)
      ? JSON.parse(fs.readFileSync(this.manifestPath, "utf8"))
      : null;
    return {
      assets: runtimeAssetsFromEntries(entries),
      files: runtimeTextFilesFromEntries(entries),
      manifest,
    };
  }

  refresh() {
    const generation = this.currentGeneration + 1;
    const snapshot = { generation, ...this.createSnapshot() };
    this.snapshots.set(generation, snapshot);
    this.currentGeneration = generation;
    while (this.snapshots.size > MAX_RUNTIME_PACKAGE_GENERATIONS) {
      this.snapshots.delete(this.snapshots.keys().next().value);
    }
    return snapshot;
  }

  getSnapshot(generation) {
    if (this.currentGeneration === 0) {
      throw new Error("No runtime package generation has been published");
    }
    const requestedGeneration = generation ?? this.currentGeneration;
    const snapshot = this.snapshots.get(requestedGeneration);
    if (!snapshot) {
      throw new Error(`Runtime package generation is no longer available: ${requestedGeneration}`);
    }
    return snapshot;
  }

  getPackage(generation) {
    return this.getSnapshot(generation);
  }

  getAssets(generation) {
    return this.getSnapshot(generation).assets;
  }

  getTextFiles(generation) {
    return this.getSnapshot(generation).files;
  }

  getManifest(generation) {
    return this.getSnapshot(generation).manifest;
  }

  getGeneration() {
    return this.currentGeneration;
  }
}

class AddonDevServer {
  constructor(config) {
    this.config = config;
    this.app = express();
    this.lastModified = new Date();
    this.buildInProgress = false;
    this.viteWatcher = null;
    this.publishTimer = null;
    this.runtimePackageRegistry = new RuntimePackageRegistry(
      this.config.addonPath,
      this.config.manifestPath,
    );
    this.publishRuntimePackage();

    this.setupMiddleware();
    this.setupRoutes();
    this.app.use(express.static(this.config.addonPath));
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
        generation: this.runtimePackageRegistry.getGeneration(),
        files: this.getFileList(),
      });
    });

    // Serve addon manifest
    this.app.get("/manifest.json", (req, res) => {
      try {
        const manifest = this.runtimePackageRegistry.getManifest();
        if (manifest) {
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
          const code = this.runtimePackageRegistry
            .getTextFiles()
            .find((file) => file.isMain)?.content;
          if (code === undefined) {
            res.status(404).json({ error: "Addon entry point is not in the published package" });
            return;
          }
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

    this.app.get("/runtime-package", (req, res) => {
      try {
        const runtimePackage = this.runtimePackageRegistry.getPackage();
        const mainFile = runtimePackage.files.find((file) => file.isMain);
        if (!mainFile) {
          res.status(409).json({ error: "Runtime package has no published addon entry point" });
          return;
        }
        res.set("Cache-Control", "no-store");
        res.json({
          assets: runtimePackage.assets.map((asset) => asset.descriptor),
          files: runtimePackage.files,
          generation: runtimePackage.generation,
          manifest: runtimePackage.manifest,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Metadata-only package registry used by the opaque iframe asset broker.
    this.app.get("/runtime-assets", (req, res) => {
      try {
        res.set("Cache-Control", "no-store");
        res.json(this.runtimePackageRegistry.getAssets().map((asset) => asset.descriptor));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get("/runtime-assets/:assetId", (req, res) => {
      try {
        const requestedGeneration =
          req.query.generation === undefined ? undefined : Number(req.query.generation);
        if (
          requestedGeneration !== undefined &&
          (!Number.isSafeInteger(requestedGeneration) || requestedGeneration < 1)
        ) {
          res.status(400).json({ error: "Invalid runtime package generation" });
          return;
        }
        const asset = this.runtimePackageRegistry
          .getAssets(requestedGeneration)
          .find((candidate) => candidate.descriptor.id === req.params.assetId);
        if (!asset) {
          res.status(404).json({ error: "Runtime asset not found" });
          return;
        }
        res.set("Cache-Control", "no-store");
        res.type(asset.descriptor.mimeType).send(asset.content);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get("/runtime-files", (req, res) => {
      try {
        res.set("Cache-Control", "no-store");
        res.json(this.runtimePackageRegistry.getTextFiles());
      } catch (error) {
        res.status(500).json({ error: error.message });
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
      this.handleRuntimeFileChange(filePath);
    });

    watcher.on("add", (filePath) => {
      console.log(`➕ File added: ${filePath}`);
      this.handleRuntimeFileChange(filePath);
    });

    watcher.on("unlink", (filePath) => {
      console.log(`➖ File removed: ${filePath}`);
      this.handleRuntimeFileChange(filePath);
    });

    console.log(`👀 Watching files: ${this.config.watchPaths.join(", ")}`);
  }

  handleRuntimeFileChange(filePath) {
    // Source and dist events are intermediate Vite states. The Vite completion
    // signal publishes their next coherent package generation.
    if (shouldPublishRuntimeFileChange(this.config, filePath)) {
      this.scheduleRuntimePackagePublish();
    }
  }

  scheduleRuntimePackagePublish() {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.buildInProgress) {
        this.scheduleRuntimePackagePublish();
        return;
      }
      this.publishRuntimePackage();
    }, 100);
  }

  publishRuntimePackage() {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    try {
      const runtimePackage = this.runtimePackageRegistry.refresh();
      this.lastModified = new Date();
      return runtimePackage;
    } catch (error) {
      console.error("❌ Failed to publish runtime package:", error);
      return null;
    }
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
      this.publishRuntimePackage();
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
    this.viteWatcher = spawn("pnpm", ["run", "dev"], {
      cwd: this.config.addonPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.viteWatcher.stdout.on("data", (data) => {
      const output = data.toString();
      console.log(`Vite output: ${output.trim()}`);

      if (output.includes("build started")) {
        this.buildInProgress = true;
      }

      if (output.includes("built in")) {
        console.log(`✅ Vite rebuild completed`);
        this.publishRuntimePackage();
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
    this.app.listen(this.config.port, (error) => {
      // Express 5 passes listen errors (such as a port in use) here instead of
      // emitting them; rethrow so the server stops, as it did on Express 4.
      if (error) throw error;
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

    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
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
    watchPaths: [
      path.resolve(addonPath, "src"),
      path.resolve(addonPath, "assets"),
      path.resolve(addonPath, "dist"),
      path.resolve(addonPath, "manifest.json"),
    ],
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
module.exports = {
  AddonDevServer,
  RuntimePackageRegistry,
  getRuntimeAssets,
  getRuntimeTextFiles,
  shouldPublishRuntimeFileChange,
};

// Run if called directly
if (require.main === module) {
  main();
}
