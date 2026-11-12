CREATE TABLE IF NOT EXISTS trading_day_qualifications (
    account_id TEXT NOT NULL,
    trading_day TEXT NOT NULL,
    required_profit REAL NOT NULL,
    net_realized_profit REAL NOT NULL,
    qualified INTEGER NOT NULL CHECK (qualified IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, trading_day),
    FOREIGN KEY (account_id) REFERENCES trading_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_trading_day_qualifications_account_qualified
ON trading_day_qualifications(account_id, qualified);
