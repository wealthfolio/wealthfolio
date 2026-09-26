import { reportBrokerActivityIssue } from "@/adapters";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ACTIVITY_TYPES, type ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import type {
  ActivityAssetClass,
  ActivityIssueKind,
  ActivityIssueReport,
} from "@/features/wealthfolio-connect/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  activityAssetClass,
  createActivityIssueReport,
  expectedTypeForIssue,
} from "./activity-issue-report";

const ACTIVITY_ISSUES: ActivityIssueKind[] = [
  "wrong_type",
  "duplicate_activity",
  "wrong_amount",
  "wrong_date",
  "other",
];
const ACCOUNT_ISSUES: ActivityIssueKind[] = ["missing_activity", "missing_history"];
const ASSET_CLASSES: ActivityAssetClass[] = [
  "bond",
  "stock",
  "fund",
  "crypto",
  "option",
  "cash",
  "other",
  "unknown",
];

interface ReportBrokerIssueProps {
  providerAccountId: string;
  accountName: string;
  activity?: ActivityDetails;
}

/** Mounts only when opened; no diagnostics are sent during normal sync or browsing. */
export function ReportBrokerIssue({
  providerAccountId,
  accountName,
  activity,
}: ReportBrokerIssueProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [issueKind, setIssueKind] = useState<ActivityIssueKind>(
    activity ? "wrong_type" : "missing_activity",
  );
  const [expectedType, setExpectedType] = useState<ActivityType | undefined>();
  const [assetClass, setAssetClass] = useState<ActivityAssetClass>(
    activity ? activityAssetClass(activity) : "unknown",
  );
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const rawSigns = activity?.metadata?.provider_signs;
  const signFields =
    rawSigns && typeof rawSigns === "object" && !Array.isArray(rawSigns)
      ? (rawSigns as Record<string, unknown>)
      : undefined;
  const description = activity?.metadata?.description;
  const descriptionText = typeof description === "string" ? description : undefined;
  const rawAmountSign = signFields?.amount;
  const rawUnitsSign = signFields?.units;

  useEffect(() => {
    setConsent(false);
  }, [
    providerAccountId,
    activity?.id,
    activity?.activityType,
    activity?.amount,
    activity?.quantity,
    activity?.comment,
    activity?.instrumentType,
    activity?.assetSymbol,
    activity?.metadata?.raw_type,
    descriptionText,
    rawAmountSign,
    rawUnitsSign,
  ]);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setConsent(false);
  };

  const applicableExpectedType = expectedTypeForIssue(issueKind, expectedType);
  const report: ActivityIssueReport = activity
    ? createActivityIssueReport(activity, providerAccountId, issueKind, applicableExpectedType)
    : {
        consent: true,
        provider: "snaptrade",
        accountId: providerAccountId,
        issueKind,
        ...(applicableExpectedType ? { expectedType: applicableExpectedType } : {}),
        features: {},
      };
  report.features.assetClass = assetClass;

  const canSubmit =
    consent &&
    !sending &&
    (issueKind !== "wrong_type" || (expectedType && expectedType !== activity?.activityType));

  const submit = async () => {
    if (!canSubmit) return;
    setSending(true);
    try {
      await reportBrokerActivityIssue(report);
      toast.success(t("activity:issue_report.success"));
      changeOpen(false);
    } catch (error) {
      const accountUnavailable = /\b404\b|NOT_FOUND|Brokerage account not found/i.test(
        String(error),
      );
      toast.error(
        t(
          accountUnavailable
            ? "activity:issue_report.account_unavailable"
            : "activity:issue_report.error",
        ),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => changeOpen(true)}>
        {t("activity:issue_report.open")}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("activity:issue_report.title")}</DialogTitle>
            <DialogDescription>{t("activity:issue_report.description")}</DialogDescription>
            <p className="text-sm font-medium">{accountName}</p>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="broker-issue-kind">
                {t("activity:issue_report.issue")}
              </label>
              <Select
                value={issueKind}
                onValueChange={(value) => {
                  setIssueKind(value as ActivityIssueKind);
                  setExpectedType(undefined);
                  setConsent(false);
                }}
              >
                <SelectTrigger id="broker-issue-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(activity ? ACTIVITY_ISSUES : ACCOUNT_ISSUES).map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`activity:issue_report.kinds.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(issueKind === "wrong_type" || issueKind === "missing_activity") && (
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="broker-expected-type">
                  {t("activity:issue_report.expected_type")}
                </label>
                <Select
                  value={expectedType}
                  onValueChange={(value) => {
                    setExpectedType(value as ActivityType);
                    setConsent(false);
                  }}
                >
                  <SelectTrigger id="broker-expected-type">
                    <SelectValue placeholder={t("activity:issue_report.select_type")} />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIVITY_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {localizeActivityTypeName(t, type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="broker-asset-class">
                {t("activity:issue_report.asset_class")}
              </label>
              <Select
                value={assetClass}
                onValueChange={(value) => {
                  setAssetClass(value as ActivityAssetClass);
                  setConsent(false);
                }}
              >
                <SelectTrigger id="broker-asset-class">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSET_CLASSES.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`activity:issue_report.asset_classes.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="bg-muted/40 space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">{t("activity:issue_report.preview_title")}</p>
              <p>{t("activity:issue_report.preview_account_id", { id: providerAccountId })}</p>
              <p>{t("activity:issue_report.preview_provider")}</p>
              <p>
                {t(`activity:issue_report.kinds.${issueKind}`)}
                {report.observedType
                  ? ` · ${localizeActivityTypeName(t, report.observedType)}`
                  : ""}
                {report.expectedType
                  ? ` → ${localizeActivityTypeName(t, report.expectedType)}`
                  : ""}
              </p>
              <p>
                {t("activity:issue_report.preview_features", {
                  amount: report.features.amountSign
                    ? t(`activity:issue_report.signs.${report.features.amountSign}`)
                    : "—",
                  units: report.features.unitsSign
                    ? t(`activity:issue_report.signs.${report.features.unitsSign}`)
                    : "—",
                  asset: t(`activity:issue_report.asset_classes.${assetClass}`),
                })}
              </p>
              {report.rawType && (
                <p>{t("activity:issue_report.preview_raw_type", { type: report.rawType })}</p>
              )}
              {report.features.hasSymbol !== undefined && (
                <p>
                  {t("activity:issue_report.preview_symbol", {
                    value: t(report.features.hasSymbol ? "common:yes" : "common:no"),
                  })}
                </p>
              )}
              {!!report.features.descriptionTerms?.length && (
                <p>
                  {t("activity:issue_report.preview_terms", {
                    terms: report.features.descriptionTerms.join(", "),
                  })}
                </p>
              )}
              <p className="text-muted-foreground">{t("activity:issue_report.preview_private")}</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                className="mt-1"
              />
              <span>{t("activity:issue_report.consent")}</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => changeOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button disabled={!canSubmit} onClick={submit}>
              {t("activity:issue_report.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
