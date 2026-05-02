use chrono::{DateTime, Utc};
use log::{debug, error, warn};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::default::Default;

use crate::activities::Activity;

use crate::constants::QUANTITY_THRESHOLD;

use crate::errors::{CalculatorError, Result};

// Helper function from previous examples
pub fn is_quantity_significant(quantity: &Decimal) -> bool {
    let threshold =
        Decimal::from_str_radix(QUANTITY_THRESHOLD, 10).unwrap_or_else(|_| Decimal::new(1, 8));
    quantity.abs() >= threshold
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    pub account_id: String,
    pub asset_id: String,
    pub quantity: Decimal,
    /// Average cost per unit in the asset's currency.
    pub average_cost: Decimal,
    /// Total cost basis of all lots in the asset's currency.
    pub total_cost_basis: Decimal,
    /// The currency of the asset and the cost basis values (e.g., "USD", "EUR"). Set by the first acquisition activity.
    pub currency: String,
    pub inception_date: DateTime<Utc>,
    #[serde(default)]
    pub lots: VecDeque<Lot>,
    pub created_at: DateTime<Utc>,
    pub last_updated: DateTime<Utc>,
    /// Flag indicating if this position is an alternative asset (Property, Vehicle, Collectible, etc.).
    /// Alternative assets are excluded from TWR/IRR performance calculations.
    #[serde(default)]
    pub is_alternative: bool,
    /// Contract multiplier for derivatives (e.g., 100 for equity options).
    /// Defaults to 1 for non-derivative positions and for snapshots created before this field existed.
    #[serde(default = "default_multiplier")]
    pub contract_multiplier: Decimal,
}

fn default_multiplier() -> Decimal {
    Decimal::ONE
}

impl Default for Position {
    fn default() -> Self {
        Position {
            id: String::new(),
            account_id: String::new(),
            asset_id: String::new(),
            quantity: Decimal::ZERO,
            average_cost: Decimal::ZERO,
            total_cost_basis: Decimal::ZERO,
            currency: String::new(), // Initialized as empty, set by first lot
            inception_date: Utc::now(),
            lots: VecDeque::new(),
            created_at: Utc::now(),
            last_updated: Utc::now(),
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lot {
    pub id: String,
    pub position_id: String,
    pub acquisition_date: DateTime<Utc>,
    pub quantity: Decimal,
    /// The quantity when the lot was first created. Never modified by sells or
    /// splits. Used as the anchor for historical as-of queries (replay reducing
    /// activities forward from this value). Defaults to zero when deserializing
    /// old snapshots that predate this field; callers should fall back to
    /// `quantity` when `original_quantity` is zero.
    #[serde(default)]
    pub original_quantity: Decimal,
    /// Represents the total amount paid for the entire lot in the Position's currency, including any fees or commissions if applicable (e.g., for Buy).
    pub cost_basis: Decimal,
    /// Represents the price per share/unit in the Position's currency at the time of purchase.
    pub acquisition_price: Decimal,
    /// Represents fees paid in the Position's currency associated with the acquisition.
    pub acquisition_fees: Decimal,
    /// FX rate used to convert from activity currency to position currency.
    /// Stored for audit trail when cross-currency purchases occur.
    /// None when activity currency matches position currency.
    pub fx_rate_to_position: Option<Decimal>,
    /// The activity that opened this lot, if it corresponds to a real
    /// activity row. Used to populate `LotRecord.open_activity_id` when the
    /// lot is persisted, which then drives the FK CASCADE that removes the
    /// lot row when its activity is deleted.
    ///
    /// Set to `Some(activity.id)` for normal BUY lots (`add_lot`) and for
    /// transferred sub-lots whose ID is the TRANSFER_IN activity. Left
    /// `None` for HOLDINGS-mode lots (no underlying activity) and for
    /// composite-id transfer sub-lots whose ID does not directly correspond
    /// to an activity row in this account.
    ///
    /// `#[serde(default)]` keeps backward compatibility with snapshots
    /// serialized to JSON before this field existed; old snapshots
    /// deserialize as `None`.
    #[serde(default)]
    pub source_activity_id: Option<String>,
    /// Cumulative product of post-acquisition SPLIT activity ratios for this lot.
    /// Defaults to 1.0 (no splits since acquisition). Updated only by SPLIT
    /// processing; never touched by BUY/SELL. Effective shares held now =
    /// `quantity * split_ratio`. Adjusted price per current share =
    /// `acquisition_price / split_ratio`. See docs/architecture/data_model.md §3.5.
    ///
    /// `#[serde(default)]` defaults old snapshots to zero on deserialize; callers
    /// must treat zero as "absent → 1.0" for backward compatibility.
    #[serde(default = "Lot::default_split_ratio")]
    pub split_ratio: Decimal,
}

impl Lot {
    /// Default value for `split_ratio` (1.0 = no splits since acquisition).
    /// Used by serde default to keep deserialization of old snapshots safe.
    fn default_split_ratio() -> Decimal {
        Decimal::ONE
    }

    /// Returns the lot's `split_ratio`, falling back to ONE if it deserializes
    /// as zero from a pre-split-ratio snapshot.
    pub fn effective_split_ratio(&self) -> Decimal {
        if self.split_ratio.is_zero() {
            Decimal::ONE
        } else {
            self.split_ratio
        }
    }

    /// Effective share count held now (in current/post-split units).
    pub fn effective_quantity(&self) -> Decimal {
        self.quantity * self.effective_split_ratio()
    }
}

/// Result of a FIFO lot reduction, containing both aggregate values
/// and the individual lots that were removed (for transfer carry-over).
#[derive(Debug, Clone)]
pub struct FifoReductionResult {
    /// Total quantity actually reduced.
    pub quantity_reduced: Decimal,
    /// Total cost basis removed in the position's currency.
    pub cost_basis_removed: Decimal,
    /// The lots that were fully or partially removed, with their removed quantities.
    /// Each lot preserves the original acquisition date, price, and fee data.
    pub removed_lots: Vec<Lot>,
    /// IDs of lots that were fully consumed (remaining_quantity → 0) by this reduction.
    /// Used by the lot persistence layer to mark those rows as closed.
    pub fully_consumed_lot_ids: Vec<String>,
    /// Full snapshot of each fully consumed lot *before* it was removed from the
    /// VecDeque.  Needed so that `LotClosure` can carry enough data to INSERT
    /// the lot into the database if it was never written there (e.g. during a
    /// full recalc/replay where the lot was created and consumed in one pass).
    pub fully_consumed_lots: Vec<Lot>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CashHolding {
    pub id: String, // e.g., "CASH-USD-ACCT123"
    pub account_id: String,
    pub currency: String, // "USD", "EUR" - acts as asset_id for cash
    pub amount: Decimal,
    pub last_updated: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "holdingType", rename_all = "camelCase")]
pub enum Holding {
    // Represents anything held within an account
    Security(Position),
    Cash(CashHolding),
}

impl Position {
    // Simplified constructor
    pub fn new(
        account_id: String,
        asset_id: String,
        asset_currency: String,
        date: DateTime<Utc>,
    ) -> Self {
        Position {
            id: format!("POS-{}-{}", asset_id, account_id), // Example ID generation
            account_id,
            asset_id,
            quantity: Decimal::ZERO,
            average_cost: Decimal::ZERO,
            total_cost_basis: Decimal::ZERO,
            currency: asset_currency,
            inception_date: date,
            lots: VecDeque::new(),
            created_at: date,
            last_updated: date,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        }
    }

    // Constructor with alternative asset flag and contract multiplier
    pub fn new_with_alternative_flag(
        account_id: String,
        asset_id: String,
        asset_currency: String,
        date: DateTime<Utc>,
        is_alternative: bool,
        contract_multiplier: Decimal,
    ) -> Self {
        Position {
            id: format!("POS-{}-{}", asset_id, account_id),
            account_id,
            asset_id,
            quantity: Decimal::ZERO,
            average_cost: Decimal::ZERO,
            total_cost_basis: Decimal::ZERO,
            currency: asset_currency,
            inception_date: date,
            lots: VecDeque::new(),
            created_at: date,
            last_updated: date,
            is_alternative,
            contract_multiplier,
        }
    }

    /// Recalculates aggregates based on current lots. Operates in the Position's currency.
    pub fn recalculate_aggregates(&mut self) {
        // Position.quantity is effective (current, post-split) shares for use by
        // valuation: market_value = position.quantity * current_quote_price.
        // lot.quantity is in as-acquired units; effective = quantity * split_ratio.
        // Cost basis is split-invariant, summed from each lot's stored value.
        let total_quantity: Decimal = self
            .lots
            .iter()
            .map(|lot| lot.quantity * lot.effective_split_ratio())
            .sum();
        let total_cost_basis: Decimal = self.lots.iter().map(|lot| lot.cost_basis).sum();

        // Store unrounded aggregates internally
        self.quantity = total_quantity;
        self.total_cost_basis = total_cost_basis; // Already in asset currency

        if self.quantity.is_sign_positive() && is_quantity_significant(&self.quantity) {
            // Calculate average cost (in asset currency) using unrounded values
            self.average_cost = self.total_cost_basis / self.quantity;
        } else {
            // Zero, negative, or insignificant quantity
            if !self.quantity.is_zero() && !self.quantity.is_sign_negative() {
                warn!("Position {} quantity ({}) became insignificant after recalculation. Average cost zeroed.", self.id, self.quantity);
            }
            if (self.quantity.is_zero() || self.quantity.is_sign_negative())
                && !self.lots.is_empty()
            {
                warn!(
                    "Position {} quantity became zero or negative ({}). Aggregates zeroed, but lots retained.",
                    self.id, self.quantity
                );
            }
            self.quantity = Decimal::ZERO;
            self.total_cost_basis = Decimal::ZERO;
            self.average_cost = Decimal::ZERO;
        }

        // Update inception date if lots exist
        if let Some(first_lot) = self.lots.iter().min_by_key(|lot| lot.acquisition_date) {
            self.inception_date = first_lot.acquisition_date;
        }
        // Update last updated time
        self.last_updated = Utc::now();
    }

    /// Adds a new lot based on an acquisition activity.
    /// Costs are stored in the Position's currency (which must match activity currency).
    /// activity_id is used for the Lot ID.
    /// Returns the cost basis of the added lot in the position's currency.
    pub fn add_lot(&mut self, activity: &Activity) -> Result<Decimal> {
        let qty = activity.qty();
        if !qty.is_sign_positive() {
            warn!(
                "Skipping add_lot for activity {} with non-positive quantity: {}",
                activity.id, qty
            );
            // Return zero cost basis if skipped
            return Ok(Decimal::ZERO);
        }

        // --- Currency Check ---
        if self.currency.is_empty() {
            // First lot addition, set the position's currency
            debug!(
                "Setting position {} currency to {} based on first activity {}",
                self.id, activity.currency, activity.id
            );
            self.currency = activity.currency.clone();
        } else if self.currency != activity.currency {
            error!(
                "Currency mismatch for position {} ({}): Activity {} has currency {}. Requires currency conversion activity first.",
                self.id, self.currency, activity.id, activity.currency
            );
            return Err(CalculatorError::CurrencyMismatch {
                position_id: self.id.clone(),
                position_currency: self.currency.clone(),
                activity_id: activity.id.clone(),
                activity_currency: activity.currency.clone(),
            }
            .into());
        }

        // --- Cost Calculation (in Position/Activity Currency) ---
        let acquisition_price = activity.price();
        let quantity = activity.qty();
        let acquisition_fees = activity.fee_amt(); // Store the fee in activity currency

        // Cost basis ONLY includes fees for BUY activities
        let cost_basis = quantity * acquisition_price + acquisition_fees;

        let new_lot = Lot {
            id: activity.id.clone(), // Use activity ID as Lot ID
            position_id: self.id.clone(),
            acquisition_date: activity.activity_date,
            quantity,
            original_quantity: quantity,
            cost_basis,                // Store unrounded in position currency
            acquisition_price,         // Store unrounded in position currency
            acquisition_fees,          // Store unrounded in position currency
            fx_rate_to_position: None, // No currency conversion in this method
            // BUY lot: source activity is the activity itself.
            source_activity_id: Some(activity.id.clone()),
            split_ratio: Decimal::ONE,
        };

        self.lots.push_back(new_lot);
        // Convert to Vec, sort, convert back to VecDeque
        let mut vec_lots: Vec<_> = self.lots.drain(..).collect();
        vec_lots.sort_by_key(|lot| lot.acquisition_date);
        self.lots = vec_lots.into();

        self.recalculate_aggregates();
        // Return the calculated cost basis (in position currency)
        Ok(cost_basis)
    }

    /// Adds a new lot from pre-converted values (avoids Activity clone).
    /// This is the preferred method when the caller has already converted
    /// unit_price and fee to the position's currency.
    ///
    /// # Arguments
    /// * `lot_id` - Unique identifier for the lot (typically activity ID)
    /// * `quantity` - Number of units to add (must be positive)
    /// * `unit_price` - Price per unit, already in position currency
    /// * `fee` - Transaction fee, already in position currency
    /// * `acquisition_date` - When the position was acquired
    /// * `fx_rate_used` - FX rate used for conversion (None if same currency)
    /// * `source_activity_id` - The activity that opened this lot, used to
    ///   populate `LotRecord.open_activity_id` so the FK CASCADE removes the
    ///   lot when its activity is deleted. Pass `Some(activity.id)` for
    ///   normal BUYs; pass `None` for synthetic lots that don't correspond
    ///   to an activity row in this account.
    ///
    /// # Returns
    /// The cost basis of the added lot in the position's currency.
    #[allow(clippy::too_many_arguments)]
    pub fn add_lot_values(
        &mut self,
        lot_id: String,
        quantity: Decimal,
        unit_price: Decimal,
        fee: Decimal,
        acquisition_date: DateTime<Utc>,
        fx_rate_used: Option<Decimal>,
        source_activity_id: Option<String>,
    ) -> Result<Decimal> {
        if !quantity.is_sign_positive() {
            warn!(
                "Skipping add_lot_values for lot {} with non-positive quantity: {}",
                lot_id, quantity
            );
            return Ok(Decimal::ZERO);
        }

        // Set currency if this is the first lot
        if self.currency.is_empty() {
            debug!(
                "Position {} has empty currency on first add_lot_values. This should have been set by caller.",
                self.id
            );
        }

        let cost_basis = quantity * unit_price + fee;

        let new_lot = Lot {
            id: lot_id,
            position_id: self.id.clone(),
            acquisition_date,
            quantity,
            original_quantity: quantity,
            cost_basis,
            acquisition_price: unit_price,
            acquisition_fees: fee,
            fx_rate_to_position: fx_rate_used,
            source_activity_id,
            split_ratio: Decimal::ONE,
        };

        self.lots.push_back(new_lot);

        // Sort by acquisition_date
        let mut vec_lots: Vec<_> = self.lots.drain(..).collect();
        vec_lots.sort_by_key(|lot| lot.acquisition_date);
        self.lots = vec_lots.into();

        self.recalculate_aggregates();
        Ok(cost_basis)
    }

    /// Adds transferred lots to this position, preserving original acquisition dates and prices.
    /// Used for internal transfers where lots carry over from the source account.
    ///
    /// If the position has no currency set, it will be inferred from the first lot's fx context.
    /// Lots are re-keyed with a new lot_id (the TRANSFER_IN activity ID) but retain original
    /// acquisition dates and cost basis. When currencies differ, prices are converted using
    /// the provided fx_rate.
    ///
    /// Returns the total cost basis added in the position's currency.
    pub fn add_transferred_lots(
        &mut self,
        lot_id_prefix: &str,
        lots: &[Lot],
        fx_rate: Option<Decimal>,
    ) -> Result<Decimal> {
        let mut total_cost_basis_added = Decimal::ZERO;

        for (i, src_lot) in lots.iter().enumerate() {
            if !src_lot.quantity.is_sign_positive() {
                continue;
            }

            // Apply FX conversion if needed
            let (price, fee, cost_basis, rate_used) = if let Some(rate) = fx_rate {
                let p = src_lot.acquisition_price * rate;
                let f = src_lot.acquisition_fees * rate;
                let cb = src_lot.cost_basis * rate;
                (p, f, cb, Some(rate))
            } else {
                (
                    src_lot.acquisition_price,
                    src_lot.acquisition_fees,
                    src_lot.cost_basis,
                    src_lot.fx_rate_to_position,
                )
            };

            let new_lot = Lot {
                id: if lots.len() == 1 {
                    lot_id_prefix.to_string()
                } else {
                    format!("{}_lot{}", lot_id_prefix, i)
                },
                position_id: self.id.clone(),
                acquisition_date: src_lot.acquisition_date, // Preserve original date
                quantity: src_lot.quantity,
                original_quantity: src_lot.quantity,
                cost_basis,
                acquisition_price: price,
                acquisition_fees: fee,
                fx_rate_to_position: rate_used,
                // The TRANSFER_IN activity owns these sub-lots — deleting it
                // should cascade-remove them. `lot_id_prefix` is the
                // TRANSFER_IN activity id.
                source_activity_id: Some(lot_id_prefix.to_string()),
                // Carry the source lot's cumulative split factor — the receiving
                // account inherits the same as-acquired-vs-current ratio.
                split_ratio: src_lot.effective_split_ratio(),
            };

            total_cost_basis_added += new_lot.cost_basis;
            self.lots.push_back(new_lot);
        }

        // Sort by acquisition_date
        let mut vec_lots: Vec<_> = self.lots.drain(..).collect();
        vec_lots.sort_by_key(|lot| lot.acquisition_date);
        self.lots = vec_lots.into();

        self.recalculate_aggregates();
        Ok(total_cost_basis_added)
    }

    /// Reduces position quantity using FIFO lot relief.
    ///
    /// **Input units.** `quantity_to_reduce_input` is in **effective (current,
    /// post-split) units** — the units the broker reported in the SELL or
    /// TRANSFER_OUT activity. Each lot's `split_ratio` translates between
    /// effective units and the lot's stored as-acquired (`quantity`) units:
    ///   `effective_remaining = lot.quantity * lot.split_ratio`.
    ///
    /// The function consumes effective shares FIFO, converting back to
    /// as-acquired units when reducing each lot's `quantity`. Cost-basis
    /// proration is computed in as-acquired units (lot.cost_basis is split-
    /// invariant), so realized P&L matches the immutable acquisition basis.
    ///
    /// Returns a `FifoReductionResult` with `quantity_reduced` in effective
    /// units (matching the input), and `removed_lots` whose `quantity` is the
    /// as-acquired amount consumed. Each removed lot inherits the source lot's
    /// `split_ratio` so a paired TRANSFER_IN reconstructs the same effective
    /// position on the receiving account.
    pub fn reduce_lots_fifo(
        &mut self,
        quantity_to_reduce_input: Decimal,
    ) -> Result<FifoReductionResult> {
        if !quantity_to_reduce_input.is_sign_positive() {
            return Err(CalculatorError::InvalidActivity(
                "Quantity to reduce must be positive".to_string(),
            )
            .into());
        }

        // Sum lot effective remaining (in current units) for the available check.
        let available_effective: Decimal = self
            .lots
            .iter()
            .map(|lot| lot.quantity * lot.effective_split_ratio())
            .sum();

        if !is_quantity_significant(&available_effective) || available_effective <= Decimal::ZERO {
            warn!("Attempting to reduce position {} which has zero/insignificant effective quantity {}. Skipping reduction.", self.id, available_effective);
            return Ok(FifoReductionResult {
                quantity_reduced: Decimal::ZERO,
                cost_basis_removed: Decimal::ZERO,
                removed_lots: Vec::new(),
                fully_consumed_lot_ids: Vec::new(),
                fully_consumed_lots: Vec::new(),
            });
        }

        let mut quantity_to_reduce_effective = quantity_to_reduce_input;
        if available_effective < quantity_to_reduce_effective {
            warn!(
                "Reduce quantity {} exceeds available {} for position {}. Reducing by available amount.",
                quantity_to_reduce_effective, available_effective, self.id
            );
            quantity_to_reduce_effective = available_effective;
        }

        // Convert to Vec, sort, operate, convert back later
        let mut vec_lots: Vec<_> = self.lots.drain(..).collect();
        vec_lots.sort_by_key(|lot| lot.acquisition_date); // Ensure FIFO order

        let mut lot_indices_to_remove = Vec::new();
        let mut lot_updates = Vec::new(); // (index, new_quantity, new_cost_basis, new_fees)
        let mut actual_quantity_reduced_effective = Decimal::ZERO;
        // Cost basis sum will be in the Position's currency
        let mut cost_basis_of_sold_lots_asset_currency = Decimal::ZERO;
        // Track removed lots for transfer carry-over
        let mut removed_lots: Vec<Lot> = Vec::new();
        // Track fully consumed lot IDs for persistence (mark as closed)
        let mut fully_consumed_lot_ids: Vec<String> = Vec::new();
        // Full snapshots of consumed lots (before removal) for DB insertion
        let mut fully_consumed_lots: Vec<Lot> = Vec::new();

        // Iterate over the sorted Vec
        for (index, lot) in vec_lots.iter().enumerate() {
            if quantity_to_reduce_effective <= Decimal::ZERO {
                break;
            }
            if lot.quantity <= Decimal::ZERO {
                continue; // Skip empty or negative lots (shouldn't happen with proper add/split)
            }

            let lot_split_ratio = lot.effective_split_ratio();
            let lot_effective = lot.quantity * lot_split_ratio;
            if lot_effective <= Decimal::ZERO {
                continue;
            }

            // Consume in effective (current) units, then convert back to
            // as-acquired units for the lot bookkeeping.
            let consume_effective = std::cmp::min(lot_effective, quantity_to_reduce_effective);
            let qty_from_this_lot = if lot_split_ratio.is_zero() {
                consume_effective
            } else {
                consume_effective / lot_split_ratio
            };

            // Calculate cost basis removed (in asset currency) proportionally
            // in as-acquired terms (lot.cost_basis is split-invariant).
            let cost_basis_removed = if lot.quantity.is_zero() {
                Decimal::ZERO
            } else {
                lot.cost_basis * qty_from_this_lot / lot.quantity
            };

            // Calculate proportional fees removed
            let fees_removed = if lot.quantity.is_zero() {
                Decimal::ZERO
            } else {
                lot.acquisition_fees * qty_from_this_lot / lot.quantity
            };

            // Record the removed portion as a lot (preserving original acquisition data)
            // For transfer-out flows, the receiving account inherits the same split ratio
            // so its effective shares match what was sent.
            removed_lots.push(Lot {
                id: lot.id.clone(),
                position_id: lot.position_id.clone(),
                acquisition_date: lot.acquisition_date,
                quantity: qty_from_this_lot,
                original_quantity: qty_from_this_lot,
                cost_basis: cost_basis_removed,
                acquisition_price: lot.acquisition_price,
                acquisition_fees: fees_removed,
                fx_rate_to_position: lot.fx_rate_to_position,
                source_activity_id: lot.source_activity_id.clone(),
                split_ratio: lot_split_ratio,
            });

            actual_quantity_reduced_effective += consume_effective;
            cost_basis_of_sold_lots_asset_currency += cost_basis_removed;
            quantity_to_reduce_effective -= consume_effective;

            let remaining_lot_qty = lot.quantity - qty_from_this_lot;

            if remaining_lot_qty <= Decimal::ZERO || !is_quantity_significant(&remaining_lot_qty) {
                lot_indices_to_remove.push(index);
                fully_consumed_lot_ids.push(lot.id.clone());
                fully_consumed_lots.push(lot.clone());
            } else {
                // Calculate remaining cost basis and fees (asset currency)
                let remaining_lot_basis = lot.cost_basis - cost_basis_removed;
                let remaining_fees = lot.acquisition_fees - fees_removed;
                lot_updates.push((
                    index,
                    remaining_lot_qty,
                    remaining_lot_basis,
                    remaining_fees,
                ));
            }
        }

        // Apply updates to the Vec
        for (index, new_quantity, new_cost_basis, new_fees) in lot_updates {
            if let Some(lot) = vec_lots.get_mut(index) {
                lot.quantity = new_quantity;
                lot.cost_basis = new_cost_basis; // Update with asset currency value
                lot.acquisition_fees = new_fees;
            } else {
                error!(
                    "Failed to get mutable lot at index {} for position {} during update",
                    index, self.id
                );
            }
        }

        // Remove marked lots from the Vec efficiently
        let mut i = 0;
        vec_lots.retain(|_| {
            let keep = !lot_indices_to_remove.contains(&i);
            i += 1;
            keep
        });

        // Convert the final Vec back to VecDeque and assign to self.lots
        self.lots = vec_lots.into();

        // Debug: log remaining lots after FIFO reduction
        for lot in &self.lots {
            debug!(
                "[LOT-DEBUG] reduce_lots_fifo result: id={} asset={} quantity={} original_quantity={}",
                lot.id, self.asset_id, lot.quantity, lot.original_quantity
            );
        }

        self.recalculate_aggregates();

        Ok(FifoReductionResult {
            quantity_reduced: actual_quantity_reduced_effective,
            cost_basis_removed: cost_basis_of_sold_lots_asset_currency,
            removed_lots,
            fully_consumed_lot_ids,
            fully_consumed_lots,
        })
    }

    /// Applies a stock split by multiplying the cumulative `split_ratio` of every
    /// open lot opened **before** `split_date`. Lots opened on or after the split
    /// date are not affected (they were acquired in post-split units).
    ///
    /// Lot `quantity`, `acquisition_price`, `cost_basis`, and `acquisition_fees`
    /// are all immutable: splits never change the dollars paid or the as-acquired
    /// share count. Effective shares held now = `quantity * split_ratio`.
    /// Adjusted price per current share = `acquisition_price / split_ratio`.
    ///
    /// Reverse splits (ratio < 1) and non-integer forward splits (e.g. 3-for-2)
    /// can leave fractional shares; brokers liquidate the fractional and emit a
    /// SELL activity. The SELL handler converts current → as-acquired units via
    /// the lot's `split_ratio` at consumption time.
    pub fn apply_split(
        &mut self,
        split_ratio: Decimal,
        split_date: DateTime<Utc>,
        activity_id: &str,
    ) -> Result<()> {
        if !split_ratio.is_sign_positive() || split_ratio.is_zero() {
            return Err(CalculatorError::InvalidActivity(format!(
                "Split ratio must be positive, got {} for activity {}",
                split_ratio, activity_id
            ))
            .into());
        }
        debug!(
            "Applying split ratio {} to position {} for splits dated {}",
            split_ratio, self.id, split_date
        );
        for lot in self.lots.iter_mut() {
            if lot.acquisition_date < split_date {
                let prior = lot.effective_split_ratio();
                lot.split_ratio = prior * split_ratio;
            }
        }
        self.recalculate_aggregates();
        Ok(())
    }
}
