//! Activity types
//!
//! Each constant represents one of the supported activity categories.
//! The descriptions mirror `docs/activity-types.md` for quick reference.

/// Purchase of a security or other asset. Decreases cash and increases quantity.
pub const ACTIVITY_TYPE_BUY: &str = "BUY";

/// Disposal of a security or other asset. Increases cash and decreases quantity.
pub const ACTIVITY_TYPE_SELL: &str = "SELL";

/// Cash dividend paid into the account. Increases cash.
pub const ACTIVITY_TYPE_DIVIDEND: &str = "DIVIDEND";

/// Interest earned on cash or fixed-income positions. Increases cash.
pub const ACTIVITY_TYPE_INTEREST: &str = "INTEREST";

/// Incoming funds from outside Wealthfolio. Increases cash.
pub const ACTIVITY_TYPE_DEPOSIT: &str = "DEPOSIT";

/// Outgoing funds to an external account. Decreases cash.
pub const ACTIVITY_TYPE_WITHDRAWAL: &str = "WITHDRAWAL";

/// Move cash or assets into this account. Asset cost basis is preserved.
/// Default: internal move (no net contribution).
/// Can be external: when from untracked world (metadata.flow.is_external=true).
/// Increases cash or quantity.
pub const ACTIVITY_TYPE_TRANSFER_IN: &str = "TRANSFER_IN";

/// Move cash or assets out of this account. Asset cost basis is exported.
/// Default: internal move (no net contribution).
/// Can be external: when to untracked world (metadata.flow.is_external=true).
/// Decreases cash or quantity.
pub const ACTIVITY_TYPE_TRANSFER_OUT: &str = "TRANSFER_OUT";

/// Stand-alone brokerage or platform fee not tied to a trade. Decreases cash.
pub const ACTIVITY_TYPE_FEE: &str = "FEE";

/// Tax paid from the account (e.g., withholding or realised CGT). Decreases cash.
pub const ACTIVITY_TYPE_TAX: &str = "TAX";

/// Stock split or reverse split. Adjusts quantity and per-share cost without affecting total value.
pub const ACTIVITY_TYPE_SPLIT: &str = "SPLIT";

/// Cash-only credit: refunds, rebates, bonuses.
/// Default: does NOT affect net_contribution unless metadata.flow.is_external=true.
pub const ACTIVITY_TYPE_CREDIT: &str = "CREDIT";

/// Non-trade correction / transformation (usually no cash).
/// Examples: option expire worthless, RoC basis adjustment, merger/spinoff compiler input.
pub const ACTIVITY_TYPE_ADJUSTMENT: &str = "ADJUSTMENT";

/// Unknown or unmapped activity type. Requires user review.
pub const ACTIVITY_TYPE_UNKNOWN: &str = "UNKNOWN";

/// Trading activity types
pub const TRADING_ACTIVITY_TYPES: [&str; 3] =
    [ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT];

/// Income activity types
pub const INCOME_ACTIVITY_TYPES: [&str; 2] = [ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_INTEREST];

/// Activity types where `unit_price` represents the asset's per-unit market
/// price and can be used as a fallback quote. Income activities (DIVIDEND,
/// INTEREST) store payment amounts, not asset prices. Securities transfers
/// store book cost basis in `unit_price`; valuation derives transfer market
/// value from quotes instead.
pub const PRICE_BEARING_ACTIVITY_TYPES: [&str; 2] = [ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_SELL];

/// Activity types that always require a symbol/asset.
/// Everything else: symbol is optional (cash-only or dual-use like TRANSFER_IN).
/// Note: DIVIDEND and ADJUSTMENT are handled separately in classify_import_activity (symbol optional during import).
pub const SYMBOL_REQUIRED_TYPES: [&str; 5] = [
    ACTIVITY_TYPE_BUY,
    ACTIVITY_TYPE_SELL,
    ACTIVITY_TYPE_SPLIT,
    ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_ADJUSTMENT,
];

/// Returns true when the activity type always requires a symbol/asset.
pub fn requires_symbol(activity_type: &str) -> bool {
    SYMBOL_REQUIRED_TYPES.contains(&activity_type)
}

/// Recognizes cash-placeholder symbols from broker exports (e.g. `$CASH-CAD`, `CASH:USD`).
pub fn is_cash_symbol(symbol: &str) -> bool {
    let s = symbol.trim();
    if s.is_empty() {
        return false;
    }
    // $CASH-XXX, $CASH_XXX, CASH-XXX, CASH_XXX, CASH:XXX (case-insensitive)
    let upper = s.to_uppercase();
    let stripped = upper.strip_prefix('$').unwrap_or(&upper);
    if let Some(rest) = stripped.strip_prefix("CASH") {
        if let Some(currency) = rest
            .strip_prefix('-')
            .or_else(|| rest.strip_prefix('_'))
            .or_else(|| rest.strip_prefix(':'))
        {
            return currency.len() == 3 && currency.chars().all(|c| c.is_ascii_alphabetic());
        }
    }
    false
}

/// Returns true for symbols that are clearly not real tickers (all dashes, `$`-prefixed junk, etc.).
pub fn is_garbage_symbol(symbol: &str) -> bool {
    let s = symbol.trim();
    if s.is_empty() {
        return false;
    }
    // All-dash: "----", "--"
    if s.chars().all(|c| c == '-') {
        return true;
    }
    // $-prefixed that isn't a recognized cash pattern: "$FOO", "$123"
    if s.starts_with('$') && !is_cash_symbol(s) {
        return true;
    }
    false
}

// ─────────────────────────────────────────────────────────────────────────────
// Import classification
// ─────────────────────────────────────────────────────────────────────────────

/// Activity types that are always pure cash — they never reference an asset.
pub const NEVER_ASSET_TYPES: [&str; 5] = [
    ACTIVITY_TYPE_DEPOSIT,
    ACTIVITY_TYPE_WITHDRAWAL,
    ACTIVITY_TYPE_FEE,
    ACTIVITY_TYPE_TAX,
    ACTIVITY_TYPE_CREDIT,
];

/// Dual-use transfer types — can be cash or asset depending on instance data.
const TRANSFER_TYPES: [&str; 2] = [ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT];

/// How an imported activity relates to an asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportSymbolDisposition {
    /// Symbol refers to a real asset → resolve via market data / local assets.
    ResolveAsset,
    /// Pure cash movement → clear symbol, no asset needed.
    CashMovement,
    /// Ambiguous — flag for user review with an explanation.
    NeedsReview(String),
}

/// Classifies an activity instance during import to decide how its symbol should be handled.
///
/// Decision tree:
/// 1. DIVIDEND with symbol → ResolveAsset; DIVIDEND without symbol → CashMovement (portfolio-level income)
///    1b. ADJUSTMENT with symbol → ResolveAsset; ADJUSTMENT without symbol → CashMovement (cash correction)
/// 2. Symbol-required type (BUY/SELL/SPLIT) → always ResolveAsset
/// 3. Empty / cash-placeholder / garbage symbol → CashMovement
/// 4. Never-asset type (DEPOSIT/WITHDRAWAL/FEE/TAX/CREDIT) → CashMovement (clear junk)
/// 5. Transfer type (TRANSFER_IN/OUT) with real symbol + qty or price → ResolveAsset
/// 6. Transfer type with real symbol but no qty AND no price → NeedsReview
/// 7. Everything else (INTEREST, UNKNOWN, …) with real symbol → ResolveAsset
pub fn classify_import_activity(
    activity_type: &str,
    symbol: &str,
    quantity: Option<rust_decimal::Decimal>,
    unit_price: Option<rust_decimal::Decimal>,
) -> ImportSymbolDisposition {
    let sym = symbol.trim();

    // 1. DIVIDEND: optional symbol — resolve asset if provided, cash income if not
    if activity_type == ACTIVITY_TYPE_DIVIDEND {
        if sym.is_empty() || is_cash_symbol(sym) || is_garbage_symbol(sym) {
            return ImportSymbolDisposition::CashMovement;
        }
        return ImportSymbolDisposition::ResolveAsset;
    }

    // 1b. ADJUSTMENT: optional symbol — resolve asset if provided, cash correction if not
    if activity_type == ACTIVITY_TYPE_ADJUSTMENT {
        if sym.is_empty() || is_cash_symbol(sym) || is_garbage_symbol(sym) {
            return ImportSymbolDisposition::CashMovement;
        }
        return ImportSymbolDisposition::ResolveAsset;
    }

    // 2. Symbol-required types always need resolution (errors caught downstream)
    if requires_symbol(activity_type) {
        return ImportSymbolDisposition::ResolveAsset;
    }

    // 2. No meaningful symbol → cash
    if sym.is_empty() || is_cash_symbol(sym) || is_garbage_symbol(sym) {
        return ImportSymbolDisposition::CashMovement;
    }

    // 3. Never-asset types with a real-looking symbol → still cash (clear junk)
    if NEVER_ASSET_TYPES.contains(&activity_type) {
        return ImportSymbolDisposition::CashMovement;
    }

    // 4–5. Transfer types: disambiguate via qty/price
    if TRANSFER_TYPES.contains(&activity_type) {
        let has_qty = quantity.is_some_and(|q| !q.is_zero());
        let has_price = unit_price.is_some_and(|p| !p.is_zero());
        if has_qty || has_price {
            return ImportSymbolDisposition::ResolveAsset;
        }
        return ImportSymbolDisposition::NeedsReview(format!(
            "Symbol '{}' on {} with no quantity or price. \
             Remove the symbol for a cash transfer, or add quantity for an asset transfer.",
            sym, activity_type,
        ));
    }

    // 6. INTEREST with symbol → bond/instrument interest; UNKNOWN → best-effort resolve
    ImportSymbolDisposition::ResolveAsset
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Subtypes
// ─────────────────────────────────────────────────────────────────────────────
// Subtypes provide semantic variations of activity types without schema changes.
// The compiler expands these into canonical activity type postings.

/// DRIP (Dividend Reinvestment Plan): Dividend automatically reinvested in shares.
/// Expands to: DIVIDEND + BUY
pub const ACTIVITY_SUBTYPE_DRIP: &str = "DRIP";

/// Staking Reward: Crypto staking income received as tokens.
/// Expands to: INTEREST + BUY
pub const ACTIVITY_SUBTYPE_STAKING_REWARD: &str = "STAKING_REWARD";

/// Dividend in Kind: Dividend paid as additional units of the same asset.
/// Expands to: DIVIDEND + BUY
pub const ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND: &str = "DIVIDEND_IN_KIND";

/// Bonus: External cash credit (new capital entering portfolio).
/// Affects net_contribution (like DEPOSIT) and is an external flow for TWR.
/// Examples: sign-up bonus, referral bonus, promotional credit.
pub const ACTIVITY_SUBTYPE_BONUS: &str = "BONUS";

/// Rebate: Trading rebate (negative fee, internal flow).
/// Does NOT affect net_contribution - represents reduced trading costs.
/// Examples: maker rebate, volume rebate.
pub const ACTIVITY_SUBTYPE_REBATE: &str = "REBATE";

/// Refund: Fee correction/reversal (internal flow).
/// Does NOT affect net_contribution - represents a fee that was reversed.
/// Examples: erroneous fee refund, service credit.
pub const ACTIVITY_SUBTYPE_REFUND: &str = "REFUND";

/// Reimbursement: External cash credit that offsets an expense category.
/// Used by spending/budgeting to reduce actuals without treating the money as income.
/// Examples: friend reimburses dinner, employer pays back a travel expense.
pub const ACTIVITY_SUBTYPE_REIMBURSEMENT: &str = "REIMBURSEMENT";

/// Option expiry: option contract expired worthless.
/// Removes lots via FIFO with no cash effect.
pub const ACTIVITY_SUBTYPE_OPTION_EXPIRY: &str = "OPTION_EXPIRY";

/// Position-opening trade intent.
/// Examples: buy-to-open for long options, sell-to-open for short options.
pub const ACTIVITY_SUBTYPE_POSITION_OPEN: &str = "POSITION_OPEN";

/// Position-closing trade intent.
/// Examples: sell-to-close for long options, buy-to-close for short options.
pub const ACTIVITY_SUBTYPE_POSITION_CLOSE: &str = "POSITION_CLOSE";

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    // helper: shorthand for classify
    fn classify(
        ty: &str,
        sym: &str,
        qty: Option<rust_decimal::Decimal>,
        price: Option<rust_decimal::Decimal>,
    ) -> ImportSymbolDisposition {
        classify_import_activity(ty, sym, qty, price)
    }

    fn is_cash(d: &ImportSymbolDisposition) -> bool {
        *d == ImportSymbolDisposition::CashMovement
    }
    fn is_resolve(d: &ImportSymbolDisposition) -> bool {
        *d == ImportSymbolDisposition::ResolveAsset
    }
    fn is_review(d: &ImportSymbolDisposition) -> bool {
        matches!(d, ImportSymbolDisposition::NeedsReview(_))
    }

    // ── requires_symbol ─────────────────────────────────────────────────

    #[test]
    fn test_requires_symbol_true_for_symbol_types() {
        assert!(requires_symbol(ACTIVITY_TYPE_BUY));
        assert!(requires_symbol(ACTIVITY_TYPE_SELL));
        assert!(requires_symbol(ACTIVITY_TYPE_SPLIT));
        assert!(requires_symbol(ACTIVITY_TYPE_DIVIDEND));
        assert!(requires_symbol(ACTIVITY_TYPE_ADJUSTMENT));
    }

    #[test]
    fn test_requires_symbol_false_for_optional_types() {
        assert!(!requires_symbol(ACTIVITY_TYPE_DEPOSIT));
        assert!(!requires_symbol(ACTIVITY_TYPE_WITHDRAWAL));
        assert!(!requires_symbol(ACTIVITY_TYPE_INTEREST));
        assert!(!requires_symbol(ACTIVITY_TYPE_TRANSFER_IN));
        assert!(!requires_symbol(ACTIVITY_TYPE_TRANSFER_OUT));
        assert!(!requires_symbol(ACTIVITY_TYPE_TAX));
        assert!(!requires_symbol(ACTIVITY_TYPE_FEE));
        assert!(!requires_symbol(ACTIVITY_TYPE_CREDIT));
        assert!(!requires_symbol(ACTIVITY_TYPE_UNKNOWN));
        assert!(!requires_symbol("INVALID"));
        assert!(!requires_symbol(""));
    }

    #[test]
    fn test_price_bearing_types_exclude_transfers() {
        assert!(PRICE_BEARING_ACTIVITY_TYPES.contains(&ACTIVITY_TYPE_BUY));
        assert!(PRICE_BEARING_ACTIVITY_TYPES.contains(&ACTIVITY_TYPE_SELL));
        assert!(!PRICE_BEARING_ACTIVITY_TYPES.contains(&ACTIVITY_TYPE_TRANSFER_IN));
        assert!(!PRICE_BEARING_ACTIVITY_TYPES.contains(&ACTIVITY_TYPE_TRANSFER_OUT));
    }

    // ── is_cash_symbol ──────────────────────────────────────────────────

    #[test]
    fn test_is_cash_symbol_valid_patterns() {
        assert!(is_cash_symbol("$CASH-CAD"));
        assert!(is_cash_symbol("$CASH-USD"));
        assert!(is_cash_symbol("$CASH-EUR"));
        assert!(is_cash_symbol("CASH:USD"));
        assert!(is_cash_symbol("CASH:GBP"));
        assert!(is_cash_symbol("CASH-EUR"));
        assert!(is_cash_symbol("CASH_GBP"));
        assert!(is_cash_symbol("$cash-cad"));
        assert!(is_cash_symbol("Cash:usd"));
        assert!(is_cash_symbol("  $CASH-CAD  "));
    }

    #[test]
    fn test_is_cash_symbol_rejects_invalid() {
        assert!(!is_cash_symbol(""));
        assert!(!is_cash_symbol("   "));
        assert!(!is_cash_symbol("AAPL"));
        assert!(!is_cash_symbol("$CASH"));
        assert!(!is_cash_symbol("CASH"));
        assert!(!is_cash_symbol("$CASH-TOOLONG"));
        assert!(!is_cash_symbol("$CASH-12"));
        assert!(!is_cash_symbol("$CASH-A"));
        assert!(!is_cash_symbol("$CASH-AB"));
        assert!(!is_cash_symbol("$CASH-"));
        assert!(!is_cash_symbol("$CASHX-USD"));
        assert!(!is_cash_symbol("XCASH-USD"));
        assert!(!is_cash_symbol("----"));
        assert!(!is_cash_symbol("$FOO"));
        assert!(!is_cash_symbol("BTC-USD"));
    }

    // ── is_garbage_symbol ───────────────────────────────────────────────

    #[test]
    fn test_is_garbage_symbol() {
        assert!(is_garbage_symbol("----"));
        assert!(is_garbage_symbol("--"));
        assert!(is_garbage_symbol("-"));
        assert!(is_garbage_symbol("$FOO"));
        assert!(is_garbage_symbol("$123"));
        assert!(is_garbage_symbol("$"));
        assert!(is_garbage_symbol("$AAPL"));

        assert!(!is_garbage_symbol(""));
        assert!(!is_garbage_symbol("AAPL"));
        assert!(!is_garbage_symbol("BTC-USD"));
        assert!(!is_garbage_symbol("GOOG.TO"));
        assert!(!is_garbage_symbol("$CASH-CAD"));
        assert!(!is_garbage_symbol("$CASH-USD"));
        assert!(!is_garbage_symbol("CASH:EUR"));
    }

    // ── classify_import_activity ────────────────────────────────────────

    // -- Symbol-required types: always ResolveAsset regardless of symbol content

    #[test]
    fn test_classify_buy_always_resolve() {
        assert!(is_resolve(&classify(
            "BUY",
            "AAPL",
            Some(dec!(10)),
            Some(dec!(150))
        )));
        assert!(is_resolve(&classify("BUY", "", None, None)));
        assert!(is_resolve(&classify("BUY", "$CASH-CAD", None, None)));
        assert!(is_resolve(&classify("BUY", "----", None, None)));
    }

    #[test]
    fn test_classify_sell_always_resolve() {
        assert!(is_resolve(&classify(
            "SELL",
            "AAPL",
            Some(dec!(5)),
            Some(dec!(200))
        )));
        assert!(is_resolve(&classify("SELL", "", None, None)));
        assert!(is_resolve(&classify("SELL", "----", None, None)));
    }

    #[test]
    fn test_classify_split_always_resolve() {
        assert!(is_resolve(&classify("SPLIT", "AAPL", None, None)));
        assert!(is_resolve(&classify("SPLIT", "", None, None)));
    }

    #[test]
    fn test_classify_dividend_optional_symbol() {
        assert!(is_resolve(&classify("DIVIDEND", "AAPL", None, None)));
        // No symbol → cash income (portfolio-level dividend)
        assert!(is_cash(&classify("DIVIDEND", "", None, None)));
        assert!(is_cash(&classify("DIVIDEND", "$CASH-CAD", None, None)));
    }

    #[test]
    fn test_classify_adjustment_optional_symbol() {
        assert!(is_resolve(&classify(
            "ADJUSTMENT",
            "AAPL",
            Some(dec!(1)),
            None
        )));
        // No symbol → cash correction
        assert!(is_cash(&classify("ADJUSTMENT", "", None, None)));
        assert!(is_cash(&classify("ADJUSTMENT", "$CASH-CAD", None, None)));
        assert!(is_cash(&classify("ADJUSTMENT", "----", None, None)));
    }

    // -- Never-asset types: always CashMovement (even with real-looking symbols)

    #[test]
    fn test_classify_deposit_always_cash() {
        assert!(is_cash(&classify("DEPOSIT", "", None, None)));
        assert!(is_cash(&classify("DEPOSIT", "$CASH-CAD", None, None)));
        assert!(is_cash(&classify("DEPOSIT", "CASH:USD", None, None)));
        assert!(is_cash(&classify("DEPOSIT", "----", None, None)));
        assert!(is_cash(&classify("DEPOSIT", "$FOO", None, None)));
        // Even a real-looking symbol → cash (deposits never have assets)
        assert!(is_cash(&classify("DEPOSIT", "AAPL", None, None)));
        assert!(is_cash(&classify(
            "DEPOSIT",
            "AAPL",
            Some(dec!(100)),
            Some(dec!(50))
        )));
    }

    #[test]
    fn test_classify_withdrawal_always_cash() {
        assert!(is_cash(&classify("WITHDRAWAL", "", None, None)));
        assert!(is_cash(&classify("WITHDRAWAL", "$CASH-EUR", None, None)));
        assert!(is_cash(&classify("WITHDRAWAL", "----", None, None)));
        assert!(is_cash(&classify("WITHDRAWAL", "AAPL", None, None)));
    }

    #[test]
    fn test_classify_fee_always_cash() {
        assert!(is_cash(&classify("FEE", "", None, None)));
        assert!(is_cash(&classify("FEE", "$CASH-CAD", None, None)));
        assert!(is_cash(&classify("FEE", "----", None, None)));
        assert!(is_cash(&classify("FEE", "AAPL", None, None)));
    }

    #[test]
    fn test_classify_tax_always_cash() {
        assert!(is_cash(&classify("TAX", "", None, None)));
        assert!(is_cash(&classify("TAX", "CASH-USD", None, None)));
        assert!(is_cash(&classify("TAX", "----", None, None)));
        assert!(is_cash(&classify("TAX", "AAPL", None, None)));
    }

    #[test]
    fn test_classify_credit_always_cash() {
        assert!(is_cash(&classify("CREDIT", "", None, None)));
        assert!(is_cash(&classify("CREDIT", "$CASH-GBP", None, None)));
        assert!(is_cash(&classify("CREDIT", "----", None, None)));
        assert!(is_cash(&classify("CREDIT", "AAPL", None, None)));
    }

    // -- Dual-use transfers: disambiguated by symbol + qty/price

    #[test]
    fn test_classify_transfer_in_cash_signals() {
        // Empty / cash / garbage → CashMovement
        assert!(is_cash(&classify("TRANSFER_IN", "", None, None)));
        assert!(is_cash(&classify("TRANSFER_IN", "$CASH-CAD", None, None)));
        assert!(is_cash(&classify("TRANSFER_IN", "CASH:USD", None, None)));
        assert!(is_cash(&classify("TRANSFER_IN", "----", None, None)));
        assert!(is_cash(&classify("TRANSFER_IN", "$FOO", None, None)));
        assert!(is_cash(&classify("TRANSFER_IN", "  ", None, None)));
    }

    #[test]
    fn test_classify_transfer_in_asset_signals() {
        // Real symbol + quantity → ResolveAsset
        assert!(is_resolve(&classify(
            "TRANSFER_IN",
            "AAPL",
            Some(dec!(100)),
            None
        )));
        // Real symbol + price → ResolveAsset
        assert!(is_resolve(&classify(
            "TRANSFER_IN",
            "AAPL",
            None,
            Some(dec!(150))
        )));
        // Real symbol + both → ResolveAsset
        assert!(is_resolve(&classify(
            "TRANSFER_IN",
            "BTC-USD",
            Some(dec!(2)),
            Some(dec!(50000))
        )));
        assert!(is_resolve(&classify(
            "TRANSFER_IN",
            "GOOG.TO",
            Some(dec!(50)),
            Some(dec!(0))
        )));
    }

    #[test]
    fn test_classify_transfer_in_ambiguous() {
        // Real symbol but no qty AND no price → NeedsReview
        assert!(is_review(&classify("TRANSFER_IN", "AAPL", None, None)));
        assert!(is_review(&classify(
            "TRANSFER_IN",
            "GOOG",
            Some(dec!(0)),
            None
        )));
        assert!(is_review(&classify(
            "TRANSFER_IN",
            "MSFT",
            None,
            Some(dec!(0))
        )));
        assert!(is_review(&classify(
            "TRANSFER_IN",
            "TSLA",
            Some(dec!(0)),
            Some(dec!(0))
        )));
    }

    #[test]
    fn test_classify_transfer_out_cash_signals() {
        assert!(is_cash(&classify("TRANSFER_OUT", "", None, None)));
        assert!(is_cash(&classify("TRANSFER_OUT", "$CASH-CAD", None, None)));
        assert!(is_cash(&classify("TRANSFER_OUT", "----", None, None)));
    }

    #[test]
    fn test_classify_transfer_out_asset_signals() {
        assert!(is_resolve(&classify(
            "TRANSFER_OUT",
            "AAPL",
            Some(dec!(50)),
            None
        )));
        assert!(is_resolve(&classify(
            "TRANSFER_OUT",
            "GOOG.TO",
            Some(dec!(10)),
            Some(dec!(100))
        )));
    }

    #[test]
    fn test_classify_transfer_out_ambiguous() {
        assert!(is_review(&classify("TRANSFER_OUT", "AAPL", None, None)));
        assert!(is_review(&classify(
            "TRANSFER_OUT",
            "MSFT",
            Some(dec!(0)),
            Some(dec!(0))
        )));
    }

    // -- INTEREST: symbol-means-asset (bond interest, staking, etc.)

    #[test]
    fn test_classify_interest_cash_signals() {
        // No symbol / cash / garbage → CashMovement
        assert!(is_cash(&classify("INTEREST", "", None, None)));
        assert!(is_cash(&classify("INTEREST", "$CASH-EUR", None, None)));
        assert!(is_cash(&classify("INTEREST", "----", None, None)));
    }

    #[test]
    fn test_classify_interest_with_symbol() {
        // Real symbol → always ResolveAsset (interest from instrument)
        // No qty/price needed — bond interest is just an amount
        assert!(is_resolve(&classify("INTEREST", "BOND-XYZ", None, None)));
        assert!(is_resolve(&classify("INTEREST", "AAPL", None, None)));
        assert!(is_resolve(&classify(
            "INTEREST",
            "BTC-USD",
            Some(dec!(1)),
            None
        )));
    }

    // -- UNKNOWN type

    #[test]
    fn test_classify_unknown_cash_signals() {
        assert!(is_cash(&classify("UNKNOWN", "", None, None)));
        assert!(is_cash(&classify("UNKNOWN", "----", None, None)));
        assert!(is_cash(&classify("UNKNOWN", "$CASH-CAD", None, None)));
    }

    #[test]
    fn test_classify_unknown_with_symbol() {
        // Real symbol → best-effort resolve
        assert!(is_resolve(&classify("UNKNOWN", "AAPL", None, None)));
    }

    // -- Whitespace edge cases

    #[test]
    fn test_classify_whitespace_edge_cases() {
        assert!(is_cash(&classify("DEPOSIT", "   ", None, None)));
        assert!(is_cash(&classify("DEPOSIT", "  $CASH-CAD  ", None, None)));
        assert!(is_cash(&classify("TRANSFER_IN", "  ----  ", None, None)));
        assert!(is_resolve(&classify(
            "TRANSFER_IN",
            "  AAPL  ",
            Some(dec!(10)),
            None
        )));
    }
}
