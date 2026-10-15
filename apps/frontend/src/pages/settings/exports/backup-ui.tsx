import { Fragment, useState, type ComponentType, type ReactNode } from "react";
import { FileArchiveIcon } from "@phosphor-icons/react/dist/csr/FileArchive";
import { useTranslation } from "react-i18next";
import { Alert } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { ActionPalette } from "@/components/action-palette";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { BackupError, type BackupFailure } from "./backup-error";

/** Rows shown before "Show older". Connect returns at most 30 restore points. */
const BACKUP_LIST_LIMIT = 5;

/** Help that stays one tap away; popovers, unlike tooltips, also open on touch. */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground pointer-coarse:size-11"
            aria-label={label}
          />
        }
      >
        <Icons.Info className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="text-muted-foreground w-80 space-y-2 text-sm leading-relaxed"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Card header shared by cloud and local backups. On phones the title row keeps only the menu;
 * the dates and the action take the full card width below it.
 */
export function BackupCardHeader({
  icon,
  brand = false,
  title,
  info,
  badge,
  subtitle,
  action,
  menu,
}: {
  icon: ReactNode;
  brand?: boolean;
  title: string;
  info?: ReactNode;
  badge?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 md:grid-cols-[auto_minmax(0,1fr)_auto_auto] md:gap-y-0.5">
      <div
        className={`hidden size-10 items-center justify-center rounded-xl md:row-span-2 md:flex [&_svg]:size-5 ${brand ? "bg-connect-brand/10 text-connect-brand" : "bg-muted text-muted-foreground"}`}
      >
        {icon}
      </div>
      <div className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:col-start-2">
        <h2 className="text-base font-semibold leading-6 tracking-tight">{title}</h2>
        {info}
        {badge}
      </div>
      {subtitle && (
        <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2">
          {subtitle}
        </div>
      )}
      {action && (
        <div className="col-span-2 row-start-3 flex md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1 max-md:[&>button]:w-full">
          {action}
        </div>
      )}
      {menu && (
        <div className="col-start-2 row-start-1 flex justify-end self-start md:col-start-4 md:row-span-2 md:self-center">
          {menu}
        </div>
      )}
    </div>
  );
}

/** Inline on desktop; label and value rows on phones, so a date never splits across lines. */
export function InlineFacts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="text-muted-foreground flex flex-col gap-1 text-sm md:flex-row md:flex-wrap md:gap-x-4 md:gap-y-0.5">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-wrap items-baseline justify-between gap-x-3 md:block"
        >
          <dt className="md:inline">{item.label}</dt>{" "}
          <dd className="text-foreground whitespace-nowrap md:inline">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BackupAlert({ error, action }: { error: BackupFailure; action?: ReactNode }) {
  return (
    <Alert className="border-destructive/20 bg-destructive/5 text-destructive [&>svg]:text-destructive">
      <Icons.AlertCircle className="size-4" aria-hidden />
      <div className="space-y-2 break-words text-sm">
        <BackupError error={error} />
        {action}
      </div>
    </Alert>
  );
}

export function BackupList<T>({
  items,
  label,
  children,
}: {
  items: T[];
  label: string;
  children: (item: T) => ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, BACKUP_LIST_LIMIT);
  return (
    <div className="space-y-1">
      <ul className="divide-y" aria-label={label}>
        {visible.map(children)}
      </ul>
      {items.length > BACKUP_LIST_LIMIT && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground pointer-coarse:min-h-11 w-full"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("settings:backup_show_fewer")
            : t("settings:backup_show_older", { count: items.length - visible.length })}
          <Icons.ChevronDown
            className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          />
        </Button>
      )}
    </div>
  );
}

/** Muted tile with a duotone file icon; each backup is one saved snapshot file. */
export function BackupFileTile({ className = "flex" }: { className?: string }) {
  return (
    <span
      className={`bg-muted text-muted-foreground size-9 shrink-0 items-center justify-center rounded-lg ${className}`}
    >
      <FileArchiveIcon weight="duotone" className="size-5" aria-hidden />
    </span>
  );
}

export function BackupRow({
  title,
  meta,
  details = [],
  actions,
}: {
  title: ReactNode;
  meta: ReactNode[];
  /** Shown from tablet width up; phones keep the row to one readable line. */
  details?: ReactNode[];
  actions: ReactNode;
}) {
  const parts = [
    ...meta.filter(Boolean).map((part) => ({ part, detail: false })),
    ...details.filter(Boolean).map((part) => ({ part, detail: true })),
  ];
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <BackupFileTile className="hidden md:flex" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5">{title}</p>
        <p className="text-muted-foreground mt-0.5 truncate text-xs leading-5">
          {parts.map(({ part, detail }, index) => (
            <span
              key={index}
              className={`[&_svg]:mr-1 [&_svg]:inline [&_svg]:align-[-2px] ${detail ? "max-md:hidden" : ""}`}
            >
              {index > 0 && <span aria-hidden> · </span>}
              {part}
            </span>
          ))}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  );
}

export interface BackupAction {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/**
 * Row and card actions. Desktop keeps the main action as a button beside a menu; phones put
 * every action in the app's action palette, as on the categories page.
 */
export function BackupActions({
  title,
  label,
  primary,
  groups,
  disabled = false,
  pending = false,
}: {
  /** Palette heading on phones. */
  title: string;
  /** Accessible name of the menu button. */
  label: string;
  primary?: BackupAction & { pending?: boolean; ariaLabel?: string; withIcon?: boolean };
  groups: BackupAction[][];
  disabled?: boolean;
  /** A menu action is running. */
  pending?: boolean;
}) {
  const compact = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  const menu = groups.filter((group) => group.length > 0);
  const busy = pending || (compact && !!primary?.pending);
  const trigger = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="pointer-coarse:size-11 shrink-0 aria-busy:opacity-100"
      aria-label={label}
      aria-busy={busy}
      disabled={disabled}
    >
      {busy ? (
        <Icons.Spinner className="size-4 animate-spin" aria-hidden />
      ) : (
        <Icons.MoreHorizontal className="size-4" aria-hidden />
      )}
    </Button>
  );
  if (compact) {
    const palette = primary ? [[primary], ...menu] : menu;
    if (!palette.length) return null;
    return (
      <ActionPalette
        open={open}
        onOpenChange={setOpen}
        title={title}
        trigger={trigger}
        groups={palette.map((group) => ({
          items: group.map((action) => ({
            icon: action.icon,
            label: action.label,
            onClick: action.onSelect,
            disabled: action.disabled,
            variant: action.destructive ? ("destructive" as const) : ("default" as const),
          })),
        }))}
      />
    );
  }
  return (
    <>
      {primary && (
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11 aria-busy:opacity-100"
          disabled={disabled || primary.disabled}
          aria-busy={!!primary.pending}
          aria-label={primary.ariaLabel}
          onClick={primary.onSelect}
        >
          <PendingIcon
            pending={!!primary.pending}
            icon={primary.withIcon ? <primary.icon className="size-4" /> : undefined}
          />
          {primary.label}
        </Button>
      )}
      {menu.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={trigger} />
          <DropdownMenuContent align="end" className="min-w-48">
            {menu.map((group, index) => (
              <Fragment key={index}>
                {index > 0 && <DropdownMenuSeparator />}
                {group.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    variant={action.destructive ? "destructive" : "default"}
                    disabled={action.disabled}
                    onClick={action.onSelect}
                  >
                    <action.icon />
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

export function BackupEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed p-4">
      <Icons.History className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="space-y-0.5">
        <p className="text-sm font-medium leading-5">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
    </div>
  );
}

export function BackupRowsSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status">
      <span className="sr-only">{t("common:loading")}</span>
      <ul className="divide-y" aria-hidden>
        {[0, 1, 2].map((row) => (
          <li key={row} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <Skeleton className="hidden size-9 rounded-lg md:block" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-44 max-w-full" />
            </div>
            <Skeleton className="h-9 w-20 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PendingIcon({ pending, icon }: { pending: boolean; icon?: ReactNode }) {
  return pending ? <Icons.Spinner className="size-4 animate-spin" aria-hidden /> : (icon ?? null);
}

/** Destructive confirmation shared by local and cloud backups. */
export function BackupDeleteDialog({
  open,
  title,
  description,
  pending,
  pendingLabel,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  pending: boolean;
  pendingLabel: string;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !pending) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        mobileClassName="h-auto max-h-[85dvh] overflow-y-auto"
        showCloseButton={!pending}
      >
        <DialogHeader className="text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            <PendingIcon pending={pending} />
            {pending ? pendingLabel : t("common:delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
