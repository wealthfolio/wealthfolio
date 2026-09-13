// EnterCode
// Input form for the claimer to enter the pairing code
// =====================================================

import { logger } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { Icons } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface EnterCodeProps {
  onSubmit: (code: string) => void;
  onCancel: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export function EnterCode({ onSubmit, onCancel, isLoading, error }: EnterCodeProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const { isMobile } = usePlatform();
  const mountedRef = useRef(true);
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const stopScanRef = useRef<(() => void) | null>(null);
  const closingScanRef = useRef(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const closeScanner = async () => {
    if (closingScanRef.current || !stopScanRef.current) return;
    closingScanRef.current = true;
    try {
      const { cancel } = await import("@tauri-apps/plugin-barcode-scanner");
      await cancel();
      // Android may leave scan() pending after cancel(). Settle our own wait.
      stopScanRef.current?.();
    } catch {
      if (mountedRef.current) setScanError(t("sync:enterCode.cameraCloseError"));
    } finally {
      closingScanRef.current = false;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (stopScanRef.current) {
        stopScanRef.current();
        void import("@tauri-apps/plugin-barcode-scanner")
          .then(({ cancel }) => cancel())
          .catch(() => {});
      }
      document.body.classList.remove("qr-scan-active");
    };
  }, []);

  // Scan only available on mobile (native iOS/Android)
  const canScan = isMobile;

  // Normalize code: uppercase, alphanumeric only, max 6 chars
  const normalizeCode = (value: string): string => {
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(normalizeCode(e.target.value));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length === 6) {
      onSubmit(code);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const normalized = normalizeCode(text);
      if (normalized.length > 0) {
        setCode(normalized);
      }
    } catch {
      // Clipboard access denied
    }
  };

  const handleScanQR = async () => {
    if (!canScan || isScanning) return;

    setIsScanning(true);
    setScanError(null);
    logger.info("[Scan] Starting scanner...");

    let scannedContent: string | null = null;

    try {
      const scanner = await import("@tauri-apps/plugin-barcode-scanner");

      const currentPermission =
        typeof scanner.checkPermissions === "function"
          ? await scanner.checkPermissions()
          : "denied";

      if (currentPermission !== "granted") {
        logger.info("[Scan] Camera permission not granted, requesting...");
        const requestedPermission =
          typeof scanner.requestPermissions === "function"
            ? await scanner.requestPermissions()
            : "denied";

        if (requestedPermission !== "granted") {
          logger.info("[Scan] Camera permission denied by user");
          return;
        }

        // iOS may need a short delay after first-time permission grant
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!mountedRef.current) return;
      const cancelled = new Promise<null>((resolve) => {
        stopScanRef.current = () => resolve(null);
      });
      document.body.classList.add("qr-scan-active");
      setIsCameraActive(true);
      const result = await Promise.race([
        scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] }),
        cancelled,
      ]);

      logger.info("[Scan] Scanner finished");
      scannedContent = result?.content || null;
    } catch (err) {
      const errorStr =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String(err.message)
            : String(err);
      logger.error("[Scan] Error: " + errorStr);

      if (!errorStr.includes("cancel")) {
        if (mountedRef.current) {
          setScanError(
            errorStr.toLowerCase().includes("no camera")
              ? t("sync:enterCode.cameraUnavailable")
              : t("sync:enterCode.cameraOpenError"),
          );
        }
        try {
          const { cancel } = await import("@tauri-apps/plugin-barcode-scanner");
          await cancel().catch(() => {});
        } catch {
          // Ignore
        }
      }
    } finally {
      stopScanRef.current = null;
      document.body.classList.remove("qr-scan-active");
      if (mountedRef.current) {
        setIsCameraActive(false);
        setIsScanning(false);
      }
    }

    // Guard against unmount during permission dialog / camera view
    if (!mountedRef.current) return;

    if (scannedContent) {
      const normalized = normalizeCode(scannedContent);
      if (normalized.length === 6) {
        setTimeout(() => {
          if (!mountedRef.current) return;
          setCode(normalized);
          onSubmit(normalized);
        }, 100);
      }
    }
  };

  // Format display: "ABC 123"
  const displayCode = code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  const isDisabled = isLoading || isScanning;

  return (
    <div className="flex flex-col gap-5 pb-2 pt-4">
      {/* Always use a fullscreen dialog, including above the mobile pairing sheet. */}
      <Dialog
        open={isCameraActive}
        onOpenChange={(open) => {
          if (!open) void closeScanner();
        }}
        useIsMobile={() => false}
      >
        <DialogContent
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            scanButtonRef.current?.focus();
          }}
          className="qr-overlay fixed inset-0 left-0 top-0 z-[10000] flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col items-center justify-end overflow-hidden rounded-none border-0 bg-transparent px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))] text-white shadow-none duration-0 data-[state=closed]:animate-none data-[state=open]:animate-none"
        >
          <div className="qr-scan-frame absolute left-1/2 top-1/2 aspect-square w-[min(68vw,34dvh,280px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-white/25">
            <div className="absolute bottom-full left-1/2 mb-6 w-[min(85vw,340px)] -translate-x-1/2 text-center">
              <div className="mb-2 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/20 bg-white/10">
                <Icons.QrCode className="h-5 w-5" aria-hidden="true" />
              </div>
              <DialogTitle className="text-xl font-semibold tracking-tight">
                {t("sync:enterCode.scanQrCode")}
              </DialogTitle>
              <DialogDescription className="mt-2 text-sm leading-relaxed text-white/75">
                {t("sync:enterCode.scanInstructions")}
              </DialogDescription>
            </div>
            <div aria-hidden="true">
              <span className="absolute -left-px -top-px h-10 w-10 rounded-tl-3xl border-l-[3px] border-t-[3px] border-white" />
              <span className="absolute -right-px -top-px h-10 w-10 rounded-tr-3xl border-r-[3px] border-t-[3px] border-white" />
              <span className="absolute -bottom-px -left-px h-10 w-10 rounded-bl-3xl border-b-[3px] border-l-[3px] border-white" />
              <span className="absolute -bottom-px -right-px h-10 w-10 rounded-br-3xl border-b-[3px] border-r-[3px] border-white" />
            </div>
          </div>
          {scanError && (
            <p role="alert" className="relative z-10 rounded bg-black/80 p-3 text-white">
              {scanError}
            </p>
          )}
          <Button
            type="button"
            className="relative z-10 mt-6 h-14 w-full max-w-sm shrink-0 rounded-2xl border border-white/25 bg-white/10 text-base font-medium text-white shadow-none hover:bg-white/20 active:bg-white/25"
            onClick={() => void closeScanner()}
          >
            {t("common:cancel")}
          </Button>
        </DialogContent>
      </Dialog>
      {!isScanning && scanError && (
        <p role="alert" className="text-destructive text-center text-sm">
          {scanError}
        </p>
      )}
      {/* Scan QR Card - mobile only */}
      {canScan && (
        <button
          type="button"
          ref={scanButtonRef}
          onClick={handleScanQR}
          disabled={isDisabled}
          className="bg-muted/50 hover:bg-muted active:bg-muted/80 flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-colors disabled:opacity-50"
        >
          <div className="bg-primary/10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
            {isScanning ? (
              <Icons.Spinner className="text-primary h-6 w-6 animate-spin" />
            ) : (
              <Icons.QrCode className="text-primary h-6 w-6" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {isScanning ? t("sync:enterCode.openingCamera") : t("sync:enterCode.scanQrCode")}
            </p>
            <p className="text-muted-foreground text-sm">{t("sync:enterCode.quickAndEasy")}</p>
          </div>
          <Icons.ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
        </button>
      )}

      {/* Divider */}
      {canScan && (
        <div className="flex items-center gap-4">
          <div className="bg-border h-px flex-1" />
          <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
            {t("sync:enterCode.or")}
          </span>
          <div className="bg-border h-px flex-1" />
        </div>
      )}

      {/* Manual code entry */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Code input with inline paste */}
        <div className="relative">
          <Input
            value={displayCode}
            onChange={handleChange}
            placeholder={t("sync:enterCode.codePlaceholder")}
            className="h-16 pr-20 text-center font-mono text-2xl tracking-[0.2em]"
            autoFocus={!canScan}
            disabled={isDisabled}
          />
          <button
            type="button"
            onClick={handlePaste}
            disabled={isDisabled}
            className="text-primary hover:text-primary/80 absolute right-3 top-1/2 -translate-y-1/2 px-2 py-1 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {t("sync:enterCode.paste")}
          </button>
        </div>

        {error && <p className="text-destructive text-center text-sm">{error}</p>}

        {/* Connect button */}
        <Button
          type="submit"
          className="h-12 w-full text-base"
          disabled={code.length !== 6 || isDisabled}
        >
          {isLoading ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              {t("sync:enterCode.connecting")}
            </>
          ) : (
            t("sync:enterCode.connect")
          )}
        </Button>

        {/* Cancel */}
        <button
          type="button"
          onClick={onCancel}
          disabled={isDisabled}
          className="text-muted-foreground hover:text-foreground py-2 text-sm transition-colors disabled:opacity-50"
        >
          {t("common:cancel")}
        </button>
      </form>
    </div>
  );
}
