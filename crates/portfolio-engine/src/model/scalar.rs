//! Parse-don't-validate scalars. Constructed once in `normalize`; interior
//! stages never see raw strings.

/// Decimal places every stored amount keeps (legacy `DECIMAL_PRECISION`).
pub const STORED_PRECISION: u32 = 8;

use std::fmt;

use serde::{Deserialize, Serialize};

/// Opaque validated currency code: non-empty, trimmed, case-preserved (the
/// minor-unit table is case-sensitive for `GBp`). A bucket key and FX-pair
/// component; it does NOT know minor-unit relations — that is policy data.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Currency(String);

impl Currency {
    pub fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(id: &str) -> Self {
                Self(id.to_string())
            }
        }

        impl From<String> for $name {
            fn from(id: String) -> Self {
                Self(id)
            }
        }
    };
}

id_type!(
    /// Opaque account identifier.
    AccountId
);
id_type!(
    /// Opaque asset identifier (asset-model-v2 UUIDs in production).
    AssetId
);
id_type!(
    /// Opaque activity identifier.
    ActivityId
);
id_type!(
    /// Economic event identifier; synthetic legs keep traceable ids
    /// (`{activity}:dividend`, `{activity}:buy`).
    EventId
);
