import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@wealthfolio/ui";

import { ExternalLink } from "@/components/external-link";
import { useCreateCustomProvider, useUpdateCustomProvider } from "@/hooks/use-custom-providers";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  CustomProviderWithSources,
  NewCustomProviderSource,
} from "@/lib/types/custom-provider";
import { cn } from "@/lib/utils";

import { SourceConfigPanel } from "./source-config-panel";
import { LivePreviewPane } from "./live-preview-pane";
import { useSourceRuntime, type SourceRuntime } from "./use-source-runtime";

const DOCS_URL = "https://wealthfolio.app/docs/guide/custom-providers/";

// Base fields use `.default(...)` so zod substitutes sane defaults when the
// inactive source's inputs aren't mounted (e.g. Dated-series mode only renders
// the historical panel, so `latestSource` fields may come through undefined).
// Real required-field checking is done in the `superRefine` below, gated by
// `latestEnabled` / `historicalEnabled`.
const sourceSchema = z.object({
  format: z.enum(["json", "html", "html_table", "csv"]).default("json"),
  url: z.string().default(""),
  pricePath: z.string().default(""),
  datePath: z.string().optional(),
  dateFormat: z.string().optional(),
  currencyPath: z.string().optional(),
  factor: z.coerce.number().optional(),
  invert: z.boolean().optional(),
  locale: z.string().optional(),
  headers: z.string().optional(),
  openPath: z.string().optional(),
  highPath: z.string().optional(),
  lowPath: z.string().optional(),
  volumePath: z.string().optional(),
  defaultPrice: z.coerce.number().optional(),
  dateTimezone: z.string().optional(),
});

function makeFormSchema(t: TFunction) {
  return z
    .object({
      name: z.string().min(1, t("settings:market_data_page.validation_name_required")),
      code: z
        .string()
        .min(1, t("settings:market_data_page.validation_code_required"))
        .regex(/^[a-z0-9-]+$/, t("settings:market_data_page.validation_code_format")),
      description: z.string().optional(),
      priority: z.coerce.number().int().min(1).default(50),
      latestEnabled: z.boolean(),
      latestSource: sourceSchema,
      historicalEnabled: z.boolean(),
      historicalSource: sourceSchema,
    })
    .superRefine((values, ctx) => {
      if (!values.latestEnabled && !values.historicalEnabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["latestEnabled"],
          message: t("settings:market_data_page.validation_enable_one_source"),
        });
      }
      if (values.latestEnabled) validateSource(ctx, "latestSource", values.latestSource, t);
      if (values.historicalEnabled)
        validateSource(ctx, "historicalSource", values.historicalSource, t);
    });
}

export type FormValues = z.infer<ReturnType<typeof makeFormSchema>>;
type SourceFormValues = z.infer<typeof sourceSchema>;
export type SourceKey = "latestSource" | "historicalSource";
type SourceMode = "historical" | "latest" | "both";
type SubTab = "latest" | "historical";

const URL_RE = /^https?:\/\//i;

function emptySource(dateTimezoneDefault = ""): SourceFormValues {
  return {
    format: "json",
    url: "",
    pricePath: "",
    datePath: "",
    dateFormat: "",
    currencyPath: "",
    locale: "",
    headers: "",
    openPath: "",
    highPath: "",
    lowPath: "",
    volumePath: "",
    dateTimezone: dateTimezoneDefault,
  };
}

function sourceDefaults(
  source?: CustomProviderWithSources["sources"][number],
  dateTimezoneDefault = "",
): SourceFormValues {
  return source
    ? {
        format: source.format ?? "json",
        url: source.url,
        pricePath: source.pricePath,
        datePath: source.datePath ?? "",
        dateFormat: source.dateFormat ?? "",
        currencyPath: source.currencyPath ?? "",
        factor: source.factor ?? undefined,
        invert: source.invert ?? false,
        locale: source.locale ?? "",
        headers: source.headers ?? "",
        openPath: source.openPath ?? "",
        highPath: source.highPath ?? "",
        lowPath: source.lowPath ?? "",
        volumePath: source.volumePath ?? "",
        defaultPrice: source.defaultPrice ?? undefined,
        dateTimezone: source.dateTimezone ?? "",
      }
    : emptySource(dateTimezoneDefault);
}

function addSourceIssue(
  ctx: z.RefinementCtx,
  sourceKey: SourceKey,
  field: keyof SourceFormValues,
  message: string,
) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [sourceKey, field], message });
}

function validateSource(
  ctx: z.RefinementCtx,
  sourceKey: SourceKey,
  source: SourceFormValues,
  t: TFunction,
) {
  const url = source.url.trim();
  if (!url) {
    addSourceIssue(ctx, sourceKey, "url", t("settings:market_data_page.validation_url_required"));
  } else if (!URL_RE.test(url)) {
    addSourceIssue(ctx, sourceKey, "url", t("settings:market_data_page.validation_url_format"));
  }
  if (!source.pricePath.trim()) {
    addSourceIssue(
      ctx,
      sourceKey,
      "pricePath",
      t("settings:market_data_page.validation_price_path_required"),
    );
  }
  const headers = source.headers?.trim();
  if (headers) {
    try {
      JSON.parse(headers);
    } catch {
      addSourceIssue(
        ctx,
        sourceKey,
        "headers",
        t("settings:market_data_page.validation_headers_json"),
      );
    }
  }
}

function generateCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function nameFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    const domain = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (!domain) return null;
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

interface CustomProviderFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: CustomProviderWithSources;
}

export function CustomProviderForm({ open, onOpenChange, provider }: CustomProviderFormProps) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && saving) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex h-[92vh] w-[98vw] max-w-[1400px] flex-col overflow-hidden p-0 [--input-height:2.25rem]"
        showCloseButton={false}
      >
        {open && (
          <CustomProviderFormContent
            key={provider?.id ?? "__new__"}
            provider={provider}
            onOpenChange={onOpenChange}
            onSavingChange={setSaving}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function CustomProviderFormContent({
  provider,
  onOpenChange,
  onSavingChange,
}: {
  provider?: CustomProviderWithSources;
  onOpenChange: (open: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { t } = useTranslation();
  const isEditing = !!provider;
  const { mutate: createProvider, isPending: isCreating } = useCreateCustomProvider();
  const { mutate: updateProvider, isPending: isUpdating } = useUpdateCustomProvider();
  const { settings } = useSettingsContext();
  const isSaving = isCreating || isUpdating;

  useEffect(() => {
    onSavingChange(isSaving);
  }, [isSaving, onSavingChange]);

  const latestSourceInitial = provider?.sources.find((s) => s.kind === "latest");
  const historicalSourceInitial = provider?.sources.find((s) => s.kind === "historical");

  // For brand-new providers, seed dateTimezone with the user's global timezone
  // from app settings. Editing an existing provider keeps whatever was saved.
  const defaultTimezone = settings?.timezone ?? "";

  const formSchema = useMemo(() => makeFormSchema(t), [t]);

  const form = useForm<FormValues>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(formSchema) as any,
    defaultValues: {
      name: provider?.name ?? "",
      code: provider?.id ?? "",
      description: provider?.description ?? "",
      priority: provider?.priority ?? 50,
      latestEnabled: !!latestSourceInitial || !historicalSourceInitial,
      latestSource: sourceDefaults(latestSourceInitial, defaultTimezone),
      historicalEnabled: !!historicalSourceInitial,
      historicalSource: sourceDefaults(historicalSourceInitial, defaultTimezone),
    },
  });

  const [nameManuallyEdited, setNameManuallyEdited] = useState(isEditing);
  const [codeManuallyEdited, setCodeManuallyEdited] = useState(isEditing);
  const [subTab, setSubTab] = useState<SubTab>(
    historicalSourceInitial && !latestSourceInitial ? "historical" : "latest",
  );

  const handleUrlChange = useCallback(
    (url: string) => {
      if (isEditing) return;
      const derived = nameFromUrl(url);
      if (!derived) return;
      if (!nameManuallyEdited) {
        form.setValue("name", derived);
        if (!codeManuallyEdited) {
          form.setValue("code", generateCode(derived));
        }
      }
    },
    [isEditing, nameManuallyEdited, codeManuallyEdited, form],
  );

  const handleNameChange = (value: string, onChange: (v: string) => void) => {
    setNameManuallyEdited(true);
    onChange(value);
    if (!codeManuallyEdited && !isEditing) {
      form.setValue("code", generateCode(value));
    }
  };

  const latestRuntime = useSourceRuntime({
    form,
    prefix: "latestSource",
    isHistorical: false,
    onUrlChange: handleUrlChange,
  });
  const historicalRuntime = useSourceRuntime({
    form,
    prefix: "historicalSource",
    isHistorical: true,
    onUrlChange: handleUrlChange,
  });

  const latestEnabled = form.watch("latestEnabled");
  const historicalEnabled = form.watch("historicalEnabled");
  const name = form.watch("name");

  const sourceMode: SourceMode =
    latestEnabled && historicalEnabled ? "both" : historicalEnabled ? "historical" : "latest";

  const setSourceMode = (mode: SourceMode) => {
    form.clearErrors(["latestEnabled", "latestSource", "historicalSource"]);
    form.setValue("latestEnabled", mode === "latest" || mode === "both", { shouldValidate: true });
    form.setValue("historicalEnabled", mode === "historical" || mode === "both", {
      shouldValidate: true,
    });
    setSubTab(mode === "historical" ? "historical" : "latest");
  };

  const activeSource: SubTab =
    sourceMode === "both" ? subTab : sourceMode === "historical" ? "historical" : "latest";

  const activePrefix: SourceKey = activeSource === "latest" ? "latestSource" : "historicalSource";
  const activeRuntime: SourceRuntime =
    activeSource === "latest" ? latestRuntime : historicalRuntime;

  // Watched values feed the footer checklist — using `watch` (not `getValues`)
  // so the memo recomputes whenever the user edits the URL or Price path.
  const latestUrlValue = form.watch("latestSource.url");
  const latestPriceValue = form.watch("latestSource.pricePath");
  const historicalUrlValue = form.watch("historicalSource.url");
  const historicalPriceValue = form.watch("historicalSource.pricePath");

  const checklist = useMemo(() => {
    const check = (enabled: boolean, url: string | undefined, price: string | undefined) => {
      if (!enabled) return { url: true, mapped: true };
      return { url: !!url && URL_RE.test(url), mapped: !!price };
    };
    const latestCheck = check(latestEnabled, latestUrlValue, latestPriceValue);
    const historicalCheck = check(historicalEnabled, historicalUrlValue, historicalPriceValue);
    return {
      urlTemplate: latestCheck.url && historicalCheck.url && (latestEnabled || historicalEnabled),
      fetchSucceeds:
        (!latestEnabled ||
          latestRuntime.status?.ok === true ||
          !!latestRuntime.testResult?.success) &&
        (!historicalEnabled ||
          historicalRuntime.status?.ok === true ||
          !!historicalRuntime.testResult?.success) &&
        (latestEnabled || historicalEnabled),
      requiredFieldsMapped: latestCheck.mapped && historicalCheck.mapped,
      providerName: !!name,
    };
  }, [
    latestEnabled,
    historicalEnabled,
    latestUrlValue,
    latestPriceValue,
    historicalUrlValue,
    historicalPriceValue,
    latestRuntime.status,
    latestRuntime.testResult,
    historicalRuntime.status,
    historicalRuntime.testResult,
    name,
  ]);

  const handleSave = useCallback(
    (values: FormValues) => {
      const mapSource = (
        src: SourceFormValues,
        kind: "latest" | "historical",
      ): NewCustomProviderSource => ({
        kind,
        format: src.format,
        url: src.url,
        pricePath: src.pricePath,
        datePath: src.datePath || undefined,
        dateFormat: src.dateFormat || undefined,
        currencyPath: src.currencyPath || undefined,
        factor: src.factor ?? undefined,
        invert: src.invert ?? undefined,
        locale: src.locale || undefined,
        headers: src.headers || undefined,
        openPath: src.openPath || undefined,
        highPath: src.highPath || undefined,
        lowPath: src.lowPath || undefined,
        volumePath: src.volumePath || undefined,
        defaultPrice: src.defaultPrice ?? undefined,
        dateTimezone: src.dateTimezone || undefined,
      });

      const sources: NewCustomProviderSource[] = [];
      if (values.latestEnabled) sources.push(mapSource(values.latestSource, "latest"));
      if (values.historicalEnabled) sources.push(mapSource(values.historicalSource, "historical"));

      if (isEditing && provider) {
        updateProvider(
          {
            providerId: provider.id,
            payload: {
              name: values.name,
              description: values.description || undefined,
              priority: values.priority,
              sources,
            },
          },
          { onSuccess: () => onOpenChange(false) },
        );
      } else {
        createProvider(
          {
            code: values.code,
            name: values.name,
            description: values.description || undefined,
            priority: values.priority,
            sources,
          },
          { onSuccess: () => onOpenChange(false) },
        );
      }
    },
    [isEditing, provider, createProvider, updateProvider, onOpenChange],
  );

  // Sub-pill dot colour — green when source looks configured
  const latestConfigured = isSubConfigured(form, "latestSource", latestRuntime);
  const historicalConfigured = isSubConfigured(form, "historicalSource", historicalRuntime);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSave, (errors) => {
          console.warn("[CustomProviderForm] validation errors:", errors);
          const messages = collectErrorMessages(errors);
          toast({
            title: t("settings:market_data_page.form_has_errors"),
            description:
              messages.length > 0
                ? messages.slice(0, 4).join(" · ")
                : t("settings:market_data_page.form_invalid_fields"),
            variant: "destructive",
          });
          if (errors.name || errors.code) {
            document.getElementById("provider-identity-card")?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }
        })}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* ── Header ── */}
        <div className="bg-background flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <DialogTitle className="text-lg font-semibold">
              {isEditing
                ? t("settings:market_data_page.edit_custom_provider")
                : t("settings:market_data_page.add_custom_provider")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-sm">
              {t("settings:market_data_page.custom_provider_dialog_description")}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <ExternalLink
              href={DOCS_URL}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors"
            >
              <Icons.FileText className="h-3.5 w-3.5" />
              {t("settings:market_data_page.docs")}
            </ExternalLink>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
              className="h-8 w-8"
              aria-label={t("common:close")}
            >
              <Icons.Close className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* ── Body: two-pane ── */}
        <div className="bg-muted/40 grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_560px]">
          {/* LEFT pane */}
          <div className="min-h-0 space-y-3 overflow-y-auto border-r p-4">
            {/* Provider Mode */}
            <div>
              <div className="text-muted-foreground mb-2 text-[11px] font-medium uppercase tracking-wide">
                {t("settings:market_data_page.provider_mode")}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <ModeCard
                  selected={sourceMode === "historical"}
                  icon={<Icons.History className="h-4 w-4 shrink-0" />}
                  title={t("settings:market_data_page.mode_dated_series")}
                  subtitle={t("settings:market_data_page.mode_dated_series_subtitle")}
                  onClick={() => setSourceMode("historical")}
                />
                <ModeCard
                  selected={sourceMode === "latest"}
                  icon={<Icons.TrendingUp className="h-4 w-4 shrink-0" />}
                  title={t("settings:market_data_page.mode_latest_only")}
                  subtitle={t("settings:market_data_page.mode_latest_only_subtitle")}
                  onClick={() => setSourceMode("latest")}
                />
                <ModeCard
                  selected={sourceMode === "both"}
                  icon={<Icons.BarChart className="h-4 w-4 shrink-0" />}
                  title={t("settings:market_data_page.mode_both")}
                  subtitle={t("settings:market_data_page.mode_both_subtitle")}
                  onClick={() => setSourceMode("both")}
                />
              </div>

              {sourceMode === "both" && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <SubPill
                    selected={subTab === "latest"}
                    label={t("settings:market_data_page.sub_latest_price")}
                    configured={latestConfigured}
                    onClick={() => setSubTab("latest")}
                  />
                  <SubPill
                    selected={subTab === "historical"}
                    label={t("settings:market_data_page.sub_historical")}
                    configured={historicalConfigured}
                    onClick={() => setSubTab("historical")}
                  />
                </div>
              )}

              {form.formState.errors.latestEnabled?.message && (
                <p className="text-destructive mt-2 text-xs">
                  {form.formState.errors.latestEnabled.message}
                </p>
              )}
            </div>

            {/* Step 1 + 2 */}
            <SourceConfigPanel
              key={activePrefix}
              form={form}
              prefix={activePrefix}
              runtime={activeRuntime}
              onUrlChange={handleUrlChange}
            />

            {/* Step 3 — Provider identity */}
            <div id="provider-identity-card" className="bg-background rounded-xl border p-4">
              <div className="mb-3 flex items-center gap-2.5">
                <div className="bg-muted text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                  3
                </div>
                <h3 className="text-sm font-semibold">
                  {t("settings:market_data_page.provider_identity")}
                </h3>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_80px]">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                        {t("settings:market_data_page.provider_name")}
                        {!nameManuallyEdited && !isEditing && form.getValues("name") && (
                          <span className="text-muted-foreground ml-1 font-normal normal-case tracking-normal">
                            {t("settings:market_data_page.provider_name_from_url")}
                          </span>
                        )}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t("settings:market_data_page.provider_name_placeholder")}
                          {...field}
                          onChange={(e) => handleNameChange(e.target.value, field.onChange)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                        {t("settings:market_data_page.code")}{" "}
                        <span className="font-normal normal-case tracking-normal">
                          {t("settings:market_data_page.code_auto")}
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t("settings:market_data_page.code_placeholder")}
                          disabled={isEditing}
                          {...field}
                          onChange={(e) => {
                            setCodeManuallyEdited(true);
                            field.onChange(e.target.value);
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                        {t("settings:market_data_page.priority")}
                      </FormLabel>
                      <FormControl>
                        <Input type="number" min={1} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="mt-3">
                    <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                      {t("common:description")}{" "}
                      <span className="font-normal normal-case tracking-normal">
                        {t("settings:market_data_page.description_optional")}
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder={t("settings:market_data_page.description_placeholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>

          {/* RIGHT pane */}
          <div className="min-h-0 overflow-hidden">
            <LivePreviewPane form={form} prefix={activePrefix} runtime={activeRuntime} />
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="bg-background flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <ChecklistItem
              done={checklist.urlTemplate}
              label={t("settings:market_data_page.checklist_url_template")}
            />
            <ChecklistItem
              done={checklist.fetchSucceeds}
              label={t("settings:market_data_page.checklist_fetch_succeeds")}
            />
            <ChecklistItem
              done={checklist.requiredFieldsMapped}
              label={t("settings:market_data_page.checklist_required_fields")}
            />
            <ChecklistItem
              done={checklist.providerName}
              label={t("settings:market_data_page.checklist_provider_name")}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? (
                <>
                  <Icons.Spinner className="mr-1.5 h-4 w-4 animate-spin" />
                  {t("settings:market_data_page.saving")}
                </>
              ) : (
                <>
                  <Icons.Check className="mr-1.5 h-4 w-4" />
                  {isEditing
                    ? t("settings:market_data_page.save_changes")
                    : t("settings:market_data_page.create_provider")}
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function ModeCard({
  selected,
  icon,
  title,
  subtitle,
  onClick,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg border p-3 text-left transition-all",
        selected
          ? "bg-background border-foreground/30 ring-foreground/5 shadow-sm ring-1"
          : "bg-background/50 border-border hover:bg-background",
      )}
    >
      <div
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-foreground bg-foreground" : "border-muted-foreground/40",
        )}
      >
        {selected && <div className="bg-background h-1.5 w-1.5 rounded-full" />}
      </div>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{subtitle}</span>
      </span>
    </button>
  );
}

function SubPill({
  selected,
  label,
  configured,
  onClick,
}: {
  selected: boolean;
  label: string;
  configured: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
        selected
          ? "bg-background border-foreground/30 shadow-sm"
          : "bg-background/30 text-muted-foreground hover:bg-background/60",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          configured ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      <span className="font-medium">{label}</span>
    </button>
  );
}

function ChecklistItem({ done, label }: { done: boolean; label: string }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        done ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {done ? (
        <Icons.CheckCircle className="text-success h-4 w-4 shrink-0" />
      ) : (
        <Icons.Circle className="text-muted-foreground/40 h-4 w-4 shrink-0" />
      )}
      {label}
    </div>
  );
}

/** Walk react-hook-form's nested error object, return human-readable messages with field paths. */
function collectErrorMessages(errors: unknown, path = ""): string[] {
  if (!errors || typeof errors !== "object") return [];
  const out: string[] = [];
  const record = errors as Record<string, unknown>;
  // react-hook-form marks leaf errors with a `message` string and a `type`.
  if (typeof record.message === "string" && record.message.length > 0) {
    return [path ? `${path}: ${record.message}` : record.message];
  }
  for (const [k, v] of Object.entries(record)) {
    if (k === "ref" || k === "type") continue;
    const nextPath = path ? `${path}.${k}` : k;
    out.push(...collectErrorMessages(v, nextPath));
  }
  return out;
}

function isSubConfigured(
  form: ReturnType<typeof useForm<FormValues>>,
  prefix: SourceKey,
  runtime: SourceRuntime,
): boolean {
  const url = form.getValues(`${prefix}.url`);
  const price = form.getValues(`${prefix}.pricePath`);
  return !!url && !!price && (runtime.status?.ok === true || !!runtime.testResult?.success);
}
