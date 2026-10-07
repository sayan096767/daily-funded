PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trading_symbols (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  volume_unit TEXT NOT NULL,
  contract_size REAL NOT NULL,
  price_decimals INTEGER NOT NULL,
  pip_size REAL NOT NULL,
  lot_step REAL NOT NULL,
  minimum_lot REAL NOT NULL,
  maximum_lot REAL,
  trading_enabled INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  market_data_enabled INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trading_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  challenge_model TEXT NOT NULL,
  phase_number INTEGER NOT NULL,
  challenge_size REAL NOT NULL,
  starting_balance REAL NOT NULL,
  balance REAL NOT NULL,
  equity REAL NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_rule_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  phase_number INTEGER NOT NULL,
  challenge_size REAL NOT NULL,
  leverage REAL NOT NULL,
  profit_target_percent REAL NOT NULL,
  daily_drawdown_percent REAL NOT NULL,
  max_drawdown_percent REAL NOT NULL,
  max_drawdown_type TEXT NOT NULL,
  daily_drawdown_type TEXT NOT NULL,
  minimum_trading_days INTEGER NOT NULL,
  profit_split_percent REAL NOT NULL,
  allowed_symbols_json TEXT NOT NULL,
  custom_rules_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume REAL NOT NULL,
  requested_price REAL NOT NULL,
  order_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume REAL NOT NULL,
  open_price REAL NOT NULL,
  current_price REAL NOT NULL,
  floating_pnl REAL NOT NULL,
  take_profit REAL,
  stop_loss REAL,
  status TEXT NOT NULL,
  close_price REAL,
  realized_pnl REAL,
  closed_at TEXT,
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume REAL NOT NULL,
  open_price REAL NOT NULL,
  close_price REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  opened_at TEXT,
  closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS position_calculation_snapshots (
  position_id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS isolated_sltp_runs (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS isolated_sltp_positions (
  position_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  side TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  initial_bid REAL NOT NULL,
  initial_ask REAL NOT NULL,
  provider_timestamp TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES isolated_sltp_runs(run_id)
);
