import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.web");
const SECRET_KEY_NAMES = ["WF_SECRET_KEY", "WF_SECRET_KEY_FILE"];
const SECRET_KEY_FILENAME = "secret.key";

const pad = (value) => String(value).padStart(2, "0");

const getTimestamp = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
};

// Matches the first assignment as dev:web reads it: it trims the line and the name, and the
// first assignment of a name wins.
const assignmentPattern = (key) => new RegExp(`^[^\\S\\r\\n]*${key}[^\\S\\r\\n]*=(.*)$`, "m");

const setEnvValue = (content, key, value) => {
  const line = `${key}=${value}`;
  const pattern = assignmentPattern(key);

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  return `${content.trimEnd()}\n${line}\n`;
};

const getEnvValue = (content, key) => {
  const value = content.match(assignmentPattern(key))?.[1].trim() ?? "";
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
};

// dev:web keeps a shell value over .env.web, and the server treats empty values as unset.
export const hasSecretKey = (content, env) =>
  SECRET_KEY_NAMES.some((key) => (env[key] ?? getEnvValue(content, key)) !== "");

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
  // The agent access specs create tokens, which the server offers only with MCP on.
  updated = setEnvValue(updated, "WF_MCP_ENABLED", "true");

  return updated;
};

export const prepE2eEnv = async ({ envPath = ENV_PATH, env = process.env } = {}) => {
  let content;
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(`${envPath}.example`, envPath, constants.COPYFILE_EXCL);
    console.log("Created .env.web from .env.web.example");
    content = await readFile(envPath, "utf8");
  }
  const dbRoot = join(dirname(envPath), "db");
  await mkdir(dbRoot, { recursive: true });
  const dataDirectory = await mkdtemp(join(dbRoot, `app-testing-${getTimestamp()}-`));
  let updated = prepareE2eEnvContent(content, dataDirectory);
  // A key file from an earlier run belongs to that run's data directory, which may be gone.
  const keyFile = getEnvValue(updated, "WF_SECRET_KEY_FILE");
  if (
    basename(keyFile) === SECRET_KEY_FILENAME &&
    dirname(dirname(keyFile)) === dbRoot &&
    basename(dirname(keyFile)).startsWith("app-testing-")
  ) {
    updated = setEnvValue(updated, "WF_SECRET_KEY_FILE", "");
  }
  // Only when no key is configured: the server refuses both settings at once, and replacing
  // a configured key would leave the user's own vault unreadable.
  if (!hasSecretKey(updated, env)) {
    const keyFile = join(dataDirectory, SECRET_KEY_FILENAME);
    await writeFile(keyFile, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    updated = setEnvValue(updated, "WF_SECRET_KEY_FILE", keyFile);
    // dev:web would keep an empty value exported by the shell over the one in .env.web.
    env.WF_SECRET_KEY_FILE = keyFile;
    // The server then loads the root .env for names still unset; keep its key out.
    if (!assignmentPattern("WF_SECRET_KEY").test(updated)) {
      updated = setEnvValue(updated, "WF_SECRET_KEY", "");
    }
    env.WF_SECRET_KEY ??= "";
  }
  await writeFile(envPath, updated);
  console.log(`Updated .env.web to use isolated data directory ${dataDirectory}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepE2eEnv();
}
