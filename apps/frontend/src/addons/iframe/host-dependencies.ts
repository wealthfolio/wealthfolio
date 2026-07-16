import * as ReactQuery from "@tanstack/react-query";
import * as AddonSDK from "@wealthfolio/addon-sdk";
import * as AddonSDKGoalProgress from "@wealthfolio/addon-sdk/goal-progress";
import * as AddonSDKHostDependencies from "@wealthfolio/addon-sdk/host-dependencies";
import * as AddonSDKManifest from "@wealthfolio/addon-sdk/manifest";
import * as AddonSDKPermissions from "@wealthfolio/addon-sdk/permissions";
import * as AddonSDKQueryKeys from "@wealthfolio/addon-sdk/query-keys";
import * as AddonSDKUtils from "@wealthfolio/addon-sdk/utils";
import * as WealthfolioUI from "@wealthfolio/ui";
import * as WealthfolioUIChart from "@wealthfolio/ui/chart";
import * as DateFns from "date-fns";
import * as LucideReact from "lucide-react";
import * as React from "react";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as Recharts from "recharts";

interface HostDependencyModule {
  defaultExport?: unknown;
  module: Record<string, unknown>;
}

declare global {
  // Host-provided ESM bridge used by generated blob modules in the sandbox.
  // eslint-disable-next-line no-var
  var __wealthfolioHostModules: Record<string, HostDependencyModule> | undefined;
}

const emptyModule: Record<string, unknown> = {};

const HOST_DEPENDENCIES: Record<string, HostDependencyModule> = {
  "@tanstack/react-query": { module: ReactQuery },
  "@wealthfolio/addon-sdk": { module: AddonSDK },
  "@wealthfolio/addon-sdk/goal-progress": { module: AddonSDKGoalProgress },
  "@wealthfolio/addon-sdk/host-api": { module: emptyModule },
  "@wealthfolio/addon-sdk/host-dependencies": { module: AddonSDKHostDependencies },
  "@wealthfolio/addon-sdk/manifest": { module: AddonSDKManifest },
  "@wealthfolio/addon-sdk/permissions": { module: AddonSDKPermissions },
  "@wealthfolio/addon-sdk/query-keys": { module: AddonSDKQueryKeys },
  "@wealthfolio/addon-sdk/types": { module: emptyModule },
  "@wealthfolio/addon-sdk/utils": { module: AddonSDKUtils },
  "@wealthfolio/ui": { module: WealthfolioUI },
  "@wealthfolio/ui/chart": { module: WealthfolioUIChart },
  "date-fns": { module: DateFns },
  "lucide-react": { module: LucideReact },
  react: { defaultExport: React, module: React },
  "react-dom": { defaultExport: ReactDOM, module: ReactDOM },
  "react-dom/client": { defaultExport: ReactDOMClient, module: ReactDOMClient },
  "react/jsx-dev-runtime": { module: ReactJSXDevRuntime },
  "react/jsx-runtime": { module: ReactJSXRuntime },
  recharts: { module: Recharts },
};

const validExportName = /^[$A-Z_a-z][$\w]*$/;

Object.assign(globalThis, {
  React,
  ReactDOM,
  ReactDOMClient,
  __wealthfolioHostModules: HOST_DEPENDENCIES,
});

export const HOST_DEPENDENCY_VERSION_RANGES = {
  "@tanstack/react-query": "^5.90.0",
  "@wealthfolio/addon-sdk": "^3.6.0",
  "@wealthfolio/ui": "^3.6.0",
  "date-fns": "^4.1.0",
  "lucide-react": "^0.561.0",
  react: "^19.2.0",
  "react-dom": "^19.2.0",
  recharts: "^3.7.0",
} as const;

export function isHostDependencySpecifier(specifier: string) {
  return Object.prototype.hasOwnProperty.call(HOST_DEPENDENCIES, specifier);
}

export function createHostDependencyModuleUrl(specifier: string, objectUrls: Map<string, string>) {
  const module = HOST_DEPENDENCIES[specifier];
  if (!module) {
    return undefined;
  }

  const urlKey = `host:${specifier}`;
  const existingUrl = objectUrls.get(urlKey);
  if (existingUrl) {
    return existingUrl;
  }

  const namedExports = Object.keys(module.module)
    .filter((name) => name !== "default" && validExportName.test(name))
    .sort()
    .map((name) => `export const ${name} = module[${JSON.stringify(name)}];`)
    .join("\n");

  const source = `
const hostModule = globalThis.__wealthfolioHostModules?.[${JSON.stringify(specifier)}];
if (!hostModule) {
  throw new Error("Host dependency is not available: ${specifier}");
}
const module = hostModule.module;
const defaultExport = hostModule.defaultExport ?? module.default ?? module;
export default defaultExport;
${namedExports}
`;

  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  objectUrls.set(urlKey, url);
  return url;
}
