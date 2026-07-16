#!/usr/bin/env node

/**
 * Wealthfolio Addon CLI
 *
 * Command-line tool for developing, building, and managing addons
 */

const { program } = require("commander");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { AddonScaffold } = require("./scaffold");

const execAsync = promisify(exec);

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function error(message) {
  log(`❌ ${message}`, colors.red);
}

function success(message) {
  log(`✅ ${message}`, colors.green);
}

function info(message) {
  log(`ℹ️  ${message}`, colors.blue);
}

function warn(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

// Initialize scaffold service
const scaffold = new AddonScaffold();

// Command: create
async function createAddon(name, options) {
  try {
    info(`Creating new addon: ${name}`);

    // Prepare configuration
    const config = {
      name,
      description: options.description,
      author: options.author,
    };

    // Validate configuration
    const validationErrors = scaffold.validateConfig(config);
    if (validationErrors.length > 0) {
      error("Configuration errors:");
      validationErrors.forEach((err) => error(`  - ${err}`));
      return;
    }

    // Interactive prompts for missing information
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (interactive && (!config.description || !config.author)) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        if (!config.description) {
          const defaultDesc = `A Wealthfolio addon for ${name}`;
          const answer = (await rl.question(`Description [${defaultDesc}]: `)).trim();
          config.description = answer.length > 0 ? answer : defaultDesc;
        }
        if (!config.author) {
          const defaultAuthor = "Anonymous";
          const answer = (await rl.question(`Author [${defaultAuthor}]: `)).trim();
          config.author = answer.length > 0 ? answer : defaultAuthor;
        }
      } finally {
        rl.close();
      }
    }

    // Set defaults for non-interactive mode
    if (!config.description) {
      config.description = `A Wealthfolio addon for ${name}`;
    }
    if (!config.author) {
      config.author = "Anonymous";
    }

    const addonId = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const addonDir = path.resolve(process.cwd(), addonId);

    // Check if directory already exists
    if (fs.existsSync(addonDir)) {
      error(`Directory ${addonId} already exists`);
      return;
    }

    // Add current date for changelog
    const currentDate = new Date().toISOString().split("T")[0];
    config.currentDate = currentDate;

    // Create addon using scaffold service
    const result = await scaffold.createAddon(config, addonDir);

    success(`Addon ${name} created successfully!`);
    info(`Directory: ${result.addonDir}`);
    info(`Addon ID: ${result.addonId}`);
    info(`Package name: ${result.packageName}`);
    info(`Structure created:`);
    info(`  ├── src/`);
    info(`  │   ├── addon.tsx           # Main addon entry point`);
    info(`  │   ├── components/         # React components`);
    info(`  │   ├── hooks/              # React hooks`);
    info(`  │   ├── pages/              # Addon pages`);
    info(`  │   ├── lib/                # Utility functions and shared logic`);
    info(`  │   └── types/              # Type definitions`);
    info(`  ├── dist/                   # Built files (generated)`);
    info(`  ├── manifest.json           # Addon metadata and permissions`);
    info(`  ├── package.json            # NPM package configuration`);
    info(`  ├── vite.config.ts          # Build configuration`);
    info(`  ├── tsconfig.json           # TypeScript configuration`);
    info(`  ├── CHANGELOG.md            # Version history and release notes`);
    info(`  └── README.md               # Documentation`);
    info(`Next steps:`);
    info(`  1. cd ${addonId}`);
    info(`  2. pnpm install`);
    info(`  3. pnpm run dev:server`);
  } catch (err) {
    error(`Failed to create addon: ${err.message}`);
  }
}

// Command: dev
async function startDev(port = 3001) {
  try {
    const manifestPath = path.resolve(process.cwd(), "manifest.json");

    if (!fs.existsSync(manifestPath)) {
      error("No manifest.json found. Are you in an addon directory?");
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    info(`Starting development server for ${manifest.name}`);
    info(`Server will run on http://localhost:${port}`);

    // Start the development server
    const devServerPath = path.resolve(__dirname, "dev-server.js");
    const child = spawn("node", [devServerPath, process.cwd(), port.toString()], {
      stdio: "inherit",
    });

    // Handle cleanup on exit
    process.on("SIGINT", () => {
      child.kill("SIGINT");
      process.exit(0);
    });

    child.on("exit", (code) => {
      process.exit(code);
    });
  } catch (err) {
    error(`Failed to start development server: ${err.message}`);
  }
}

// Command: build
async function buildAddon() {
  try {
    info("Building addon...");

    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      error("No package.json found. Are you in an addon directory?");
      return;
    }

    await execAsync("pnpm run build");
    success("Addon built successfully!");
  } catch (err) {
    error(`Build failed: ${err.message}`);
  }
}

// Command: package
async function packageAddon() {
  try {
    info("Packaging addon...");

    // Build first
    await buildAddon();

    // Create package
    await execAsync("pnpm run package");
    success("Addon packaged successfully!");
  } catch (err) {
    error(`Packaging failed: ${err.message}`);
  }
}

// Command: test
async function testSetup() {
  try {
    info("Testing addon development setup...");

    // Check if manifest exists
    const manifestPath = path.resolve(process.cwd(), "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      error("❌ No manifest.json found. Are you in an addon directory?");
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    success(`✅ Found manifest for: ${manifest.name}`);

    // Check if dist exists
    const distPath = path.resolve(process.cwd(), "dist");
    if (!fs.existsSync(distPath)) {
      warn("⚠️  No dist directory found. Run `pnpm run build` first.");
    } else {
      success("✅ Dist directory exists");
    }

    // Check if dev server is running
    try {
      const response = await fetch("http://localhost:3001/test");
      if (response.ok) {
        const data = await response.json();
        success("✅ Development server is running");
        info(`   Server message: ${data.message}`);
      }
    } catch (error) {
      warn("⚠️  Development server not running on port 3001");
      info("   Start it with: pnpm run dev:server");
    }

    info("\nNext steps:");
    info("1. Start dev server: pnpm run dev:server");
    info("2. Start main app in dev mode");
    info("3. Check console: discoverAddons()");
  } catch (err) {
    error(`Test failed: ${err.message}`);
  }
}

// Command: install
async function installAddon(zipPath) {
  try {
    info(`Installing addon from ${zipPath}`);

    // This would integrate with the main app's addon installation
    warn("Install command not yet implemented. Use the main app to install.");
  } catch (err) {
    error(`Installation failed: ${err.message}`);
  }
}

// CLI Setup
program.name("wealthfolio-addon").description("Wealthfolio Addon Development CLI").version("1.0.0");

program
  .command("create <name>")
  .description("Create a new addon")
  .option("-d, --description <desc>", "Addon description")
  .option("-a, --author <author>", "Addon author")
  .action(createAddon);

program
  .command("dev")
  .description("Start development server")
  .option("-p, --port <port>", "Port number", "3001")
  .action((options) => startDev(parseInt(options.port)));

program.command("build").description("Build the addon").action(buildAddon);

program.command("package").description("Package the addon for distribution").action(packageAddon);

program.command("test").description("Test addon development setup").action(testSetup);

program.command("install <zip>").description("Install an addon from zip file").action(installAddon);

program.parse();
