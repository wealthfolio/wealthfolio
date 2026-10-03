#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv";
const DEFAULT_OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../crates/market-data/src/resolver/iso10383.json",
);

function parseArguments(argv) {
  const options = { output: DEFAULT_OUTPUT, source: SOURCE_URL };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--publication-date" && value) {
      options.publicationDate = value;
      index += 1;
    } else if (argument === "--implementation-date" && value) {
      options.implementationDate = value;
      index += 1;
    } else if (argument === "--output" && value) {
      options.output = path.resolve(value);
      index += 1;
    } else if (argument === "--source" && value) {
      options.source = value;
      index += 1;
    } else if (argument === "--expected-sha256" && value) {
      options.expectedSha256 = value.toLowerCase();
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.publicationDate ?? "")) {
    throw new Error("--publication-date YYYY-MM-DD is required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.implementationDate ?? "")) {
    throw new Error("--implementation-date YYYY-MM-DD is required");
  }
  if (options.expectedSha256 && !/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
    throw new Error("--expected-sha256 must be a 64-character hexadecimal SHA-256");
  }
  return options;
}

async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`ISO 10383 download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(path.resolve(source));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function optional(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const options = parseArguments(process.argv.slice(2));
const sourceBytes = await readSource(options.source);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
if (options.expectedSha256 && sourceSha256 !== options.expectedSha256) {
  throw new Error(
    `ISO 10383 SHA-256 mismatch: expected ${options.expectedSha256}, received ${sourceSha256}`,
  );
}
const rows = parseCsv(sourceBytes.toString("utf8").replace(/^\uFEFF/, ""));
const headers = rows.shift();
if (!headers) throw new Error("ISO 10383 CSV has no header row");
const column = new Map(headers.map((header, index) => [header, index]));
const requiredColumns = [
  "MIC",
  "OPERATING MIC",
  "OPRT/SGMT",
  "MARKET NAME-INSTITUTION DESCRIPTION",
  "ISO COUNTRY CODE (ISO 3166)",
  "CITY",
  "STATUS",
  "CREATION DATE",
];
for (const required of requiredColumns) {
  if (!column.has(required)) throw new Error(`ISO 10383 CSV is missing column: ${required}`);
}
const read = (row, name) => row[column.get(name)] ?? "";

const records = rows
  .filter((row) => read(row, "MIC").trim())
  .map((row) => ({
    mic: read(row, "MIC").trim(),
    operatingMic: read(row, "OPERATING MIC").trim(),
    kind: read(row, "OPRT/SGMT").trim(),
    name: read(row, "MARKET NAME-INSTITUTION DESCRIPTION").trim(),
    acronym: optional(read(row, "ACRONYM")),
    countryCode: read(row, "ISO COUNTRY CODE (ISO 3166)").trim(),
    city: read(row, "CITY").trim(),
    status: read(row, "STATUS").trim(),
    creationDate: read(row, "CREATION DATE").trim(),
    lastUpdateDate: optional(read(row, "LAST UPDATE DATE")),
    expiryDate: optional(read(row, "EXPIRY DATE")),
  }))
  .sort((left, right) => left.mic.localeCompare(right.mic));

for (const record of records) {
  if (!/^[A-Z0-9]{4}$/.test(record.mic) || !/^[A-Z0-9]{4}$/.test(record.operatingMic)) {
    throw new Error(`Invalid MIC identity in ISO 10383 row: ${record.mic}`);
  }
  if (!["OPRT", "SGMT"].includes(record.kind)) {
    throw new Error(`Invalid MIC type for ${record.mic}: ${record.kind}`);
  }
  if (!["ACTIVE", "UPDATED", "EXPIRED"].includes(record.status)) {
    throw new Error(`Invalid MIC status for ${record.mic}: ${record.status}`);
  }
}

const duplicateMics = records
  .filter((record, index) => index > 0 && record.mic === records[index - 1].mic)
  .map((record) => record.mic);
if (duplicateMics.length > 0) {
  throw new Error(`ISO 10383 contains duplicate MICs: ${duplicateMics.join(", ")}`);
}

const output = {
  sourceUrl: SOURCE_URL,
  sourceSha256,
  publicationDate: options.publicationDate,
  implementationDate: options.implementationDate,
  records,
};
await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Wrote ${records.length} ISO 10383 records to ${options.output}`);
