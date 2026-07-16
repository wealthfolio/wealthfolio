import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  GetAssetTaxonomyAssignmentsArgs,
  GetAssetTaxonomyAssignmentsOutput,
  ListAssetTaxonomiesArgs,
  ListAssetTaxonomiesOutput,
} from "../../types";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanErrorMessage(raw: string): string {
  return raw
    .replace(/^Toolset error:\s*/i, "")
    .replace(/ToolCallError:\s*/g, "")
    .replace(/^Tool execution failed:\s*/i, "")
    .replace(/^JsonError:\s*/i, "")
    .trim();
}

function friendlyErrorMessage(raw: string, t: TFunction): string {
  const cleaned = cleanErrorMessage(raw);
  const lower = cleaned.toLowerCase();

  if (
    lower.includes("__placeholder__") ||
    lower.includes("asset-scoped taxonomy") ||
    lower.includes("taxonomy filter")
  ) {
    return t("ai:assetTaxonomy.matchTaxonomyError");
  }

  if (lower.includes("unknown") && lower.includes("category")) {
    return t("ai:assetTaxonomy.unknownError");
  }

  if (lower.includes("ambiguous")) {
    return t("ai:assetTaxonomy.ambiguousError");
  }

  if (lower.includes("not found among active assets")) {
    return t("ai:assetTaxonomy.notFoundError");
  }

  return t("ai:assetTaxonomy.genericError");
}

function extractToolErrorMessage(value: unknown, t: TFunction): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      return extractToolErrorMessage(JSON.parse(value), t);
    } catch {
      return friendlyErrorMessage(value, t);
    }
  }

  if (!isRecord(value)) {
    return typeof value === "number" || typeof value === "boolean"
      ? friendlyErrorMessage(String(value), t)
      : null;
  }

  if (typeof value.error === "string") return friendlyErrorMessage(value.error, t);
  if (typeof value.message === "string") return friendlyErrorMessage(value.message, t);
  if (typeof value.content === "string") return friendlyErrorMessage(value.content, t);

  if ("data" in value) {
    return extractToolErrorMessage(value.data, t);
  }

  return null;
}

function normalizeListAssetTaxonomiesResult(value: unknown): ListAssetTaxonomiesOutput | undefined {
  if (!value) return undefined;

  if (typeof value === "string") {
    try {
      return normalizeListAssetTaxonomiesResult(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  if (!isRecord(value)) return undefined;

  if ("data" in value) {
    const normalized = normalizeListAssetTaxonomiesResult(value.data);
    if (normalized) return normalized;
  }

  if (Array.isArray(value.taxonomies)) {
    return value as unknown as ListAssetTaxonomiesOutput;
  }

  return undefined;
}

function normalizeGetAssetTaxonomyAssignmentsResult(
  value: unknown,
): GetAssetTaxonomyAssignmentsOutput | undefined {
  if (!value) return undefined;

  if (typeof value === "string") {
    try {
      return normalizeGetAssetTaxonomyAssignmentsResult(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  if (!isRecord(value)) return undefined;

  if ("data" in value) {
    const normalized = normalizeGetAssetTaxonomyAssignmentsResult(value.data);
    if (normalized) return normalized;
  }

  if (Array.isArray(value.assignments)) {
    return value as unknown as GetAssetTaxonomyAssignmentsOutput;
  }

  return undefined;
}

function InlineToolError({ label }: { label: string }) {
  return (
    <div className="text-destructive flex items-center gap-2 px-1 text-xs">
      <Icons.AlertCircle className="h-3 w-3" />
      <span className="break-words">{label}</span>
    </div>
  );
}

function InlineLoading({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.Spinner className="h-3 w-3 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

function ListAssetTaxonomiesContentImpl({
  result,
  status,
}: ToolCallMessagePartProps<ListAssetTaxonomiesArgs, ListAssetTaxonomiesOutput>) {
  const { t } = useTranslation();
  if (status?.type === "running")
    return <InlineLoading label={t("ai:assetTaxonomy.loadingTaxonomies")} />;
  if (!result) return null;

  const parsedResult = normalizeListAssetTaxonomiesResult(result);
  if (!parsedResult) {
    return (
      <InlineToolError
        label={extractToolErrorMessage(result, t) ?? t("ai:assetTaxonomy.couldNotLoadTaxonomies")}
      />
    );
  }

  const returnedCategoryCount = parsedResult.taxonomies.reduce(
    (sum, taxonomy) => sum + (taxonomy.categories?.length ?? 0),
    0,
  );
  const totalCategoryCount = parsedResult.taxonomies.reduce(
    (sum, taxonomy) => sum + (taxonomy.categoryCount ?? taxonomy.categories?.length ?? 0),
    0,
  );
  const focusedTaxonomy = parsedResult.taxonomies.length === 1 ? parsedResult.taxonomies[0] : null;

  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.ListChecks className="h-3 w-3" />
      {returnedCategoryCount > 0 && focusedTaxonomy ? (
        <span>
          {totalCategoryCount > returnedCategoryCount
            ? t("ai:assetTaxonomy.loadedCategoriesTotal", {
                count: returnedCategoryCount,
                taxonomy: focusedTaxonomy.name,
                total: totalCategoryCount,
              })
            : t("ai:assetTaxonomy.loadedCategories", {
                count: returnedCategoryCount,
                taxonomy: focusedTaxonomy.name,
              })}
        </span>
      ) : (
        <span>
          {t("ai:assetTaxonomy.loadedTaxonomies", { count: parsedResult.taxonomies.length })}
        </span>
      )}
    </div>
  );
}

function GetAssetTaxonomyAssignmentsContentImpl({
  result,
  status,
}: ToolCallMessagePartProps<GetAssetTaxonomyAssignmentsArgs, GetAssetTaxonomyAssignmentsOutput>) {
  const { t } = useTranslation();
  if (status?.type === "running")
    return <InlineLoading label={t("ai:assetTaxonomy.loadingClassifications")} />;
  if (!result) return null;

  const parsedResult = normalizeGetAssetTaxonomyAssignmentsResult(result);
  if (!parsedResult) {
    return (
      <InlineToolError
        label={
          extractToolErrorMessage(result, t) ?? t("ai:assetTaxonomy.couldNotLoadClassifications")
        }
      />
    );
  }

  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.ListChecks className="h-3 w-3" />
      <span>
        {t("ai:assetTaxonomy.loadedClassifications", {
          count: parsedResult.assignments.length,
          asset: parsedResult.resolvedAsset?.label ?? parsedResult.assetQuery,
        })}
      </span>
    </div>
  );
}

const ListAssetTaxonomiesContent = memo(ListAssetTaxonomiesContentImpl);
const GetAssetTaxonomyAssignmentsContent = memo(GetAssetTaxonomyAssignmentsContentImpl);

export const ListAssetTaxonomiesToolUI = makeAssistantToolUI<
  ListAssetTaxonomiesArgs,
  ListAssetTaxonomiesOutput
>({
  toolName: "list_asset_taxonomies",
  render: (props) => <ListAssetTaxonomiesContent {...props} />,
});

export const GetAssetTaxonomyAssignmentsToolUI = makeAssistantToolUI<
  GetAssetTaxonomyAssignmentsArgs,
  GetAssetTaxonomyAssignmentsOutput
>({
  toolName: "get_asset_taxonomy_assignments",
  render: (props) => <GetAssetTaxonomyAssignmentsContent {...props} />,
});
