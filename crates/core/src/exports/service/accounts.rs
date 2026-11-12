//! Accounts and their activities.

use super::*;

impl DataExportService {
    /// Accounts with the balance of their latest valuation.
    pub(super) fn account_records(
        &self,
        lookups: &Lookups,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let accounts = lookups.exported_accounts(options);
        let ids = accounts
            .iter()
            .map(|account| account.id.clone())
            .collect::<Vec<_>>();
        let valuations = self
            .sources
            .valuations
            .get_latest_valuations(&ids)?
            .into_iter()
            .map(|valuation| (valuation.account_id.clone(), valuation))
            .collect::<HashMap<_, _>>();
        accounts
            .iter()
            .map(|account| {
                let mut record = ExportRecord::from_record(account)?;
                let valuation = valuations.get(&account.id);
                let value = |pick: fn(&DailyAccountValuation) -> Decimal| {
                    valuation.map_or(Value::Null, |valuation| decimal_value(pick(valuation)))
                };
                record.set(
                    "balanceDate",
                    valuation
                        .map(|valuation| valuation.valuation_date.format("%Y-%m-%d").to_string()),
                );
                record.set("balance", value(|valuation| valuation.total_value));
                record.set("cashBalance", value(|valuation| valuation.cash_balance));
                record.set(
                    "investmentValue",
                    value(|valuation| valuation.investment_market_value),
                );
                record.set(
                    "balanceInBaseCurrency",
                    value(|valuation| valuation.total_value_base),
                );
                record.set(
                    "baseCurrency",
                    valuation.map(|valuation| valuation.base_currency.clone()),
                );
                Ok(record)
            })
            .collect()
    }

    /// The export's dates as an exact UTC window in the user's timezone, so
    /// activities are picked by the day they show in the app.
    pub(super) fn activity_bounds(&self, options: &ExportOptions) -> Result<UtcDateRangeBounds> {
        local_date_range_utc_bounds(options.start_date, options.end_date, self.timezone())
    }

    pub(super) fn activity_count(
        &self,
        accounts: &[Account],
        options: &ExportOptions,
    ) -> Result<usize> {
        let bounds = self.activity_bounds(options)?;
        let active = self.sources.activities.search_activities_in_utc_range(
            0, 1, None, None, None, None, None, bounds.0, bounds.1, None, None,
        )?;
        let mut count = usize::try_from(active.meta.total_row_count).unwrap_or(0);
        if options.include_archived {
            let archived = accounts
                .iter()
                .filter(|account| account.is_archived)
                .map(|account| account.id.as_str())
                .collect::<HashSet<_>>();
            if !archived.is_empty() {
                // Account-scoped reads skip archived accounts, so filter the full list.
                count += self
                    .sources
                    .activities
                    .get_activities_including_archived_accounts()?
                    .into_iter()
                    .filter(|activity| archived.contains(activity.account_id.as_str()))
                    .filter(|activity| within_bounds(&bounds, activity.activity_date))
                    .count();
            }
        }
        Ok(count)
    }

    pub(super) async fn activity_records(
        &self,
        format: ExportFileFormat,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let bounds = self.activity_bounds(options)?;
        let mut response = self.sources.activities.export_activities(
            options.include_archived,
            bounds.0,
            bounds.1,
        )?;
        // Rows of cash and credit-card accounts carry their running balance.
        self.sources
            .activities
            .attach_cash_balances(&mut response)
            .await?;
        let ids = response
            .data
            .iter()
            .map(|row| row.id.clone())
            .collect::<Vec<_>>();
        let spending = self.sources.spending.activity_spending(&ids).await?;
        response
            .data
            .iter()
            .map(|row| {
                let mut record = ExportRecord::from_record(row)?;
                // The activity CSV has always named this column "symbol".
                if format == ExportFileFormat::Csv {
                    record.rename("assetId", "symbol");
                }
                let columns = spending.get(&row.id).cloned().unwrap_or_default();
                record.set("category", columns.category);
                record.set("categoryId", columns.category_id);
                record.set("event", columns.event);
                record.set("splits", columns.splits.unwrap_or(Value::Null));
                Ok(record)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn activity_dates_follow_the_users_timezone() {
        // 02:00 UTC on Jan 3 is still Jan 2 in Toronto.
        let options = ExportOptions {
            start_date: Some(date(2026, 1, 2)),
            end_date: Some(date(2026, 1, 2)),
            ..ExportOptions::default()
        };
        let bounds = local_date_range_utc_bounds(
            options.start_date,
            options.end_date,
            chrono_tz::America::Toronto,
        )
        .unwrap();
        let late_evening: chrono::DateTime<chrono::Utc> = "2026-01-03T02:00:00Z".parse().unwrap();
        let next_morning: chrono::DateTime<chrono::Utc> = "2026-01-03T06:00:00Z".parse().unwrap();
        assert!(within_bounds(&bounds, late_evening));
        assert!(!within_bounds(&bounds, next_morning));
    }
}
