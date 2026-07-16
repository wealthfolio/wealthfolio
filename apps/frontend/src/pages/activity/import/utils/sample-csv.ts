const SAMPLE_CSV_CONTENT = `date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype
2024-01-15,MSFT,EQUITY,10,BUY,380.50,USD,4.95,0,,,
2024-01-20,AAPL,EQUITY,5,BUY,185.25,USD,4.95,0,,,
2024-02-01,MSFT,EQUITY,1,DIVIDEND,0.75,USD,0,0.11,0.75,,QUALIFIED
2024-02-15,,,1,DEPOSIT,1,USD,0,0,1000.00,,
2024-03-01,AAPL,EQUITY,2,SELL,175.00,USD,4.95,0,,,
2024-03-10,VOO,EQUITY,3,BUY,450.00,USD,0,0,,,
2024-03-15,,,1,WITHDRAWAL,1,USD,0,0,500.00,,
2024-04-01,VOO,EQUITY,1,DIVIDEND,1.50,USD,0,0,1.50,,DRIP
2024-04-15,MSFT,EQUITY,5,SELL,410.00,USD,4.95,0,,,
2024-04-20,NVDA,EQUITY,,SPLIT,,USD,,0,3,,
2024-05-01,,,1,INTEREST,1,USD,0,0,12.50,,COUPON
2024-06-01,TD.TO,EQUITY,10,BUY,85.00,CAD,9.99,0,,1.36,`;

/**
 * Downloads the sample CSV template for activity imports.
 * The sample demonstrates all supported activity types and fields.
 * Uses Blob approach to work in both web and Tauri environments.
 */
export function downloadSampleCsv() {
  const blob = new Blob([SAMPLE_CSV_CONTENT], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sample-import.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const SAMPLE_HOLDINGS_CSV_CONTENT = `date,symbol,quantity,avgCost,currency
2024-03-31,AAPL,50,171.48,USD
2024-03-31,MSFT,30,420.72,USD
2024-03-31,VOO,20,468.50,USD
2024-03-31,$CASH,5000,,USD
2024-06-30,AAPL,55,210.62,USD
2024-06-30,MSFT,30,446.34,USD
2024-06-30,VOO,25,495.89,USD
2024-06-30,$CASH,3200,,USD`;

export function downloadSampleHoldingsCsv() {
  const blob = new Blob([SAMPLE_HOLDINGS_CSV_CONTENT], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sample-holdings-import.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
