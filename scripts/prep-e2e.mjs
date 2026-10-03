import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.web");

const pad = (value) => String(value).padStart(2, "0");

const getTimestamp = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
};

const setEnvValue = (content, key, value) => {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  return `${content.trimEnd()}\n${line}\n`;
};

export const prepareE2eEnvContent = (content, dataDirectory) => {
  // The registry and per-profile databases live beside WF_DB_PATH. A new filename
  // in a shared directory would still reuse the previous run's profiles and vault.
  let updated = setEnvValue(content, "WF_DATA_DIR", dataDirectory);
  updated = setEnvValue(updated, "WF_DB_PATH", join(dataDirectory, "app.db"));
  updated = setEnvValue(updated, "WF_SECRET_FILE", join(dataDirectory, "vault.bin"));
  updated = setEnvValue(updated, "WF_ADDONS_DIR", join(dataDirectory, "addons"));

  updated = setEnvValue(updated, "WF_AUTH_PASSWORD_HASH", "");
  updated = setEnvValue(updated, "WF_AUTH_REQUIRED", "false");
  updated = setEnvValue(updated, "WF_OIDC_ISSUER_URL", "");
  updated = setEnvValue(updated, "WF_OIDC_CLIENT_ID", "");
  updated = setEnvValue(updated, "WF_OIDC_CLIENT_SECRET", "");

  return updated;
};

export const prepE2eEnv = async () => {
  const content = await readFile(ENV_PATH, "utf8");
  const dbRoot = join(dirname(ENV_PATH), "db");
  await mkdir(dbRoot, { recursive: true });
  const dataDirectory = await mkdtemp(join(dbRoot, `app-testing-${getTimestamp()}-`));
  const updated = prepareE2eEnvContent(content, dataDirectory);
  await writeFile(ENV_PATH, updated);
  console.log(`Updated .env.web to use isolated data directory ${dataDirectory}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepE2eEnv();
}
