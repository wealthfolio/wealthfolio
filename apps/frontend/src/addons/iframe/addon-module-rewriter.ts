import { parse } from "es-module-lexer/js";

export type ModuleSpecifierResolver = (importerPath: string, specifier: string) => string;
export type StaticSpecifierEligibility = (specifier: string) => boolean;

interface SourceEdit {
  end: number;
  replacement: string;
  start: number;
}

// es-module-lexer declares ImportType in its types but does not export it from
// the CSP-safe `/js` runtime build. Keep these values aligned with its public
// ImportType enum and handle only syntax whose semantics this loader supports.
const IMPORT_TYPE = {
  STATIC: 1,
  DYNAMIC: 2,
  STATIC_SOURCE_PHASE: 4,
  DYNAMIC_SOURCE_PHASE: 5,
  STATIC_DEFER_PHASE: 6,
  DYNAMIC_DEFER_PHASE: 7,
} as const;
const STATIC_IMPORT_TYPES = new Set<number>([
  IMPORT_TYPE.STATIC,
  IMPORT_TYPE.STATIC_SOURCE_PHASE,
  IMPORT_TYPE.STATIC_DEFER_PHASE,
]);

function formatParseError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const index = "idx" in error && typeof error.idx === "number" ? ` at offset ${error.idx}` : "";
  return `${error.message}${index}`;
}

function escapeSpecifier(specifier: string, quote: string) {
  const escaped = specifier
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return quote === '"' ? escaped.replace(/"/g, '\\"') : escaped.replace(/'/g, "\\'");
}

function applySourceEdits(code: string, edits: SourceEdit[]) {
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (rewritten, edit) =>
        `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`,
      code,
    );
}

export function rewriteModuleSpecifiers(
  importerPath: string,
  code: string,
  resolveSpecifier: ModuleSpecifierResolver,
  shouldRewriteStaticSpecifier: StaticSpecifierEligibility,
) {
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(code, importerPath);
  } catch (error) {
    throw new Error(`Failed to parse addon module '${importerPath}': ${formatParseError(error)}`, {
      cause: error,
    });
  }

  const edits: SourceEdit[] = [];
  for (const moduleImport of imports) {
    const importType = Number(moduleImport.t);
    if (STATIC_IMPORT_TYPES.has(importType) && moduleImport.n !== undefined) {
      if (!shouldRewriteStaticSpecifier(moduleImport.n)) {
        continue;
      }

      const resolvedSpecifier = resolveSpecifier(importerPath, moduleImport.n);
      if (resolvedSpecifier === moduleImport.n) {
        continue;
      }

      edits.push({
        start: moduleImport.s,
        end: moduleImport.e,
        replacement: escapeSpecifier(resolvedSpecifier, code[moduleImport.s - 1] ?? '"'),
      });
      continue;
    }

    if (importType === IMPORT_TYPE.DYNAMIC) {
      edits.push({
        start: moduleImport.ss,
        end: moduleImport.d + 1,
        replacement: `globalThis.__wealthfolioImport(${JSON.stringify(importerPath)}, `,
      });
      continue;
    }

    if (
      importType === IMPORT_TYPE.DYNAMIC_SOURCE_PHASE ||
      importType === IMPORT_TYPE.DYNAMIC_DEFER_PHASE
    ) {
      const syntax =
        importType === IMPORT_TYPE.DYNAMIC_SOURCE_PHASE ? "import.source()" : "import.defer()";
      throw new Error(
        `Unsupported ${syntax} in addon module '${importerPath}' at offset ${moduleImport.ss}`,
      );
    }
  }

  return applySourceEdits(code, edits);
}
