import { Button } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useBackNavigation } from "@/pages/layouts/mobile-stack/use-mobile-stack";

export default function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const goBack = useBackNavigation();

  return (
    <div className="animate-in fade-in zoom-in flex h-full w-full flex-col items-center justify-center gap-6 p-8 text-center duration-500">
      <div className="space-y-2">
        <h1 className="text-muted-foreground/10 text-[8rem] leading-none font-black tracking-tighter select-none">
          404
        </h1>
        <h2 className="text-3xl font-bold tracking-tight">{t("common:notFound.title")}</h2>
        <p className="text-muted-foreground mx-auto max-w-112.5 text-lg">
          {t("common:notFound.description")}
        </p>
      </div>
      <div className="flex gap-4">
        <Button onClick={goBack} variant="outline" size="lg">
          {t("common:notFound.goBack")}
        </Button>
        <Button onClick={() => navigate("/")} variant="default" size="lg">
          {t("common:notFound.backToDashboard")}
        </Button>
      </div>
    </div>
  );
}
