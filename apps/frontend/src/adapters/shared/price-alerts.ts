import type { NewPriceAlert, PriceAlert, PriceAlertEvent } from "@/lib/types";

import { invoke } from "./platform";

export const getPriceAlerts = (): Promise<PriceAlert[]> => invoke<PriceAlert[]>("get_price_alerts");

export const getPriceAlertEvents = (unacknowledgedOnly = false): Promise<PriceAlertEvent[]> =>
  invoke<PriceAlertEvent[]>("get_price_alert_events", { unacknowledgedOnly });

export const getUnacknowledgedPriceAlertCount = (): Promise<number> =>
  invoke<number>("get_unacknowledged_price_alert_count");

export const createPriceAlert = (input: NewPriceAlert): Promise<PriceAlert> =>
  invoke<PriceAlert>("create_price_alert", { input });

export const pausePriceAlert = (id: string): Promise<PriceAlert> =>
  invoke<PriceAlert>("pause_price_alert", { id });

export const rearmPriceAlert = (id: string): Promise<PriceAlert> =>
  invoke<PriceAlert>("rearm_price_alert", { id });

export const deletePriceAlert = (id: string): Promise<void> =>
  invoke<void>("delete_price_alert", { id });

export const acknowledgePriceAlertEvents = (eventIds?: string[]): Promise<number> =>
  invoke<number>("acknowledge_price_alert_events", { eventIds });
