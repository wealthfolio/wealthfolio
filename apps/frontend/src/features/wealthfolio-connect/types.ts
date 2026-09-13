// Wealthfolio Connect Types
// =========================

// ─────────────────────────────────────────────────────────────────────────────
// Broker Sync Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncConnectionsResponse {
  synced: number;
  platforms_created: number;
  platforms_updated: number;
}

export interface SyncAccountsResponse {
  synced: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface SyncActivitiesResponse {
  accounts_synced: number;
  activities_upserted: number;
  assets_inserted: number;
  accounts_failed: number;
  accounts_warned?: number;
}

export interface SyncResult {
  success: boolean;
  message: string;
  connectionsSynced: SyncConnectionsResponse | null;
  accountsSynced: SyncAccountsResponse | null;
  activitiesSynced: SyncActivitiesResponse | null;
}

export interface BrokerConnectionBrokerage {
  id?: string;
  slug?: string;
  name?: string;
  display_name?: string;
  aws_s3_logo_url?: string;
  aws_s3_square_logo_url?: string;
}

export interface BrokerConnection {
  id: string;
  brokerage?: BrokerConnectionBrokerage;
  disabled?: boolean;
  disabled_date?: string;
  updated_at?: string;
  status?: string;
  name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Account Types (from cloud API)
// ─────────────────────────────────────────────────────────────────────────────

export interface BrokerAccountOwner {
  user_id?: string;
  full_name?: string;
  email?: string;
  avatar_url?: string;
  is_own_account: boolean;
}

export interface BrokerAccountSyncStatusDetail {
  initial_sync_completed?: boolean;
  last_successful_sync?: string;
  first_transaction_date?: string;
}

export interface BrokerAccountSyncStatus {
  transactions?: BrokerAccountSyncStatusDetail;
  holdings?: BrokerAccountSyncStatusDetail;
}

export interface BrokerAccountBalance {
  total?: {
    amount: number;
    currency: string;
  };
}

export interface BrokerAccount {
  id?: string;
  name?: string;
  number?: string;
  institution_name?: string;
  balance?: BrokerAccountBalance;
  meta?: Record<string, unknown>;
  owner?: BrokerAccountOwner;
  brokerage_authorization?: string;
  created_date?: string;
  sync_status?: BrokerAccountSyncStatus;
  status?: string;
  raw_type?: string;
  is_paper: boolean;
  sync_enabled: boolean;
  shared_with_household: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Plans Types
// ─────────────────────────────────────────────────────────────────────────────

export type PlanId = "basic" | "essentials" | "duo" | "plus";
export type BillingPeriod = "monthly" | "yearly";

export interface PlanPricing {
  monthly: number;
  yearly: number;
  yearlyPerMonth?: number;
}

export interface PlanLimits {
  householdSize: number;
  institutionConnections: number | "unlimited";
  devices: number;
}

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  tagline?: string;
  description: string;
  pricing: PlanPricing;
  limits: PlanLimits;
  features: string[];
  featuresExtended?: string[];
  isAvailable: boolean;
  isComingSoon: boolean;
  badge?: string;
  yearlyDiscountPercent?: number;
}

export interface PlansResponse {
  plans: SubscriptionPlan[];
}

// ─────────────────────────────────────────────────────────────────────────────
// User Info Types
// ─────────────────────────────────────────────────────────────────────────────

export interface UserTeam {
  id: string;
  name: string;
  logo_url: string | null;
  plan: string | null;
  subscription_status: string | null;
  subscription_current_period_end: string | null;
  subscription_cancel_at_period_end: boolean | null;
  canceled_at: string | null;
  country_code: string | null;
  created_at: string | null;
}

export type DateFormat = "dd/MM/yyyy" | "MM/dd/yyyy" | "yyyy-MM-dd" | "dd.MM.yyyy";

export interface UserInfo {
  id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  locale: string | null;
  week_starts_on_monday: boolean | null;
  timezone: string | null;
  timezone_auto_sync: boolean | null;
  time_format: number | null;
  date_format: DateFormat | null;
  team_id: string | null;
  team_role: string | null;
  team: UserTeam | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Sync State Types
// ─────────────────────────────────────────────────────────────────────────────

export type SyncStatus = "IDLE" | "RUNNING" | "NEEDS_REVIEW" | "FAILED";

export interface BrokerSyncState {
  accountId: string;
  provider: string;
  checkpointJson: unknown;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
  lastRunId: string | null;
  syncStatus: SyncStatus;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import Run Types
// ─────────────────────────────────────────────────────────────────────────────

export type ImportRunType = "SYNC" | "IMPORT";
export type ImportRunMode = "INITIAL" | "INCREMENTAL" | "BACKFILL" | "REPAIR";
export type ImportRunStatus = "RUNNING" | "APPLIED" | "NEEDS_REVIEW" | "FAILED" | "CANCELLED";
export type ReviewMode = "NEVER" | "ALWAYS" | "IF_WARNINGS";

export interface ImportRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  warnings: number;
  errors: number;
  removed: number;
  assetsCreated?: number;
}

export interface ImportRun {
  id: string;
  accountId: string;
  sourceSystem: string;
  runType: ImportRunType;
  mode: ImportRunMode;
  status: ImportRunStatus;
  startedAt: string;
  finishedAt: string | null;
  reviewMode: ReviewMode;
  appliedAt: string | null;
  checkpointIn: unknown;
  checkpointOut: unknown;
  summary: ImportRunSummary | null;
  warnings: string[] | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated Sync Status (for navigation icon)
// ─────────────────────────────────────────────────────────────────────────────

export type AggregatedSyncStatus =
  | "not_connected"
  | "subscription_required"
  | "idle"
  | "running"
  | "needs_review"
  | "failed";
