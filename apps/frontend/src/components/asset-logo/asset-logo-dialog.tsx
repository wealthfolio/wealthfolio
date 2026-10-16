import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDateFormatting,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { TickerAvatar } from "@/components/ticker-avatar";
import { useAssetLogoMutations } from "@/hooks/use-asset-logos";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useAssetLogoOverride } from "@/lib/asset-logo-registry";
import {
  LogoImageError,
  normalizeLogoImage,
  type LogoImageErrorCode,
  type NormalizedLogoImage,
} from "@/lib/normalize-logo-image";
import { cn, formatDate } from "@/lib/utils";
import { AssetLogoDropzone } from "./asset-logo-dropzone";
import { AssetLogoPreview } from "./asset-logo-preview";

export interface AssetLogoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  symbol: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  name?: string | null;
}

type DialogState =
  | { status: "idle" }
  | { status: "processing" }
  | { status: "ready"; candidate: NormalizedLogoImage; originalBytes: number }
  | { status: "error"; code: LogoImageErrorCode };

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function AssetLogoDialog({ open, onOpenChange, ...bodyProps }: AssetLogoDialogProps) {
  const isMobile = useIsMobileViewport();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} useIsMobile={useIsMobileViewport}>
      <DialogContent
        className="sm:max-w-lg"
        mobileClassName="flex h-[90vh] flex-col gap-0 overflow-hidden p-0"
        data-testid="asset-logo-dialog"
      >
        <AssetLogoDialogBody
          {...bodyProps}
          isMobile={isMobile}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface AssetLogoDialogBodyProps {
  assetId: string;
  symbol: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  name?: string | null;
  isMobile: boolean;
  onClose: () => void;
}

/** Mounted only while the dialog is open, so its state starts fresh on every open. */
function AssetLogoDialogBody({
  assetId,
  symbol,
  exchangeMic,
  instrumentType,
  name,
  isMobile,
  onClose,
}: AssetLogoDialogBodyProps) {
  const { t } = useTranslation("asset");
  const dateFormatting = useDateFormatting();
  const { setLogo, resetLogo } = useAssetLogoMutations();
  const override = useAssetLogoOverride({ assetId });
  const hasCustom = !!override.ref;

  const [state, setState] = useState<DialogState>({ status: "idle" });

  const isBusy = setLogo.isPending || resetLogo.isPending;
  const isReady = state.status === "ready";

  const handleFile = (file: File) => {
    setState({ status: "processing" });
    normalizeLogoImage(file).then(
      (candidate) => setState({ status: "ready", candidate, originalBytes: file.size }),
      (error: unknown) =>
        setState({
          status: "error",
          code: error instanceof LogoImageError ? error.code : "decode_failed",
        }),
    );
  };

  const handleSave = () => {
    if (state.status !== "ready") return;
    setLogo.mutate(
      { assetId, dataBase64: state.candidate.dataBase64, displayCode: symbol },
      { onSuccess: onClose },
    );
  };

  const handleReset = () => {
    resetLogo.mutate(assetId, { onSuccess: onClose });
  };

  return (
    <>
      <DialogHeader className={cn(isMobile && "border-b px-6 py-4")}>
        <DialogTitle>{t("logo.title")}</DialogTitle>
        <DialogDescription>{name ? `${symbol} · ${name}` : symbol}</DialogDescription>
      </DialogHeader>

      <div
        className={cn("min-w-0 space-y-4", isMobile && "min-h-0 flex-1 overflow-y-auto px-4 py-4")}
      >
        {/* Current → target: the circle on the right is the drop zone and becomes the new logo. */}
        <div className="flex items-start justify-center gap-5">
          <div className="flex w-24 flex-col items-center gap-2">
            <TickerAvatar
              symbol={symbol}
              exchangeMic={exchangeMic}
              instrumentType={instrumentType}
              assetId={assetId}
              className={cn("size-20", isReady && "opacity-60")}
            />
            <Badge
              variant={hasCustom ? "default" : "secondary"}
              className="text-2xs h-5 px-1.5"
              title={
                override.ref
                  ? t("logo.updated_at", {
                      date: formatDate(override.ref.updatedAt, dateFormatting),
                    })
                  : undefined
              }
            >
              {hasCustom ? t("logo.badge_custom") : t("logo.badge_default")}
            </Badge>
          </div>

          <Icons.ArrowRight className="text-muted-foreground mt-8 size-4 shrink-0" />

          <div className="flex w-24 flex-col items-center gap-2">
            <AssetLogoDropzone
              onFile={handleFile}
              disabled={state.status === "processing" || isBusy}
            >
              {isReady && (
                <TickerAvatar
                  symbol={symbol}
                  exchangeMic={exchangeMic}
                  instrumentType={instrumentType}
                  src={state.candidate.dataUri}
                  className="size-20"
                />
              )}
            </AssetLogoDropzone>
            <span
              className={cn(
                "text-2xs flex h-5 items-center font-medium uppercase tracking-wide",
                isReady ? "text-primary" : "text-muted-foreground",
              )}
            >
              {t("logo.preview_new")}
            </span>
          </div>
        </div>

        {/* Help line for the target above. */}
        <div
          className="bg-muted/40 text-muted-foreground flex min-h-10 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-center text-xs"
          data-testid="asset-logo-help"
        >
          {state.status === "processing" ? (
            <>
              <Icons.Spinner className="size-3.5 animate-spin" />
              {t("logo.processing")}
            </>
          ) : isReady ? (
            <>
              <span>
                {t("logo.preview_meta", {
                  width: state.candidate.width,
                  height: state.candidate.height,
                  size: formatBytes(state.candidate.blob.size),
                  original: formatBytes(state.originalBytes),
                })}
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                disabled={isBusy}
                onClick={() => setState({ status: "idle" })}
              >
                {t("logo.choose_different")}
              </Button>
            </>
          ) : (
            <span>
              <span className="text-foreground font-medium">{t("logo.dropzone_cta")}</span>{" "}
              {t("logo.dropzone_or_drop")}
              <br />
              {t("logo.dropzone_hint")}
            </span>
          )}
        </div>

        {state.status === "error" && (
          <Alert variant="destructive" data-testid="asset-logo-error">
            <Icons.AlertCircle className="size-4" />
            <AlertDescription>{t(`logo.error_${state.code}`)}</AlertDescription>
          </Alert>
        )}

        <AssetLogoPreview
          assetId={assetId}
          symbol={symbol}
          exchangeMic={exchangeMic}
          instrumentType={instrumentType}
          name={name}
          src={isReady ? state.candidate.dataUri : undefined}
        />
      </div>

      <DialogFooter
        className={cn(
          isMobile ? "border-t px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]" : "gap-2",
        )}
      >
        {/* Mobile: full-width stack, primary on top (DialogFooter reverses column order). */}
        {hasCustom && (
          <Button
            type="button"
            variant="ghost"
            className={cn(isMobile ? "w-full" : "sm:mr-auto")}
            disabled={isBusy}
            aria-busy={resetLogo.isPending}
            onClick={handleReset}
            data-testid="asset-logo-reset"
          >
            {resetLogo.isPending ? (
              <Icons.Spinner className="size-4 animate-spin" />
            ) : (
              <Icons.RotateCcw className="size-4" />
            )}
            {t("logo.reset")}
          </Button>
        )}
        <div className={cn("flex gap-2", isMobile && "w-full flex-col-reverse")}>
          <Button
            type="button"
            variant="outline"
            className={cn(isMobile && "w-full")}
            disabled={isBusy}
            onClick={onClose}
          >
            {t("common:cancel")}
          </Button>
          <Button
            type="button"
            className={cn(isMobile && "w-full")}
            disabled={!isReady || isBusy}
            aria-busy={setLogo.isPending}
            onClick={handleSave}
            data-testid="asset-logo-save"
          >
            {setLogo.isPending && <Icons.Spinner className="size-4 animate-spin" />}
            {t("logo.save")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
