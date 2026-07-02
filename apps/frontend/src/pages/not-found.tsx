import { Button } from "@wealthfolio/ui";
import { useI18n } from "@/i18n/i18n-provider";
import { useNavigate } from "react-router-dom";

export default function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <div className="animate-in fade-in zoom-in flex h-full w-full flex-col items-center justify-center gap-6 p-8 text-center duration-500">
      <div className="space-y-2">
        <h1 className="text-muted-foreground/10 select-none text-9xl font-black tracking-tighter">
          404
        </h1>
        <h2 className="text-3xl font-bold tracking-tight">{t("notFound.title")}</h2>
        <p className="text-muted-foreground mx-auto max-w-[450px] text-lg">
          {t("notFound.description")}
        </p>
      </div>
      <div className="flex gap-4">
        <Button onClick={() => navigate(-1)} variant="outline" size="lg">
          {t("notFound.goBack")}
        </Button>
        <Button onClick={() => navigate("/")} variant="default" size="lg">
          {t("notFound.backToDashboard")}
        </Button>
      </div>
    </div>
  );
}
