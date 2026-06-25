-- Trade Republic CSV export template
INSERT OR REPLACE INTO import_templates (id, name, scope, kind, source_system, config_version, config, created_at, updated_at)
VALUES (
    'system_trade_republic',
    'Trade Republic',
    'SYSTEM',
    'CSV_ACTIVITY',
    '',
    1,
    '{"fieldMappings":{"date":"datetime","activityType":"type","symbol":"symbol","isin":"symbol","quantity":"shares","unitPrice":"price","amount":"amount","fee":"fee","currency":"currency","fxRate":"fx_rate","comment":"description"},"activityMappings":{"BUY":["BUY","PRIVATE_MARKET_BUY"],"SELL":["SELL","PRIVATE_MARKET_SELL","FINAL_MATURITY","TILG"],"DIVIDEND":["DIVIDEND","DISTRIBUTION","DIVIDEND_EQUIVALENT_PAYMENT"],"INTEREST":["INTEREST_PAYMENT","COUPON_PAYMENT"],"DEPOSIT":["CUSTOMER_INBOUND","CUSTOMER_INPAYMENT","TRANSFER_INBOUND","TRANSFER_INSTANT_INBOUND","GIFT","BENEFITS_SAVEBACK","FREE_RECEIPT","MIGRATION","STOCKPERK","TRANSFER_DIRECT_DEBIT_INBOUND","MANUAL_CASH_TRANSFER"],"WITHDRAWAL":["CUSTOMER_OUTBOUND_REQUEST","CUSTOMER_OUTBOUND","CARD_TRANSACTION","CARD_TRANSACTION_INTERNATIONAL","TRANSFER_INSTANT_OUTBOUND","TRANSFER_OUTBOUND"],"TAX":["PRE_DETERMINED_TAX_BASE"],"FEE":["ROUND_UP_FEE","ROUND_UP_SAVINGS_FEE","CARD_ORDERING_FEE"]},"symbolMappings":{},"accountMappings":{},"symbolMappingMeta":{},"parseConfig":{"delimiter":"auto","dateFormat":"ISO8601","decimalSeparator":".","thousandsSeparator":"none","hasHeaderRow":true,"skipTopRows":0,"skipBottomRows":0}}',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
