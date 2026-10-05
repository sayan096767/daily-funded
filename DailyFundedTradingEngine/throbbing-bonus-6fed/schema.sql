PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trading_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    purchase_id TEXT,
    challenge_model TEXT NOT NULL DEFAULT '1_STEP',
    phase_number INTEGER NOT NULL DEFAULT 1,
    challenge_size REAL NOT NULL,
    starting_balance REAL NOT NULL,
    balance REAL NOT NULL,
    equity REAL NOT NULL,
    profit_target_percent REAL NOT NULL DEFAULT 10,
    daily_drawdown_percent REAL NOT NULL DEFAULT 5,
    max_drawdown_percent REAL NOT NULL DEFAULT 10,
    minimum_trading_days INTEGER NOT NULL DEFAULT 0,
    maximum_trading_days INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_accounts_purchase_id_unique
ON trading_accounts(purchase_id)
WHERE purchase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    requested_price REAL,
    order_type TEXT NOT NULL DEFAULT 'MARKET',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES trading_accounts(id)
);

CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    order_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    open_price REAL NOT NULL,
    current_price REAL NOT NULL,
    floating_pnl REAL NOT NULL DEFAULT 0,
    take_profit REAL,
    stop_loss REAL,
    status TEXT NOT NULL DEFAULT 'open',
    close_price REAL,
    realized_pnl REAL,
    closed_at TEXT,
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES trading_accounts(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    order_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    volume REAL NOT NULL,
    open_price REAL NOT NULL,
    close_price REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    opened_at TEXT,
    closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES trading_accounts(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS daily_metrics (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    trading_date TEXT NOT NULL,
    starting_balance REAL NOT NULL,
    starting_equity REAL NOT NULL,
    ending_balance REAL NOT NULL,
    ending_equity REAL NOT NULL,
    daily_pnl REAL NOT NULL DEFAULT 0,
    daily_drawdown_percent REAL NOT NULL DEFAULT 0,
    max_drawdown_percent REAL NOT NULL DEFAULT 0,
    profit_percent REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (account_id) REFERENCES trading_accounts(id),
    UNIQUE(account_id, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user
ON trading_accounts(user_id);

CREATE INDEX IF NOT EXISTS idx_orders_account
ON orders(account_id);

CREATE INDEX IF NOT EXISTS idx_positions_account
ON positions(account_id);

CREATE TABLE IF NOT EXISTS market_tick_cursors (
    symbol TEXT PRIMARY KEY,
    timestamp_ms INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_account
ON trades(account_id);

CREATE INDEX IF NOT EXISTS idx_metrics_account_date
ON daily_metrics(account_id, trading_date);