CREATE TABLE price_alerts (
    id TEXT PRIMARY KEY NOT NULL,
    asset_id TEXT NOT NULL,
    condition TEXT NOT NULL CHECK (condition IN ('ABOVE', 'BELOW')),
    target_price TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'TRIGGERED', 'PAUSED')),
    armed_at TEXT NOT NULL,
    armed_market_date TEXT NOT NULL,
    pause_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX price_alerts_asset_status_idx ON price_alerts(asset_id, status);

CREATE TABLE price_alert_events (
    id TEXT PRIMARY KEY NOT NULL,
    alert_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    target_price TEXT NOT NULL,
    observed_close TEXT NOT NULL,
    observed_high TEXT NOT NULL,
    observed_low TEXT NOT NULL,
    currency TEXT NOT NULL,
    quote_timestamp TEXT NOT NULL,
    triggered_at TEXT NOT NULL,
    acknowledged_at TEXT,
    FOREIGN KEY (alert_id) REFERENCES price_alerts(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX price_alert_events_unread_idx
    ON price_alert_events(acknowledged_at, triggered_at);
