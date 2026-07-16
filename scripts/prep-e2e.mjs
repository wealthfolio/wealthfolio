import { readFile, writeFile } from "node:fs/promises";
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

const replaceDbPath = (content, timestamp) => {
  if (!content.includes("WF_DB_PATH=")) {
    throw new Error("WF_DB_PATH entry not found in .env.web");
  }

  return content.replace(/^WF_DB_PATH=.*$/m, `WF_DB_PATH=./db/app-testing-${timestamp}.db`);
};

const setEnvValue = (content, key, value) => {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  return `${content.trimEnd()}\n${line}\n`;
};

const prepareE2eEnvContent = (content, timestamp) => {
  let updated = replaceDbPath(content, timestamp);

  updated = setEnvValue(updated, "WF_AUTH_PASSWORD_HASH", "");
  updated = setEnvValue(updated, "WF_AUTH_REQUIRED", "false");
  updated = setEnvValue(updated, "WF_OIDC_ISSUER_URL", "");
  updated = setEnvValue(updated, "WF_OIDC_CLIENT_ID", "");
  updated = setEnvValue(updated, "WF_OIDC_CLIENT_SECRET", "");

  return updated;
};

export const prepE2eEnv = async () => {
  const content = await readFile(ENV_PATH, "utf8");
  const timestamp = getTimestamp();
  const updated = prepareE2eEnvContent(content, timestamp);

  if (content === updated) {
    console.log("WF_DB_PATH already set for this run, no update required.");
    return;
  }

  await writeFile(ENV_PATH, updated);
  console.log(`Updated .env.web to use ./db/app-testing-${timestamp}.db`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepE2eEnv();
}
