ALTER TABLE account_rule_snapshots
ADD COLUMN starting_day_utc_date TEXT;

ALTER TABLE account_rule_snapshots
ADD COLUMN high_water_mark_tracking_complete INTEGER NOT NULL DEFAULT 0;
