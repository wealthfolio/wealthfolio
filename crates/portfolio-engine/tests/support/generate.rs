//! Generated scenarios: random combinations of the inputs the hand-written
//! fixtures cover one at a time (archived and holdings accounts, activities
//! and transfers recorded on holdings accounts, accounts opening after the
//! others, accounts without activity or with only scheduled activity, a
//! holdings account without a snapshot, sparse, invalid and missing quotes,
//! splits adjusted or not by the provider, transfers across days and both
//! ways, shorts, minor units, options, FX), written as YAML in
//! the fixture schema. The engine's property laws and the app parity test
//! (`crates/core`, which includes this file by path) both run over them, so
//! it uses the standard library only.
//!
//! Histories are coherent: a small simulation tracks what every account
//! holds, so an account sells or sends only what it has, covers a short
//! with an explicit intent, and every holder records a split. A quarter of
//! the scenarios then lose their first purchases, as a history that starts
//! after the units were bought does: their later sales and transfers move
//! more than the account holds.

use std::collections::BTreeMap;
use std::fmt::Write;

/// How many scenarios a run generates: `GENERATED_SCENARIOS`, else 100.
pub fn generated_count() -> u64 {
    std::env::var("GENERATED_SCENARIOS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(100)
}

/// xorshift64*: deterministic, so a failing seed reproduces.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

/// Days since 2024-12-01 as an ISO date (the generated range spans the new
/// year, so yearly windows have a boundary inside it).
fn date(day: u64) -> String {
    let lengths = [31u64, 31, 28, 31];
    let months = [(2024, 12), (2025, 1), (2025, 2), (2025, 3)];
    let mut rest = day;
    for (length, (year, month)) in lengths.iter().zip(months) {
        if rest < *length {
            return format!("{year}-{month:02}-{:02}", rest + 1);
        }
        rest -= length;
    }
    panic!("day {day} beyond the generated calendar");
}

struct Account {
    id: String,
    currency: &'static str,
    holdings: bool,
    archived: bool,
}

struct Asset {
    id: String,
    quote: &'static str,
    /// Price level in the quote currency (pence for GBp).
    price: u64,
    option: bool,
}

impl Asset {
    /// A unit price in major units, as activities record it.
    fn unit(&self) -> u64 {
        if self.quote == "GBp" {
            self.price / 100
        } else {
            self.price
        }
    }

    fn multiplier(&self) -> u64 {
        if self.option {
            100
        } else {
            1
        }
    }
}

/// Activities in time order, with a timestamp that keeps that order.
struct Ledger {
    rows: String,
    minute: u64,
    id: u64,
    /// Purchases still to leave out (an incomplete history).
    skip_buys: u64,
}

impl Ledger {
    fn row(&mut self, day: u64, account: &str, body: &str) {
        if self.skip_buys > 0 && body.starts_with("type: BUY") {
            self.skip_buys -= 1;
            return;
        }
        self.minute += 1;
        self.id += 1;
        let _ = writeln!(
            self.rows,
            "  - {{ id: x{}, account: {account}, date: {}T{:02}:{:02}:00Z, {body} }}",
            self.id,
            date(day),
            8 + self.minute / 60,
            self.minute % 60
        );
    }
}

/// One generated scenario, as YAML.
pub fn scenario_yaml(seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let base = *rng.pick(&["USD", "USD", "CAD", "GBP"]);
    let start = 15 + rng.below(12);
    let as_of = start + 20 + rng.below(25);

    // The first account is a live transactions account; the others may be
    // holdings-tracked (snapshots only) or archived.
    let mut accounts = Vec::new();
    for index in 0..2 + rng.below(3) {
        let holdings = index > 0 && rng.chance(20);
        accounts.push(Account {
            id: format!("acc-{index}"),
            currency: rng.pick(&["USD", "USD", "CAD", "GBP"]),
            holdings,
            archived: index > 0 && !holdings && rng.chance(15),
        });
    }
    let traders: Vec<usize> = (0..accounts.len())
        .filter(|i| !accounts[*i].holdings)
        .collect();
    let holders: Vec<usize> = (0..accounts.len())
        .filter(|i| accounts[*i].holdings)
        .collect();

    let mut assets = Vec::new();
    for index in 0..1 + rng.below(3) {
        let option = rng.chance(10);
        let quote = if option {
            "USD"
        } else {
            *rng.pick(&["USD", "USD", "CAD", "GBp"])
        };
        let price = if quote == "GBp" {
            1_000 + rng.below(9_000)
        } else {
            10 + rng.below(190)
        };
        assets.push(Asset {
            id: format!("a{index}"),
            quote,
            price,
            option,
        });
    }

    let mut ledger = Ledger {
        rows: String::new(),
        minute: 0,
        id: 0,
        skip_buys: if rng.chance(25) { 1 + rng.below(2) } else { 0 },
    };
    // Signed units each trading account holds (negative: short).
    let mut held: BTreeMap<(usize, usize), i64> = BTreeMap::new();
    // Securities in transit: (arrival day, account, asset, signed units).
    let mut arriving: Vec<(u64, usize, usize, i64)> = Vec::new();
    let mut splits: Vec<(usize, u64, u64, bool)> = Vec::new();
    let mut group = 0u64;

    // Trading accounts open on the first day, or now and then later: an
    // account added to a portfolio that already exists.
    let opens: BTreeMap<usize, u64> = traders
        .iter()
        .enumerate()
        .map(|(n, &index)| {
            let day = if n > 0 && rng.chance(30) {
                (start + 1 + rng.below(10)).min(as_of)
            } else {
                start
            };
            (index, day)
        })
        .collect();
    for &index in &traders {
        let account = &accounts[index];
        let (amount, currency) = if account.currency == "GBP" && rng.chance(30) {
            ((1_000 + rng.below(4_000)) * 100, "GBp")
        } else {
            (1_000 + rng.below(4_000), account.currency)
        };
        ledger.row(
            opens[&index],
            &account.id,
            &format!("type: DEPOSIT, amount: {amount}, currency: {currency}"),
        );
    }

    for day in start..=as_of {
        for (_, account, asset, units) in arriving.iter().filter(|a| a.0 == day) {
            *held.entry((*account, *asset)).or_default() += units;
        }
        arriving.retain(|a| a.0 != day);
        // A split comes first on its day: it multiplies only what was held
        // before the day (a later trade that day is in post-split units).
        if rng.chance(8) {
            let a = rng.below(assets.len() as u64) as usize;
            if !assets[a].option && !splits.iter().any(|s| s.0 == a) {
                let ratio = 2 + rng.below(2);
                splits.push((a, day, ratio, rng.chance(50)));
                for &holder in &traders {
                    let units = held.get(&(holder, a)).copied().unwrap_or(0);
                    if units != 0 {
                        ledger.row(
                            day,
                            &accounts[holder].id,
                            &format!("type: SPLIT, asset: {}, amount: {ratio}", assets[a].id),
                        );
                        held.insert((holder, a), units * ratio as i64);
                    }
                }
                for pending in arriving.iter_mut().filter(|p| p.2 == a) {
                    pending.3 *= ratio as i64;
                }
            }
        }
        for _ in 0..rng.below(3) {
            let index = *rng.pick(&traders);
            if day < opens[&index] {
                continue;
            }
            let a = rng.below(assets.len() as u64) as usize;
            let asset = &assets[a];
            let account = &accounts[index];
            let units = held.get(&(index, a)).copied().unwrap_or(0);
            let price = asset.unit();
            match rng.below(9) {
                0..=2 => {
                    // Buy, or cover part of a short with an explicit intent.
                    let quantity = if units < 0 {
                        1 + rng.below(units.unsigned_abs())
                    } else {
                        1 + rng.below(if asset.option { 3 } else { 20 })
                    };
                    let intent = if units < 0 {
                        ", subtype: POSITION_CLOSE"
                    } else {
                        ""
                    };
                    let fee = if rng.chance(20) { ", fee: 1" } else { "" };
                    ledger.row(
                        day,
                        &account.id,
                        &format!(
                            "type: BUY, asset: {}, quantity: {quantity}, unit_price: {price}, amount: {}, currency: {}{intent}{fee}",
                            asset.id,
                            quantity * price * asset.multiplier(),
                            account.currency
                        ),
                    );
                    *held.entry((index, a)).or_default() += quantity as i64;
                }
                3 => {
                    // Sell what is held, or open (or add to) a short.
                    let (quantity, intent) = if units > 0 {
                        (1 + rng.below(units as u64), "")
                    } else if !asset.option && rng.chance(50) {
                        (1 + rng.below(5), ", subtype: POSITION_OPEN")
                    } else {
                        continue;
                    };
                    ledger.row(
                        day,
                        &account.id,
                        &format!(
                            "type: SELL, asset: {}, quantity: {quantity}, unit_price: {price}, amount: {}, currency: {}{intent}",
                            asset.id,
                            quantity * price * asset.multiplier(),
                            account.currency
                        ),
                    );
                    *held.entry((index, a)).or_default() -= quantity as i64;
                }
                4 => {
                    let kind = *rng.pick(&["WITHDRAWAL", "FEE", "INTEREST", "DIVIDEND"]);
                    if kind == "DIVIDEND" && units <= 0 {
                        continue;
                    }
                    let asset_field = if kind == "DIVIDEND" {
                        format!(", asset: {}", asset.id)
                    } else {
                        String::new()
                    };
                    ledger.row(
                        day,
                        &account.id,
                        &format!(
                            "type: {kind}{asset_field}, amount: {}, currency: {}",
                            1 + rng.below(50),
                            account.currency
                        ),
                    );
                }
                5..=7 if traders.len() > 1 => {
                    // A paired transfer, cash or what is held, arriving the
                    // same day or a day or two later, sometimes answered the
                    // same day.
                    let open: Vec<usize> = traders
                        .iter()
                        .copied()
                        .filter(|&candidate| candidate != index && opens[&candidate] <= day)
                        .collect();
                    if open.is_empty() {
                        continue;
                    }
                    let to = *rng.pick(&open);
                    let mut legs = vec![(index, to)];
                    if rng.chance(30) {
                        legs.push((to, index));
                    }
                    for (from, to) in legs {
                        let units = held.get(&(from, a)).copied().unwrap_or(0);
                        let arrives = (day + rng.below(3)).min(as_of);
                        group += 1;
                        let (from_id, from_currency) =
                            (&accounts[from].id, accounts[from].currency);
                        let to_id = &accounts[to].id;
                        if units != 0 && rng.chance(60) {
                            let quantity = 1 + rng.below(units.unsigned_abs());
                            let body = format!(
                                "asset: {}, quantity: {quantity}, unit_price: {price}, source_group_id: g{group}",
                                asset.id
                            );
                            ledger.row(day, from_id, &format!("type: TRANSFER_OUT, {body}"));
                            let moved = quantity as i64 * units.signum();
                            *held.entry((from, a)).or_default() -= moved;
                            if arrives == day {
                                *held.entry((to, a)).or_default() += moved;
                            } else {
                                arriving.push((arrives, to, a, moved));
                            }
                            ledger.row(arrives, to_id, &format!("type: TRANSFER_IN, {body}"));
                        } else {
                            let body = format!(
                                "amount: {}, currency: {from_currency}, source_group_id: g{group}",
                                10 + rng.below(200)
                            );
                            ledger.row(day, from_id, &format!("type: TRANSFER_OUT, {body}"));
                            ledger.row(arrives, to_id, &format!("type: TRANSFER_IN, {body}"));
                        }
                    }
                }
                8 if !holders.is_empty() => {
                    // A transfer with a holdings account: the trading side
                    // moves on its day, the holdings side shows only in its
                    // snapshots (rules R2.3).
                    let holding = &accounts[*rng.pick(&holders)];
                    group += 1;
                    let sends = rng.chance(60);
                    let (from_id, to_id) = if sends {
                        (&account.id, &holding.id)
                    } else {
                        (&holding.id, &account.id)
                    };
                    let quantity = if sends && units > 0 {
                        1 + rng.below(units as u64)
                    } else if !sends && !asset.option {
                        1 + rng.below(10)
                    } else {
                        0
                    };
                    let body = if quantity > 0 && rng.chance(60) {
                        let signed = quantity as i64;
                        *held.entry((index, a)).or_default() +=
                            if sends { -signed } else { signed };
                        format!(
                            "asset: {}, quantity: {quantity}, unit_price: {price}, source_group_id: g{group}",
                            asset.id
                        )
                    } else {
                        format!(
                            "amount: {}, currency: {}, source_group_id: g{group}",
                            10 + rng.below(200),
                            account.currency
                        )
                    };
                    ledger.row(day, from_id, &format!("type: TRANSFER_OUT, {body}"));
                    ledger.row(day, to_id, &format!("type: TRANSFER_IN, {body}"));
                }
                _ => {}
            }
        }
        // Holdings accounts record activities too; their numbers come only
        // from their snapshots (rules R1.2), so what they record moves
        // nothing but the income, fees and taxes reports.
        for &index in &holders {
            if !rng.chance(6) {
                continue;
            }
            let account = &accounts[index];
            let kind = *rng.pick(&[
                "DEPOSIT",
                "WITHDRAWAL",
                "DIVIDEND",
                "INTEREST",
                "FEE",
                "TAX",
            ]);
            let asset_field = if kind == "DIVIDEND" {
                format!(
                    ", asset: {}",
                    assets[rng.below(assets.len() as u64) as usize].id
                )
            } else {
                String::new()
            };
            ledger.row(
                day,
                &account.id,
                &format!(
                    "type: {kind}{asset_field}, amount: {}, currency: {}",
                    1 + rng.below(80),
                    account.currency
                ),
            );
        }
    }

    // Quotes: sparse closes around each asset's level, provider-adjusted
    // before a split half the time, now and then a non-positive one.
    let mut quotes = String::new();
    for (index, asset) in assets.iter().enumerate() {
        // Now and then an asset has no quote at all: it is valued and
        // transferred at cost.
        if rng.chance(15) {
            continue;
        }
        let mut day = start.saturating_sub(3);
        while day <= as_of {
            if rng.chance(45) {
                let mut close = asset.price * (90 + rng.below(21)) / 100;
                for (_, split_day, ratio, adjusted) in splits.iter().filter(|s| s.0 == index) {
                    if *adjusted && day < *split_day {
                        close = (close / ratio).max(1);
                    }
                }
                if rng.chance(4) {
                    close = 0;
                }
                let _ = writeln!(
                    quotes,
                    "  - {{ asset: {}, day: {}, close: {close} }}",
                    asset.id,
                    date(day)
                );
            }
            day += 1 + rng.below(4);
        }
    }

    // FX: CAD and GBP against USD on a few days.
    let mut fx = String::new();
    for (currency, level) in [("CAD", 72u64), ("GBP", 127)] {
        let mut day = start.saturating_sub(2);
        while day <= as_of {
            let rate = level + rng.below(5);
            let _ = writeln!(
                fx,
                "  - {{ from: {currency}, to: USD, day: {}, rate: {}.{:02} }}",
                date(day),
                rate / 100,
                rate % 100
            );
            day += 3 + rng.below(8);
        }
    }

    let mut snapshots = String::new();
    for account in accounts.iter().filter(|a| a.holdings) {
        let mut day = start + rng.below(5);
        while day <= as_of {
            let mut positions = Vec::new();
            for asset in &assets {
                if rng.chance(70) {
                    positions.push(format!(
                        "{{ asset: {}, quantity: {}, average_cost: {} }}",
                        asset.id,
                        1 + rng.below(30),
                        asset.unit()
                    ));
                }
            }
            let _ = writeln!(
                snapshots,
                "  - {{ account: {}, date: {}, cash: {{ {}: {} }}, positions: [{}] }}",
                account.id,
                date(day),
                account.currency,
                100 + rng.below(1_000),
                positions.join(", ")
            );
            day += 5 + rng.below(15);
        }
    }

    // Accounts with nothing to fold or observe yet, drawn from their own
    // stream so the rest of the scenario stays as it was: one without
    // activity, one whose only activity is scheduled after `as_of`, and a
    // holdings account without a snapshot. The first account sometimes has a
    // deposit scheduled too.
    let mut extra = Rng::new(seed ^ 0xACC0_FFEE);
    if extra.chance(20) {
        accounts.push(Account {
            id: "acc-idle".to_string(),
            currency: extra.pick(&["USD", "CAD", "GBP"]),
            holdings: false,
            archived: false,
        });
    }
    if extra.chance(20) {
        let currency = *extra.pick(&["USD", "CAD", "GBP"]);
        accounts.push(Account {
            id: "acc-scheduled".to_string(),
            currency,
            holdings: false,
            archived: false,
        });
        ledger.row(
            as_of + 1 + extra.below(20),
            "acc-scheduled",
            &format!(
                "type: DEPOSIT, amount: {}, currency: {currency}",
                100 + extra.below(1_000)
            ),
        );
    }
    if extra.chance(10) {
        accounts.push(Account {
            id: "acc-unobserved".to_string(),
            currency: extra.pick(&["USD", "CAD", "GBP"]),
            holdings: true,
            archived: false,
        });
    }
    if extra.chance(15) {
        let account = &accounts[0];
        ledger.row(
            as_of + 1 + extra.below(20),
            &account.id,
            &format!(
                "type: DEPOSIT, amount: {}, currency: {}",
                100 + extra.below(1_000),
                account.currency
            ),
        );
    }

    let mut yaml = String::new();
    let _ = writeln!(yaml, "id: GEN-{seed:04}");
    let _ = writeln!(yaml, "title: generated scenario {seed}");
    let _ = writeln!(yaml, "intent: generated");
    let _ = writeln!(yaml, "markers: [K]");
    let _ = writeln!(
        yaml,
        "policy: {{ base_currency: {base}, timezone: UTC, as_of: {} }}",
        date(as_of)
    );
    let _ = writeln!(yaml, "accounts:");
    for account in &accounts {
        let _ = writeln!(
            yaml,
            "  - {{ id: {}, currency: {}, tracking_mode: {}, is_archived: {} }}",
            account.id,
            account.currency,
            if account.holdings {
                "HOLDINGS"
            } else {
                "TRANSACTIONS"
            },
            account.archived
        );
    }
    let _ = writeln!(yaml, "assets:");
    for asset in &assets {
        if asset.option {
            let _ = writeln!(
                yaml,
                "  - {{ id: {}, quote_ccy: {}, instrument_type: OPTION, contract_multiplier: 100 }}",
                asset.id, asset.quote
            );
        } else {
            let _ = writeln!(
                yaml,
                "  - {{ id: {}, quote_ccy: {} }}",
                asset.id, asset.quote
            );
        }
    }
    let section = |name: &str, rows: &str| {
        if rows.is_empty() {
            format!("{name}: []\n")
        } else {
            format!("{name}:\n{rows}")
        }
    };
    yaml.push_str(&section("activities", &ledger.rows));
    yaml.push_str(&section("quotes", &quotes));
    yaml.push_str(&section("fx_rates", &fx));
    yaml.push_str(&section("observed_snapshots", &snapshots));
    yaml
}
