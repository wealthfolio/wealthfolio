-- Durable per-addon key-value storage.
-- Local-only table today; device-sync participation is a planned follow-up.
CREATE TABLE addon_storage (
    addon_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (addon_id, key)
);
