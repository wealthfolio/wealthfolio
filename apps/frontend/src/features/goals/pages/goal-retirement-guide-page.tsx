import { Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import GuidePage from "@/features/goals/retirement-planner/pages/guide-page";
import { timezoneToCountry } from "@/features/goals/retirement-planner/lib/timezone";
import { useSettingsContext } from "@/lib/settings-provider";

export default function GoalRetirementGuidePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { goalId } = useParams<{ goalId: string }>();
  const { settings } = useSettingsContext();

  return (
    <Page>
      <PageHeader
        heading={t("goals:guide.title")}
        text={t("goals:guide.subtitle")}
        onBack={() => navigate(goalId ? `/goals/${goalId}` : "/goals")}
      />
      <PageContent>
        <div className="mx-auto max-w-4xl">
          <GuidePage country={timezoneToCountry(settings?.timezone)} />
        </div>
      </PageContent>
    </Page>
  );
}
