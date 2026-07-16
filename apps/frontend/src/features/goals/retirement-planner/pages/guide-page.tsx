import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm leading-relaxed">{children}</CardContent>
    </Card>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="bg-primary text-primary-foreground mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold">
        {n}
      </span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{children}</p>
      </div>
    </div>
  );
}

function Term({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium">{t}</p>
      <p className="text-muted-foreground text-xs">{children}</p>
    </div>
  );
}

export default function GuidePage({ country }: { country?: string }) {
  const { t } = useTranslation();
  const isIT = country === "IT";

  return (
    <div className="space-y-6 pb-8">
      <Section title={t("goals:guide.quick_start.title")}>
        <div className="space-y-4">
          <Step n={1} title={t("goals:guide.quick_start.step1_title")}>
            {t("goals:guide.quick_start.step1_desc")}
          </Step>
          <Step n={2} title={t("goals:guide.quick_start.step2_title")}>
            {t("goals:guide.quick_start.step2_desc")}
          </Step>
          <Step n={3} title={t("goals:guide.quick_start.step3_title")}>
            {t("goals:guide.quick_start.step3_desc")}
          </Step>
          <Step n={4} title={t("goals:guide.quick_start.step4_title")}>
            {t("goals:guide.quick_start.step4_desc")}
          </Step>
          <Step n={5} title={t("goals:guide.quick_start.step5_title")}>
            {t("goals:guide.quick_start.step5_desc")}
          </Step>
        </div>
      </Section>

      <Section title={t("goals:guide.overview.title")}>
        <div className="space-y-4">
          <Term t={t("goals:guide.overview.base_plan_title")}>
            {t("goals:guide.overview.base_plan_desc")}
          </Term>
          <Term t={t("goals:guide.overview.required_capital_title")}>
            {t("goals:guide.overview.required_capital_desc")}
          </Term>
          <Term t={t("goals:guide.overview.trajectory_title")}>
            {t("goals:guide.overview.trajectory_desc")}
          </Term>
          <Term t={t("goals:guide.overview.coverage_title")}>
            {t("goals:guide.overview.coverage_desc")}
          </Term>
          <Term t={t("goals:guide.overview.input_cards_title")}>
            {t("goals:guide.overview.input_cards_desc")}
          </Term>
          <Term t={t("goals:guide.overview.snapshot_title")}>
            {t("goals:guide.overview.snapshot_desc")}
          </Term>
        </div>
      </Section>

      <Section title={t("goals:guide.what_if.title")}>
        <div className="space-y-4">
          <Term t={t("goals:guide.what_if.market_paths_title")}>
            {t("goals:guide.what_if.market_paths_desc")}
          </Term>
          <Term t={t("goals:guide.what_if.base_case_title")}>
            {t("goals:guide.what_if.base_case_desc")}
          </Term>
          <Term t={t("goals:guide.what_if.stress_tests_title")}>
            {t("goals:guide.what_if.stress_tests_desc")}
          </Term>
          <Term t={t("goals:guide.what_if.what_moves_title")}>
            {t("goals:guide.what_if.what_moves_desc")}
          </Term>
          <Term t={t("goals:guide.what_if.crash_paths_title")}>
            {t("goals:guide.what_if.crash_paths_desc")}
          </Term>
        </div>
      </Section>

      <Section title={t("goals:guide.concepts.title")}>
        <div className="space-y-4">
          <Term t={t("goals:guide.concepts.yearly_spending_title")}>
            {t("goals:guide.concepts.yearly_spending_desc")}
          </Term>
          <Term t={t("goals:guide.concepts.target_calc_title")}>
            {t("goals:guide.concepts.target_calc_desc")}
          </Term>
          <Term t={t("goals:guide.concepts.inflation_title")}>
            {t("goals:guide.concepts.inflation_desc")}
            {isIT && ` ${t("goals:guide.concepts.inflation_it_note")}`}
          </Term>
          <Term t={t("goals:guide.concepts.returns_title")}>
            {t("goals:guide.concepts.returns_desc")}
          </Term>
          <Term t={t("goals:guide.concepts.horizon_title")}>
            {t("goals:guide.concepts.horizon_desc")}
          </Term>
        </div>
      </Section>

      {isIT && (
        <Section title={t("goals:guide.italian.title")}>
          <div className="space-y-4">
            <Term t={t("goals:guide.italian.portfolio_title")}>
              {t("goals:guide.italian.portfolio_desc")}
            </Term>
            <Term t={t("goals:guide.italian.fondo_title")}>
              {t("goals:guide.italian.fondo_desc")}
            </Term>
            <Term t={t("goals:guide.italian.inps_title")}>
              {t("goals:guide.italian.inps_desc")}
            </Term>
            <Term t={t("goals:guide.italian.tfr_title")}>{t("goals:guide.italian.tfr_desc")}</Term>
          </div>
        </Section>
      )}
    </div>
  );
}
