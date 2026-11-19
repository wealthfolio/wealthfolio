import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const policy = JSON.parse(
  readFileSync(new URL("../config/timeouts.json", import.meta.url), "utf8"),
);

function routeRegex(pattern) {
  const [prefix, suffix] = pattern.split("*");
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return suffix === undefined
    ? escape(prefix)
    : `${escape(prefix)}${suffix ? "[^/]+" : ".*"}${escape(suffix)}`;
}

// Include the output inside an NGINX server block. The operator supplies the
// wealthfolio_backend upstream, TLS, and the frontend/static-file location.
export function nginxTimeoutLocations() {
  const block = (location, profile) =>
    [
      `${location} {`,
      "    proxy_pass http://wealthfolio_backend;",
      "    proxy_set_header Host $http_host;",
      "    proxy_set_header X-Forwarded-Proto $scheme;",
      `    proxy_read_timeout ${profile.proxyMs / 1000}s;`,
      `    proxy_send_timeout ${profile.proxyMs / 1000}s;`,
      "}",
    ].join("\n");
  return [
    "# Generated from config/timeouts.json; preserve rule order.",
    "# Timeouts only: preserve body-size, authentication and streaming settings; see docs/self-host/timeouts.md.",
    ...policy.rules.map((rule) =>
      block(
        `location ~ ^/api/v1(?:${rule.paths.map(routeRegex).join("|")})$`,
        policy.profiles[rule.profile],
      ),
    ),
    block("location /api/v1/", policy.profiles.interactive),
    "",
  ].join("\n\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(nginxTimeoutLocations());
}
