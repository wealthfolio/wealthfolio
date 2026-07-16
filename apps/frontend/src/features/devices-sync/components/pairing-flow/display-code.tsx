// DisplayCode
// Shows the pairing code for the issuer device
// =============================================

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui";

interface DisplayCodeProps {
  code: string;
  expiresAt: Date;
  onCancel: () => void;
}

export function DisplayCode({ code, expiresAt, onCancel }: DisplayCodeProps) {
  const { t } = useTranslation();
  const [timeLeft, setTimeLeft] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      if (now >= expiresAt) {
        setTimeLeft(t("sync:displayCode.expired"));
      } else {
        const seconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        setTimeLeft(`${mins}:${secs.toString().padStart(2, "0")}`);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, t]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Format code with space: "ABC 123"
  const formattedCode = code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

  return (
    <div className="flex flex-col items-center gap-4">
      {/* QR Code */}
      <div className="shadow-xs rounded-2xl bg-white p-3 ring-1 ring-black/5">
        <QRCodeSVG value={code} size={128} level="M" marginSize={0} />
      </div>

      {/* Code + Copy - clickable row */}
      <button
        onClick={handleCopy}
        className="bg-muted hover:bg-muted/80 flex items-center gap-3 rounded-xl px-4 py-3 transition-colors"
      >
        <code className="font-mono text-base font-semibold tracking-[0.16em]">{formattedCode}</code>
        {copied ? (
          <Icons.Check className="h-4 w-4 text-green-500" />
        ) : (
          <Icons.Copy className="text-muted-foreground h-4 w-4" />
        )}
      </button>

      {/* Timer + Cancel */}
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground text-xs tabular-nums">{timeLeft}</span>
        <span className="text-muted-foreground/50">·</span>
        <Button
          variant="link"
          size="sm"
          className="text-muted-foreground h-auto p-0 text-xs"
          onClick={onCancel}
        >
          {t("common:cancel")}
        </Button>
      </div>
    </div>
  );
}
