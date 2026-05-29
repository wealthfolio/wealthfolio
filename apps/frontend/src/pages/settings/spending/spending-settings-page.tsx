import { Link, useNavigate } from "react-router-dom";

import { Button, Icons } from "@wealthfolio/ui";

import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";

import { AccountsCard } from "./components/accounts-card";
import { BudgetOverviewCard } from "./components/budget-overview-card";
import { CategoriesOverviewCard } from "./components/categories-overview-card";
import { EventTypesOverviewCard } from "./components/event-types-overview-card";
import { ModuleCard } from "./components/module-card";
import { RulesOverviewCard } from "./components/rules-overview-card";

export default function SpendingSettingsPage() {
  const { isEnabled } = useSpendingSettings();
  const navigate = useNavigate();

  return (
    <div className="font-mono text-sm leading-relaxed antialiased [&>*+*]:mt-9 [&>section+section]:mt-11">
      <header className="flex items-center gap-1.5 lg:block">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/settings")}
          className="text-muted-foreground hover:text-foreground -ml-1 h-8 w-8 shrink-0 p-0 lg:hidden"
          aria-label="Back to Settings"
        >
          <Icons.ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <nav
            aria-label="Breadcrumb"
            className="text-muted-foreground mb-3 hidden items-center gap-1.5 text-xs lg:flex"
          >
            <span>Settings</span>
            <span className="text-muted-foreground/50">/</span>
            <span>Portfolio</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="text-foreground">Spending Tracker</span>
          </nav>
          <h1 className="text-foreground text-base font-semibold tracking-tight sm:text-lg lg:text-2xl">
            Spending Tracker
          </h1>
          <p className="text-muted-foreground mt-1 hidden max-w-[64ch] text-sm sm:block">
            Track expenses on your cash accounts — categories, events, automation rules, and
            budgets.
          </p>
        </div>
      </header>

      <ModuleCard />

      {isEnabled && (
        <>
          <Section title="Sources" meta="Which accounts feed the tracker">
            <AccountsCard />
            {/* CSV import is a common first-run task — surface it next to the
                sources selector so a user landing in Settings to set up the
                tracker can seed historical activities without hunting for the
                separate /import route. Matches the dashboard tab's Import
                action (portfolio-page.tsx). */}
            <div className="border-border/60 bg-card/40 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <Icons.Upload className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
                <span className="text-foreground/90">
                  Have a credit-card or bank CSV? Import historical activities to seed the tracker.
                </span>
              </div>
              <Button asChild variant="outline" size="sm" className="h-7 shrink-0 text-xs">
                <Link to="/import">Import CSV</Link>
              </Button>
            </div>
          </Section>

          <Section title="Budgets" meta="Default monthly plan and rollover behavior">
            <BudgetOverviewCard />
          </Section>

          <Section title="Taxonomy" meta="How transactions are classified">
            <div className="grid gap-3 md:grid-cols-2">
              <CategoriesOverviewCard variant="expense" />
              <CategoriesOverviewCard variant="income" />
            </div>
            <EventTypesOverviewCard />
          </Section>

          <Section title="Automation" meta="Auto-tag activities by transaction-name patterns">
            <RulesOverviewCard />
          </Section>
        </>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  meta?: string;
  children: React.ReactNode;
}

function Section({ title, meta, children }: SectionProps) {
  return (
    <section>
      <div className="mb-[14px] flex items-baseline justify-between gap-3">
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-widest">
          {title}
        </h2>
        {meta && <span className="text-muted-foreground/80 hidden text-xs sm:inline">{meta}</span>}
      </div>
      <div className="space-y-3.5">{children}</div>
    </section>
  );
}
