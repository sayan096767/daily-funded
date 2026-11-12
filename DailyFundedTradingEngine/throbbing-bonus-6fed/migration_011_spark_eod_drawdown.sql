ALTER TABLE account_rule_snapshots
ADD COLUMN spark_eod_high_equity_cents INTEGER;

ALTER TABLE account_rule_snapshots
ADD COLUMN spark_max_loss_threshold_cents INTEGER;

ALTER TABLE account_rule_snapshots
ADD COLUMN spark_daily_reference_equity_cents INTEGER;

ALTER TABLE account_rule_snapshots
ADD COLUMN spark_last_eod_boundary_at TEXT;

ALTER TABLE account_rule_snapshots
ADD COLUMN spark_last_eod_quote_timestamps_json TEXT;

CREATE TABLE spark_drawdown_eod_snapshots (
    account_id TEXT NOT NULL,
    boundary_at TEXT NOT NULL,
    closing_equity_cents INTEGER NOT NULL,
    quote_timestamps_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, boundary_at),
    FOREIGN KEY (account_id) REFERENCES trading_accounts(id)
);

CREATE TABLE spark_eod_quote_candidates (
    symbol TEXT NOT NULL,
    boundary_at TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    PRIMARY KEY (symbol, boundary_at)
);
