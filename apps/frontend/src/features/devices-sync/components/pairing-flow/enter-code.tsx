// EnterCode
// Input form for the claimer to enter the pairing code
// =====================================================

import { logger } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { Icons } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
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
  const { isMobile } = usePlatform();
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
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
    if (!canScan) return;

    setIsScanning(true);
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

      const result = await scanner.scan({
        windowed: false,
        formats: [scanner.Format.QRCode],
      });

      logger.info("[Scan] Scan returned: " + JSON.stringify(result));
      scannedContent = result?.content || null;
    } catch (err) {
      const errorStr = String(err);
      logger.error("[Scan] Error: " + errorStr);

      if (!errorStr.includes("cancel")) {
        try {
          const { cancel } = await import("@tauri-apps/plugin-barcode-scanner");
          await cancel().catch(() => {});
        } catch {
          // Ignore
        }
      }
    }

    // Guard against unmount during permission dialog / camera view
    if (!mountedRef.current) return;

    setIsScanning(false);

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
      {/* Scan QR Card - mobile only */}
      {canScan && (
        <button
          type="button"
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
