import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { getAccounts } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { Account } from "@/lib/types";
import { useImportContext, reset, setStep } from "../context";
import { ImportAlert } from "../components/import-alert";

// ─────────────────────────────────────────────────────────────────────────────
// Animation Variants
// ─────────────────────────────────────────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      when: "beforeChildren",
      staggerChildren: 0.15,
    },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  },
} as const;

const checkmarkVariants = {
  hidden: { scale: 0, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: {
      type: "spring",
      stiffness: 200,
      damping: 15,
      delay: 0.2,
    },
  },
} as const;

const checkIconVariants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      delay: 0.4,
      duration: 0.4,
      ease: "easeOut",
    },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface StatItemProps {
  label: string;
  value: number;
  variant?: "default" | "success" | "muted";
}

function StatItem({ label, value, variant = "default" }: StatItemProps) {
  const colorClasses = {
    default: "text-foreground",
    success: "text-green-600 dark:text-green-400",
    muted: "text-muted-foreground",
  };

  return (
    <div className="text-center">
      <div className={`text-3xl font-semibold tabular-nums ${colorClasses[variant]}`}>{value}</div>
      <div className="text-muted-foreground mt-1 text-sm">{label}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function ContextResultStep() {
  const { state, dispatch } = useImportContext();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { importResult, accountId } = state;

  const { data: accounts } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });

  const isHoldingsMode = accounts?.find((a) => a.id === accountId)?.trackingMode === "HOLDINGS";

  const handleViewResult = () => {
    if (isHoldingsMode) {
      navigate(accountId ? `/holdings?account=${accountId}` : "/holdings");
    } else {
      navigate(accountId ? `/activities?account=${accountId}` : "/activities");
    }
  };

  const handleImportAnother = () => {
    dispatch(reset());
  };

  // Handle case where there's no import result
  if (!importResult) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Icons.Spinner className="text-primary h-8 w-8 animate-spin" />
        <p className="text-muted-foreground mt-4">{t("activity:import.result.loading")}</p>
      </div>
    );
  }

  const { success, stats, errorMessage } = importResult;

  if (!success) {
    return (
      <motion.div
        className="space-y-6"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <ImportAlert
          variant="destructive"
          title={t("activity:import.result.failedTitle")}
          description={errorMessage ?? t("activity:import.result.failedDescription")}
        />

        <motion.div className="flex justify-center gap-3" variants={itemVariants}>
          <Button variant="outline" onClick={() => dispatch(setStep("confirm"))}>
            <Icons.ArrowLeft className="mr-2 h-4 w-4" />
            {t("activity:import.result.tryAgain")}
          </Button>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="flex flex-col items-center py-8"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Success icon with animated checkmark */}
      <motion.div className="relative mb-8" variants={checkmarkVariants}>
        {/* Outer glow ring */}
        <div className="absolute inset-0 rounded-full bg-green-500/20 blur-xl" />

        {/* Background circle */}
        <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-green-400 to-green-600 shadow-lg shadow-green-500/25">
          <motion.svg
            className="h-12 w-12 text-white"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <motion.path d="M5 13l4 4L19 7" variants={checkIconVariants} />
          </motion.svg>
        </div>
      </motion.div>

      {/* Title and description */}
      <motion.div className="mb-10 text-center" variants={itemVariants}>
        <h2 className="text-2xl font-semibold tracking-tight">
          {t("activity:import.result.completeTitle")}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-sm">
          {isHoldingsMode
            ? t("activity:import.result.holdingsSuccess")
            : t("activity:import.result.activitiesSuccess")}
        </p>
      </motion.div>

      {/* Stats row */}
      <motion.div className="mb-10 flex items-center justify-center gap-12" variants={itemVariants}>
        <StatItem
          label={t("activity:import.result.imported")}
          value={stats.imported}
          variant="success"
        />

        {stats.duplicates > 0 && (
          <>
            <div className="bg-border h-12 w-px" />
            <StatItem
              label={t("activity:import.result.duplicates")}
              value={stats.duplicates}
              variant="muted"
            />
          </>
        )}

        <div className="bg-border h-12 w-px" />

        <StatItem
          label={t("activity:import.result.skipped")}
          value={stats.skipped}
          variant="muted"
        />

        <div className="bg-border h-12 w-px" />

        <StatItem label={t("activity:import.result.total")} value={stats.total} />
      </motion.div>

      {/* Action buttons */}
      <motion.div className="flex gap-3" variants={itemVariants}>
        <Button variant="outline" size="lg" onClick={handleImportAnother}>
          <Icons.Import className="mr-2 h-4 w-4" />
          {t("activity:import.result.importAnother")}
        </Button>

        <Button size="lg" onClick={handleViewResult}>
          {isHoldingsMode
            ? t("activity:import.result.viewHoldings")
            : t("activity:import.result.viewActivities")}
          <Icons.ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </motion.div>
    </motion.div>
  );
}

export default ContextResultStep;
