import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nginxTimeoutLocations } from "./print-timeout-proxy.mjs";

test("generated NGINX locations preserve special-route precedence and response margins", () => {
  const output = nginxTimeoutLocations();
  const locations = [...output.matchAll(/location ~ (.+) \{\n([\s\S]*?)\n\}/g)];
  for (const [path, expected] of [
    ["/api/v1/activities/import/assets/preview", 660],
    ["/api/v1/activities/import/check", 660],
    ["/api/v1/snapshots/import/check", 660],
    ["/api/v1/activities/import/parse", 330],
    ["/api/v1/activities/import", 330],
    ["/api/v1/snapshots/import", 330],
    ["/api/v1/performance/history", 330],
    ["/api/v1/cloud-backups/capture", 1980],
    ["/api/v1/cloud-backups/action", 330],
    ["/api/v1/connect/device/trigger-cycle", 330],
    ["/api/v1/taxonomies/migration/run", 330],
    ["/api/v1/sync/team/reset", 330],
    ["/api/v1/utilities/database/backups/a%2Fb/export", 1980],
  ]) {
    const selected = locations.find(([, regex]) => new RegExp(regex).test(path));
    assert.ok(selected, path);
    assert.match(selected[2], new RegExp(`proxy_read_timeout ${expected}s;`), path);
    assert.match(selected[2], /proxy_pass http:\/\/wealthfolio_backend;/);
    assert.match(selected[2], /proxy_set_header Host \$http_host;/);
  }
  assert.ok(!locations.some(([, regex]) => new RegExp(regex).test("/api/v1/accounts")));
  assert.match(output, /location \/api\/v1\/ \{[\s\S]*proxy_read_timeout 75s;/);
});

test("Docker and the web environment example defer to shared server defaults", () => {
  const compose = readFileSync(new URL("../compose.yml", import.meta.url), "utf8");
  const example = readFileSync(new URL("../.env.web.example", import.meta.url), "utf8");
  assert.match(compose, /WF_REQUEST_TIMEOUT_MS: "\$\{WF_REQUEST_TIMEOUT_MS:-\}"/);
  assert.match(example, /^WF_REQUEST_TIMEOUT_MS=$/m);
});
