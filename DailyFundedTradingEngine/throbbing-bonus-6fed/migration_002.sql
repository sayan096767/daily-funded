PRAGMA foreign_keys = ON;

-- =========================================================
-- Daily Funded - Flexible Challenge Models
-- =========================================================

-- Model template
CREATE TABLE IF NOT EXISTS challenge_models (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    leverage REAL NOT NULL DEFAULT 100,
    profit_split_percent REAL NOT NULL DEFAULT 80,
    minimum_payout REAL,
    maximum_payout REAL,
    payout_frequency TEXT,
    payout_waiting_period_days INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    custom_rules_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_accounts_purchase_id_unique
ON trading_accounts(purchase_id)
WHERE purchase_id IS NOT NULL;

-- Individual phases inside a model
CREATE TABLE IF NOT EXISTS challenge_model_phases (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    phase_number INTEGER NOT NULL,
    phase_name TEXT NOT NULL,
    description TEXT,

    profit_target_percent REAL,
    daily_drawdown_percent REAL,
    max_drawdown_percent REAL,

    max_drawdown_type TEXT NOT NULL DEFAULT 'STATIC',
    daily_drawdown_type TEXT NOT NULL DEFAULT 'START_OF_DAY_EQUITY',

    minimum_trading_days INTEGER NOT NULL DEFAULT 0,
    maximum_trading_days INTEGER,

    minimum_profitable_days INTEGER NOT NULL DEFAULT 0,

    max_lot_size REAL,
    max_open_positions INTEGER,
    max_trades_per_day INTEGER,

    max_risk_per_trade_percent REAL,
    max_daily_risk_percent REAL,
    max_exposure_percent REAL,

    stop_loss_required INTEGER NOT NULL DEFAULT 0,
    take_profit_required INTEGER NOT NULL DEFAULT 0,

    weekend_holding_allowed INTEGER NOT NULL DEFAULT 1,
    overnight_holding_allowed INTEGER NOT NULL DEFAULT 1,
    news_trading_allowed INTEGER NOT NULL DEFAULT 1,
    ea_allowed INTEGER NOT NULL DEFAULT 1,

    allowed_symbols_json TEXT,
    allowed_categories_json TEXT,

    pass_rule TEXT,
    fail_rule TEXT,

    next_phase_number INTEGER,

    custom_rules_json TEXT,

    status TEXT NOT NULL DEFAULT 'active',

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (model_id) REFERENCES challenge_models(id),

    UNIQUE(model_id, phase_number)
);

-- Account sizes available for each model
CREATE TABLE IF NOT EXISTS challenge_model_sizes (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    size REAL NOT NULL,
    display_name TEXT,
    price REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'active',
    custom_rules_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (model_id) REFERENCES challenge_models(id),

    UNIQUE(model_id, size)
);

-- Exact rule snapshot assigned to an account
-- Existing accounts will remain untouched until a snapshot is created for them.
CREATE TABLE IF NOT EXISTS account_rule_snapshots (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,

    model_id TEXT,
    phase_id TEXT,
    size_id TEXT,

    model_code TEXT,
    model_name TEXT,
    phase_number INTEGER,
    phase_name TEXT,

    challenge_size REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    leverage REAL NOT NULL DEFAULT 100,

    profit_target_percent REAL,
    daily_drawdown_percent REAL,
    max_drawdown_percent REAL,

    max_drawdown_type TEXT,
    daily_drawdown_type TEXT,

    minimum_trading_days INTEGER DEFAULT 0,
    maximum_trading_days INTEGER,
    minimum_profitable_days INTEGER DEFAULT 0,

    max_lot_size REAL,
    max_open_positions INTEGER,
    max_trades_per_day INTEGER,

    max_risk_per_trade_percent REAL,
    max_daily_risk_percent REAL,
    max_exposure_percent REAL,

    stop_loss_required INTEGER NOT NULL DEFAULT 0,
    take_profit_required INTEGER NOT NULL DEFAULT 0,

    weekend_holding_allowed INTEGER NOT NULL DEFAULT 1,
    overnight_holding_allowed INTEGER NOT NULL DEFAULT 1,
    news_trading_allowed INTEGER NOT NULL DEFAULT 1,
    ea_allowed INTEGER NOT NULL DEFAULT 1,

    allowed_symbols_json TEXT,
    allowed_categories_json TEXT,

    profit_split_percent REAL DEFAULT 80,
    minimum_payout REAL,
    maximum_payout REAL,
    payout_frequency TEXT,
    payout_waiting_period_days INTEGER,

    pass_rule TEXT,
    fail_rule TEXT,

    custom_rules_json TEXT,

    high_water_mark REAL,
    starting_day_balance REAL,
    starting_day_equity REAL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id) REFERENCES trading_accounts(id),
    FOREIGN KEY (model_id) REFERENCES challenge_models(id),
    FOREIGN KEY (phase_id) REFERENCES challenge_model_phases(id),
    FOREIGN KEY (size_id) REFERENCES challenge_model_sizes(id),

    UNIQUE(account_id)
);

-- Symbol specifications for the simulated trading engine
CREATE TABLE IF NOT EXISTS trading_symbols (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE,
    display_name TEXT,
    category TEXT NOT NULL,
    base_currency TEXT,
    quote_currency TEXT,
    volume_unit TEXT,
    contract_size REAL,
    price_decimals INTEGER,
    pip_size REAL,
    lot_step REAL,
    minimum_lot REAL,
    maximum_lot REAL,

    trading_enabled INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Position calculation rules are frozen at open so catalog edits do not
-- change the P&L of an existing position.
CREATE TABLE IF NOT EXISTS position_calculation_snapshots (
    position_id TEXT PRIMARY KEY,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_model_phases_model
ON challenge_model_phases(model_id);

CREATE INDEX IF NOT EXISTS idx_model_sizes_model
ON challenge_model_sizes(model_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_account
ON account_rule_snapshots(account_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_model
ON account_rule_snapshots(model_id);

CREATE INDEX IF NOT EXISTS idx_symbols_category
ON trading_symbols(category);