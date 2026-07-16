use crate::assets::Asset;

/// Central policy for assets that may carry negative lots.
///
/// Options can use signed lots directly. Stock/ETF-style assets may also carry
/// signed lots, but only when the activity has explicit short intent.
pub struct ShortabilityPolicy;

impl ShortabilityPolicy {
    pub fn allows_negative_lots(asset: &Asset) -> bool {
        asset.is_option() || asset.is_equity_like()
    }

    pub fn requires_explicit_short_intent(asset: &Asset) -> bool {
        asset.is_equity_like()
    }
}
