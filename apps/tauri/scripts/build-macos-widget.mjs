// Builds the macOS desktop widgets (apps/tauri/macos-widget) for one
// architecture and leaves WealthfolioWidget.appex in macos-widget/build/, where
// tauri.macos-widget.conf.json copies it into Wealthfolio.app/Contents/PlugIns.
//
//   node apps/tauri/scripts/build-macos-widget.mjs --arch arm64|x86_64
//     [--config <tauri config overlay>]  e.g. tauri.dev.conf.json for the dev app
//     [--sign <identity>]                defaults to APPLE_SIGNING_IDENTITY, else ad hoc
//
// The widget's bundle id and version follow the app's, which macOS requires.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readConfig(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The macOS widget builds only on macOS.");
  }
  const tauriDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const widgetDir = path.join(tauriDir, "macos-widget");
  const outDir = path.join(widgetDir, "build");

  const arch = option("arch") ?? (process.arch === "arm64" ? "arm64" : "x86_64");
  if (!["arm64", "x86_64"].includes(arch)) throw new Error(`Unknown --arch ${arch}`);

  const base = await readConfig(path.join(tauriDir, "tauri.conf.json"));
  const overlayPath = option("config");
  const overlay = overlayPath ? await readConfig(path.resolve(tauriDir, overlayPath)) : {};
  const identifier = overlay.identifier ?? base.identifier;
  const version = overlay.version ?? base.version;
  const buildNumber = base.bundle?.macOS?.bundleVersion ?? version;
  const identity = option("sign") ?? process.env.APPLE_SIGNING_IDENTITY ?? "-";

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const symroot = path.join(outDir, "xcode");
  execFileSync(
    "xcodebuild",
    [
      "-project",
      path.join(widgetDir, "WealthfolioWidget.xcodeproj"),
      "-target",
      "WealthfolioWidget",
      "-configuration",
      "Release",
      "-arch",
      arch,
      `SYMROOT=${symroot}`,
      `OBJROOT=${path.join(symroot, "obj")}`,
      // An extension's id must extend its app's.
      `PRODUCT_BUNDLE_IDENTIFIER=${identifier}.widget`,
      `MARKETING_VERSION=${version}`,
      `CURRENT_PROJECT_VERSION=${buildNumber}`,
      `CODE_SIGN_IDENTITY=${identity}`,
      // Notarization needs a secure timestamp; an ad hoc signature can't carry one.
      `OTHER_CODE_SIGN_FLAGS=${identity === "-" ? "" : "--timestamp"}`,
      "build",
    ],
    { stdio: "inherit" },
  );
  await cp(
    path.join(symroot, "Release", "WealthfolioWidget.appex"),
    path.join(outDir, "WealthfolioWidget.appex"),
    { recursive: true, verbatimSymlinks: true },
  );
  console.log(`Built ${identifier}.widget ${version} (${buildNumber}) for ${arch}.`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
