ALTER TABLE private_snapshots
ADD COLUMN cash_flow_type TEXT NOT NULL DEFAULT 'TOTAL_TO_DATE' CHECK (
    cash_flow_type IN ('TOTAL_TO_DATE', 'PERIOD_ONLY')
);
