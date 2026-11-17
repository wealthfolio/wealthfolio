import { backendError } from "@/lib/backend-error";

export interface AssetPreviewError {
  kind: "timeout" | "network" | "too_large" | "provider" | "failed";
  httpStatus?: number;
}

/** Keep diagnostics useful without retaining upstream messages or financial data. */
export function assetPreviewError(cause: unknown): AssetPreviewError {
  const httpStatus =
    typeof cause === "object" &&
    cause !== null &&
    "httpStatus" in cause &&
    typeof cause.httpStatus === "number"
      ? cause.httpStatus
      : undefined;
  let kind: AssetPreviewError["kind"] = "failed";
  const name =
    typeof cause === "object" && cause !== null && "name" in cause ? cause.name : undefined;
  if (httpStatus === 408 || httpStatus === 504 || name === "TimeoutError") {
    kind = "timeout";
  } else if (httpStatus === 413) {
    kind = "too_large";
  } else if (backendError(cause)?.errorCode === "provider_unavailable") {
    kind = "provider";
  } else if (name === "NetworkError") {
    kind = "network";
  }
  return { kind, ...(httpStatus !== undefined && { httpStatus }) };
}
