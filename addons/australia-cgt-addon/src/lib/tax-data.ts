export interface AmmaStatement {
  id: string;
  holdingKey: string;
  parcelId?: string;
  incomeYear: string;
  taxableIncome: number;
  cashDistribution: number;
  frankingCredits: number;
  amitCostBaseIncrease: number;
  amitCostBaseDecrease: number;
  notes?: string;
}

export interface CpiObservation {
  quarter: string;
  value: number;
  source: "ABS" | "MANUAL";
  fetchedAt: string;
}

export interface TransitionMarketValueSnapshot {
  parcelId: string;
  symbol: string;
  account: string;
  acquisitionDate: string;
  quantity: number;
  marketValueAt2027: number;
  valuationMethod: "quoted-market" | "manual" | "apportionment";
  notes?: string;
}

export interface AmitCostBaseAdjustment {
  parcelId: string;
  incomeYear: string;
  amount: number;
  sourceStatementId?: string;
}

export interface ParcelAcquisitionOverride {
  parcelId: string;
  symbol: string;
  account: string;
  acquisitionDate: string;
  quantity?: number;
  costBase?: number;
  source: "holding-lot" | "manual";
}

export interface AustraliaCgtAddonData {
  ammaStatements: AmmaStatement[];
  cpiSeries: CpiObservation[];
  transitionSnapshots: TransitionMarketValueSnapshot[];
  amitAdjustments: AmitCostBaseAdjustment[];
  acquisitionOverrides: ParcelAcquisitionOverride[];
}

interface StoredAustraliaCgtAddonData {
  version: number;
  payload: Partial<AustraliaCgtAddonData>;
}

export interface AddonTaxDataStore {
  load(): AustraliaCgtAddonData;
  save(data: AustraliaCgtAddonData): void;
  clear(): void;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const FRANKING_PERCENTAGE_METADATA_KEY = "australiaCgt.frankingPercentage";
export const DEFAULT_ABS_QUARTERLY_CPI_URL =
  "https://data.api.abs.gov.au/rest/data/ABS,CPI_Q/1.999901.20.50.Q?lastNObservations=80&format=csv";

const STORAGE_VERSION = 1;

export function emptyAustraliaCgtAddonData(): AustraliaCgtAddonData {
  return {
    ammaStatements: [],
    cpiSeries: [],
    transitionSnapshots: [],
    amitAdjustments: [],
    acquisitionOverrides: [],
  };
}

export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

export function createAustraliaCgtAddonStore(
  storage: KeyValueStorage | undefined = globalThis.localStorage,
  namespace = "australia-cgt-addon",
): AddonTaxDataStore {
  const storageKey = `${namespace}:tax-data:v${STORAGE_VERSION}`;

  return {
    load() {
      if (!storage) return emptyAustraliaCgtAddonData();
      const raw = storage.getItem(storageKey);
      if (!raw) return emptyAustraliaCgtAddonData();

      try {
        const parsed = JSON.parse(raw) as
          | Partial<AustraliaCgtAddonData>
          | StoredAustraliaCgtAddonData;
        const payload =
          "payload" in parsed && typeof parsed.version === "number" ? parsed.payload : parsed;
        return {
          ...emptyAustraliaCgtAddonData(),
          ...payload,
        };
      } catch {
        return emptyAustraliaCgtAddonData();
      }
    },
    save(data) {
      storage?.setItem(storageKey, JSON.stringify({ version: STORAGE_VERSION, payload: data }));
    },
    clear() {
      storage?.removeItem(storageKey);
    },
  };
}

export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
  if (existingIndex === -1) return [...items, item];
  return items.map((candidate, index) => (index === existingIndex ? item : candidate));
}

export function buildAmitAdjustmentsFromAmma(
  statements: AmmaStatement[],
): AmitCostBaseAdjustment[] {
  return statements
    .map((statement) => ({
      parcelId: statement.parcelId ?? statement.holdingKey,
      incomeYear: statement.incomeYear,
      amount: statement.amitCostBaseIncrease - statement.amitCostBaseDecrease,
      sourceStatementId: statement.id,
    }))
    .filter((adjustment) => adjustment.amount !== 0);
}

export function getFrankingPercentage(
  metadata: Record<string, unknown> | undefined,
): number | null {
  const value = metadata?.[FRANKING_PERCENTAGE_METADATA_KEY];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function withFrankingPercentageMetadata(
  metadata: Record<string, unknown> | undefined,
  frankingPercentage: number,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [FRANKING_PERCENTAGE_METADATA_KEY]: frankingPercentage,
  };
}

function cpiQuarterSortKey(quarter: string): number {
  const match = /(\d{4})-Q([1-4])/.exec(quarter);
  if (!match) return 0;
  return Number(match[1]) * 10 + Number(match[2]);
}

export function calculateCpiIndexationFactor(
  series: CpiObservation[],
  startQuarter: string,
  endQuarter: string,
): number {
  const byQuarter = new Map(series.map((entry) => [entry.quarter, entry.value]));
  const startValue = byQuarter.get(startQuarter);
  const endValue = byQuarter.get(endQuarter);
  if (!startValue || !endValue || startValue <= 0) {
    throw new Error(`Missing CPI values for ${startQuarter} to ${endQuarter}`);
  }
  return endValue / startValue;
}

export function mergeCpiSeries(
  existing: CpiObservation[],
  incoming: CpiObservation[],
): CpiObservation[] {
  const byQuarter = new Map(existing.map((entry) => [entry.quarter, entry]));
  for (const entry of incoming) {
    byQuarter.set(entry.quarter, entry);
  }
  return [...byQuarter.values()].sort(
    (a, b) => cpiQuarterSortKey(a.quarter) - cpiQuarterSortKey(b.quarter),
  );
}

export function parseAbsCpiCsv(csv: string, fetchedAt: string): CpiObservation[] {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/);
  if (!headerLine) return [];
  const headers = headerLine.split(",").map((header) => header.trim().toLowerCase());
  const quarterIndex = headers.findIndex((header) =>
    ["quarter", "period", "time_period"].includes(header),
  );
  const valueIndex = ["obs_value", "value", "cpi", "index"]
    .map((candidate) => headers.indexOf(candidate))
    .find((index) => index !== -1);
  if (quarterIndex === -1 || valueIndex === undefined) return [];

  return lines
    .map((line) => line.split(",").map((value) => value.trim().replace(/^"|"$/g, "")))
    .map((columns) => ({
      quarter: columns[quarterIndex],
      value: Number.parseFloat(columns[valueIndex]),
      source: "ABS" as const,
      fetchedAt,
    }))
    .filter((entry) => entry.quarter && Number.isFinite(entry.value));
}

export async function fetchAbsCpiSeries(
  url = DEFAULT_ABS_QUARTERLY_CPI_URL,
  fetcher: typeof fetch = fetch,
  now = () => new Date().toISOString(),
): Promise<CpiObservation[]> {
  const response = await fetcher(url, {
    headers: {
      Accept: "text/csv, application/vnd.sdmx.data+csv",
    },
  });
  if (!response.ok) {
    throw new Error(`ABS CPI fetch failed with status ${response.status}`);
  }
  return parseAbsCpiCsv(await response.text(), now());
}

export async function refreshCachedAbsCpiSeries(
  data: AustraliaCgtAddonData,
  fetcher: typeof fetch = fetch,
): Promise<AustraliaCgtAddonData> {
  const incoming = await fetchAbsCpiSeries(DEFAULT_ABS_QUARTERLY_CPI_URL, fetcher);
  return {
    ...data,
    cpiSeries: mergeCpiSeries(data.cpiSeries, incoming),
  };
}
