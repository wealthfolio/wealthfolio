import { useAssets } from "@/pages/asset/hooks/use-assets";
import type { Asset, PriceAlert, PriceAlertEvent } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import {
  Badge,
  Button,
  Page,
  PageContent,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  formatPrice,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CreatePriceAlertDialog } from "../components/create-price-alert-dialog";
import {
  usePriceAlertEvents,
  usePriceAlertMutations,
  usePriceAlerts,
} from "../hooks/use-price-alerts";

function assetLabel(asset?: Asset) {
  if (!asset) return "-";
  return asset.displayCode ?? asset.instrumentSymbol ?? asset.name ?? asset.id;
}

function timestampLabel(value: string) {
  const formatted = formatDateTime(value);
  return `${formatted.date} ${formatted.time}`;
}

function Target({ alert }: { alert: PriceAlert }) {
  const { t } = useTranslation();
  return (
    <span className="font-medium tabular-nums">
      {t(`common:price_alerts.condition.${alert.condition.toLowerCase()}`)}{" "}
      {formatPrice(alert.targetPrice, alert.currency)}
    </span>
  );
}

function EmptyState({ triggered }: { triggered?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Icons.Bell className="text-muted-foreground h-8 w-8" />
      <div>
        <p className="font-medium">
          {t(
            triggered
              ? "common:price_alerts.empty.triggered_title"
              : "common:price_alerts.empty.active_title",
          )}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          {t(
            triggered
              ? "common:price_alerts.empty.triggered_description"
              : "common:price_alerts.empty.active_description",
          )}
        </p>
      </div>
    </div>
  );
}

export default function PriceAlertsPage() {
  const { t } = useTranslation();
  const { assets, isLoading: assetsLoading } = useAssets();
  const alertsQuery = usePriceAlerts();
  const eventsQuery = usePriceAlertEvents();
  const { pauseMutation, rearmMutation, deleteMutation, acknowledgeMutation } =
    usePriceAlertMutations();
  const [createOpen, setCreateOpen] = useState(false);

  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const alertsById = useMemo(
    () => new Map((alertsQuery.data ?? []).map((alert) => [alert.id, alert])),
    [alertsQuery.data],
  );
  const managedAlerts = (alertsQuery.data ?? []).filter((alert) => alert.status !== "TRIGGERED");
  const events = eventsQuery.data ?? [];
  const unreadEvents = events.filter((event) => !event.acknowledgedAt);
  const isLoading = assetsLoading || alertsQuery.isLoading || eventsQuery.isLoading;

  return (
    <Page>
      <PageHeader
        heading={t("common:price_alerts.title")}
        text={t("common:price_alerts.subtitle")}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Icons.Plus className="mr-2 h-4 w-4" />
            {t("common:price_alerts.new_alert")}
          </Button>
        }
      />
      <PageContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <Tabs defaultValue="active">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="active">
                  {t("common:price_alerts.tabs.active")}
                  <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                    {managedAlerts.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="triggered">
                  {t("common:price_alerts.tabs.triggered")}
                  {unreadEvents.length > 0 && (
                    <Badge className="ml-1 px-1.5 py-0 text-[10px]">{unreadEvents.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>
              {unreadEvents.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => acknowledgeMutation.mutate(unreadEvents.map((event) => event.id))}
                  disabled={acknowledgeMutation.isPending}
                >
                  <Icons.Check className="mr-2 h-4 w-4" />
                  {t("common:price_alerts.mark_all_read")}
                </Button>
              )}
            </div>

            <TabsContent value="active" className="mt-5">
              {managedAlerts.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("common:price_alerts.columns.asset")}</TableHead>
                        <TableHead>{t("common:price_alerts.columns.target")}</TableHead>
                        <TableHead>{t("common:price_alerts.columns.status")}</TableHead>
                        <TableHead>{t("common:price_alerts.columns.created")}</TableHead>
                        <TableHead className="w-28 text-right">
                          {t("common:price_alerts.columns.actions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {managedAlerts.map((alert) => (
                        <TableRow key={alert.id}>
                          <TableCell>
                            <div className="font-medium">
                              {assetLabel(assetsById.get(alert.assetId))}
                            </div>
                            <div className="text-muted-foreground text-xs">
                              {assetsById.get(alert.assetId)?.name}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Target alert={alert} />
                          </TableCell>
                          <TableCell>
                            <Badge variant={alert.status === "ACTIVE" ? "default" : "secondary"}>
                              {t(`common:price_alerts.status.${alert.status.toLowerCase()}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                            {timestampLabel(alert.createdAt)}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              {alert.status === "ACTIVE" ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={t("common:price_alerts.actions.pause")}
                                  onClick={() => pauseMutation.mutate(alert.id)}
                                >
                                  <Icons.Pause className="h-4 w-4" />
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={t("common:price_alerts.actions.rearm")}
                                  onClick={() => rearmMutation.mutate(alert.id)}
                                >
                                  <Icons.RotateCcw className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("common:delete")}
                                onClick={() => deleteMutation.mutate(alert.id)}
                              >
                                <Icons.Trash2 className="text-destructive h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="triggered" className="mt-5">
              {events.length === 0 ? (
                <EmptyState triggered />
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("common:price_alerts.columns.asset")}</TableHead>
                        <TableHead>{t("common:price_alerts.columns.target")}</TableHead>
                        <TableHead>{t("common:price_alerts.columns.observed")}</TableHead>
                        <TableHead>{t("common:price_alerts.columns.triggered")}</TableHead>
                        <TableHead className="w-28 text-right">
                          {t("common:price_alerts.columns.actions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {events.map((event: PriceAlertEvent) => {
                        const alert = alertsById.get(event.alertId);
                        return (
                          <TableRow
                            key={event.id}
                            className={!event.acknowledgedAt ? "bg-muted/30" : undefined}
                          >
                            <TableCell>
                              <div className="flex items-center gap-2 font-medium">
                                {!event.acknowledgedAt && (
                                  <span className="bg-primary h-2 w-2 rounded-full" />
                                )}
                                {assetLabel(assetsById.get(event.assetId))}
                              </div>
                            </TableCell>
                            <TableCell className="font-medium tabular-nums">
                              {alert ? (
                                <Target alert={alert} />
                              ) : (
                                formatPrice(event.targetPrice, event.currency)
                              )}
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {formatPrice(event.observedClose, event.currency)}
                            </TableCell>
                            <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                              {timestampLabel(event.triggeredAt)}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                {!event.acknowledgedAt && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title={t("common:price_alerts.actions.mark_read")}
                                    onClick={() => acknowledgeMutation.mutate([event.id])}
                                  >
                                    <Icons.Check className="h-4 w-4" />
                                  </Button>
                                )}
                                {alert && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title={t("common:price_alerts.actions.rearm")}
                                    onClick={() => rearmMutation.mutate(alert.id)}
                                  >
                                    <Icons.RotateCcw className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </PageContent>

      <CreatePriceAlertDialog assets={assets} open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}
