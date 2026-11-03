import i18n from "i18next";

const FIELD_LABEL_KEYS: Record<string, string> = {
  accountId: "activity:field_account",
  fromAccountId: "activity:form.label_from_account",
  toAccountId: "activity:form.label_to_account",
  isExternal: "activity:validationFields.external",
  direction: "activity:validationFields.direction",
  transferMode: "activity:validationFields.mode",
  activityType: "activity:activity_type",
  assetId: "activity:field_symbol",
  assetSymbol: "activity:field_symbol",
  symbol: "activity:field_symbol",
  activityDate: "activity:field_date",
  date: "activity:field_date",
  quantity: "activity:form.label_quantity",
  splitRatio: "activity:field_split_ratio",
  unitPrice: "activity:field_price",
  amount: "activity:field_amount",
  fee: "activity:field_fee",
  tax: "activity:form.label_tax",
  currency: "activity:form.currency",
  fxRate: "activity:form.label_fx_rate",
  comment: "activity:form.label_notes",
  subtype: "activity:form.subtype",
  exchangeMic: "asset:editSheet.exchange",
  symbolQuoteCcy: "asset:editSheet.quote_currency",
  symbolInstrumentType: "asset:editSheet.instrument_type",
  quoteMode: "asset:createSecurity.quote_mode",
};

export function formatActivityFieldName(fieldPath: string): string {
  const leaf = fieldPath.split(".").at(-1) ?? fieldPath;
  const cleaned = leaf.replace(/\[\d+\]/g, "");
  return FIELD_LABEL_KEYS[cleaned] ? i18n.t(FIELD_LABEL_KEYS[cleaned]) : cleaned;
}
