//! Lossless `Decimal` serde. The workspace enables `rust_decimal`'s float
//! serde, which would truncate a checkpoint; kernel outputs and checkpoints
//! serialize decimals as exact strings (and accept numbers on input).

use std::collections::BTreeMap;
use std::fmt;

use rust_decimal::Decimal;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::scalar::Currency;

pub fn serialize<S: Serializer>(value: &Decimal, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Decimal, D::Error> {
    deserializer.deserialize_any(DecimalVisitor)
}

struct DecimalVisitor;

impl Visitor<'_> for DecimalVisitor {
    type Value = Decimal;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a decimal string or number")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Decimal, E> {
        value.trim().parse().map_err(E::custom)
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Decimal, E> {
        Ok(Decimal::from(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Decimal, E> {
        Ok(Decimal::from(value))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Decimal, E> {
        Decimal::try_from(value).map_err(E::custom)
    }
}

/// A decimal serialized as a string (helper for containers).
#[derive(Debug, Clone, Copy)]
struct Exact(Decimal);

impl Serialize for Exact {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize(&self.0, serializer)
    }
}

impl<'de> Deserialize<'de> for Exact {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize(deserializer).map(Exact)
    }
}

pub mod option {
    use super::*;

    pub fn serialize<S: Serializer>(
        value: &Option<Decimal>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value.map(Exact).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Decimal>, D::Error> {
        Ok(Option::<Exact>::deserialize(deserializer)?.map(|e| e.0))
    }
}

pub mod map {
    use super::*;

    pub fn serialize<S: Serializer>(
        value: &BTreeMap<Currency, Decimal>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let exact: BTreeMap<&Currency, Exact> = value.iter().map(|(k, v)| (k, Exact(*v))).collect();
        exact.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<Currency, Decimal>, D::Error> {
        Ok(BTreeMap::<Currency, Exact>::deserialize(deserializer)?
            .into_iter()
            .map(|(k, v)| (k, v.0))
            .collect())
    }
}
