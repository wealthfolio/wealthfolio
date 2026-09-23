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
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@wealthfolio/ui/components/ui/input-otp";
import { motion, useAnimate } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { userFacingSyncErrorMessage } from "../../utils/error-messages";
import { DeviceLink } from "../device-link";
import { FlowScreen } from "../flow-layout";

const CODE_LENGTH = 6;
const CODE_PATTERN = "^[a-zA-Z0-9]+$";
const SLOT_CLASS = "h-14 w-11 font-mono text-2xl font-semibold uppercase transition-colors sm:w-12";

interface EnterCodeProps {
  title: string;
  description: string;
  onSubmit: (code: string) => void;
  onCancel: () => void;
  isLoading?: boolean;
  /** Why the last submitted code was not accepted. */
  error?: string | null;
}

export function EnterCode({
  title,
  description,
  onSubmit,
  onCancel,
  isLoading,
  error,
}: EnterCodeProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [code, setCode] = useState("");
  // The error belongs to this code; editing it clears the message.
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);
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
      .slice(0, CODE_LENGTH);
  };

  const submit = (value: string) => {
    setSubmittedCode(value);
    onSubmit(value);
  };

  const handleChange = (value: string) => {
    const normalized = normalizeCode(value);
    setCode(normalized);
    // A complete new code needs nothing else from the user.
    if (normalized.length === CODE_LENGTH && normalized !== submittedCode) submit(normalized);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length === CODE_LENGTH) {
      submit(code);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const normalized = normalizeCode(text);
      if (normalized.length > 0) {
        setCode(normalized);
      }
      // A complete code needs nothing else from the user.
      if (normalized.length === CODE_LENGTH) submit(normalized);
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
      if (normalized.length === CODE_LENGTH) {
        setTimeout(() => {
          if (!mountedRef.current) return;
          setCode(normalized);
          submit(normalized);
        }, 100);
      }
    }
  };

  const isDisabled = isLoading || isScanning;
  const visibleError = error && !isLoading && code === submittedCode ? error : null;

  // A rejected code gives a short shake. The field stays mounted, so it keeps focus.
  const [shakeScope, animateShake] = useAnimate<HTMLDivElement>();
  useEffect(() => {
    if (visibleError && shakeScope.current) {
      void animateShake(shakeScope.current, { x: [0, -8, 8, -5, 5, 0] }, { duration: 0.4 });
    }
  }, [visibleError, submittedCode, animateShake, shakeScope]);

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
      <FlowScreen
        title={title}
        description={description}
        visual={<DeviceLink source="other" />}
        actions={
          <>
            <Button
              type="submit"
              className="w-full gap-2"
              disabled={code.length !== CODE_LENGTH || isDisabled}
            >
              {isLoading && <Icons.Spinner className="size-4 animate-spin" aria-hidden />}
              {isLoading ? t("sync:enterCode.connecting") : t("sync:enterCode.connect")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={onCancel}
              disabled={isDisabled}
            >
              {t("common:cancel")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
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
                <p className="text-muted-foreground text-sm">{t("sync:enterCode.scanHint")}</p>
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
          <div className="flex flex-col items-center gap-3">
            <div ref={shakeScope}>
              <InputOTP
                maxLength={CODE_LENGTH}
                value={code}
                onChange={handleChange}
                pattern={CODE_PATTERN}
                pasteTransformer={normalizeCode}
                inputMode="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={!canScan}
                // Read-only while the code is checked: a disabled field loses
                // focus, and a rejected code should be fixable by typing.
                disabled={isScanning}
                readOnly={isLoading}
                aria-label={t("sync:enterCode.codeLabel")}
                aria-invalid={!!visibleError}
                aria-describedby={visibleError ? errorId : undefined}
                containerClassName={cn("gap-3 transition-opacity", isLoading && "opacity-60")}
              >
                {[0, 3].map((start) => (
                  <InputOTPGroup key={start}>
                    {[start, start + 1, start + 2].map((index) => (
                      <InputOTPSlot
                        key={index}
                        index={index}
                        className={cn(SLOT_CLASS, visibleError && "border-destructive")}
                      />
                    ))}
                  </InputOTPGroup>
                ))}
              </InputOTP>
            </div>
            <div className="flex min-h-5 items-center justify-center">
              {visibleError ? (
                <motion.p
                  id={errorId}
                  role="alert"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-destructive text-center text-sm"
                >
                  {userFacingSyncErrorMessage(visibleError)}
                </motion.p>
              ) : (
                <button
                  type="button"
                  onClick={handlePaste}
                  disabled={isDisabled}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors disabled:opacity-50"
                >
                  <Icons.Copy className="size-3.5" aria-hidden />
                  {t("sync:enterCode.paste")}
                </button>
              )}
            </div>
          </div>
        </div>
      </FlowScreen>
    </form>
  );
}
