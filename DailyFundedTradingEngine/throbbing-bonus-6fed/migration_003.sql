PRAGMA foreign_keys = ON;

-- Add the currencies and volume unit required by the current P&L calculator.
-- These nullable columns intentionally leave unconfigured symbols fail-closed.
-- SQLite has no portable ADD COLUMN IF NOT EXISTS; apply this migration once
-- through the migration ledger, not by manually replaying the file.
ALTER TABLE trading_symbols ADD COLUMN base_currency TEXT;
ALTER TABLE trading_symbols ADD COLUMN quote_currency TEXT;
ALTER TABLE trading_symbols ADD COLUMN volume_unit TEXT;

-- Persist immutable calculation metadata for positions opened after this
-- migration. Existing positions are deliberately not backfilled here.
CREATE TABLE IF NOT EXISTS position_calculation_snapshots (
    position_id TEXT PRIMARY KEY,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
);

-- Apply the approved symbol metadata. Conflict updates preserve existing
-- symbol IDs; seed IDs are used only when a symbol row does not yet exist.
INSERT INTO trading_symbols (
    id,
    symbol,
    display_name,
    category,
    base_currency,
    quote_currency,
    volume_unit,
    contract_size,
    price_decimals,
    pip_size,
    lot_step,
    minimum_lot,
    maximum_lot,
    trading_enabled
) VALUES
    ('SYMBOL_FX_EURUSD', 'EURUSD', 'EURUSD', 'FOREX', 'EUR', 'USD', 'lot', 100000, 5, 0.0001, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_GBPUSD', 'GBPUSD', 'GBPUSD', 'FOREX', 'GBP', 'USD', 'lot', 100000, 5, 0.0001, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_USDJPY', 'USDJPY', 'USDJPY', 'FOREX', 'USD', 'JPY', 'lot', 100000, 3, 0.01, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_USDCHF', 'USDCHF', 'USDCHF', 'FOREX', 'USD', 'CHF', 'lot', 100000, 5, 0.0001, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_USDCAD', 'USDCAD', 'USDCAD', 'FOREX', 'USD', 'CAD', 'lot', 100000, 5, 0.0001, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_AUDUSD', 'AUDUSD', 'AUDUSD', 'FOREX', 'AUD', 'USD', 'lot', 100000, 5, 0.0001, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_NZDUSD', 'NZDUSD', 'NZDUSD', 'FOREX', 'NZD', 'USD', 'lot', 100000, 5, 0.0001, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_XAUUSD', 'XAUUSD', 'XAUUSD', 'METALS', 'XAU', 'USD', 'lot', 100, 2, 0.01, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_XAGUSD', 'XAGUSD', 'XAGUSD', 'METALS', 'XAG', 'USD', 'lot', 5000, 3, 0.01, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_BTCUSD', 'BTCUSD', 'BTCUSD', 'CRYPTO', 'BTC', 'USD', 'lot', 1, 1, 0.1, 0.01, 0.01, NULL, 1),
    ('SYMBOL_FX_ETHUSD', 'ETHUSD', 'ETHUSD', 'CRYPTO', 'ETH', 'USD', 'lot', 1, 2, 0.1, 0.1, 0.1, NULL, 1),
    ('SYMBOL_FX_USOIL', 'USOIL', 'USOIL', 'ENERGY', 'OIL', 'USD', 'lot', 1000, 2, 0.01, 0.01, 0.01, NULL, 1)
ON CONFLICT(symbol) DO UPDATE SET
    display_name = excluded.display_name,
    category = excluded.category,
    base_currency = excluded.base_currency,
    quote_currency = excluded.quote_currency,
    volume_unit = excluded.volume_unit,
    contract_size = excluded.contract_size,
    price_decimals = excluded.price_decimals,
    pip_size = excluded.pip_size,
    lot_step = excluded.lot_step,
    minimum_lot = excluded.minimum_lot,
    maximum_lot = NULL,
    trading_enabled = 1,
    updated_at = CURRENT_TIMESTAMP;

-- Match the current seed's symbol allowlist on the four seed-defined phases.
-- Only null/empty allowlists are filled; existing nonempty customization and
-- all account_rule_snapshots remain untouched.
UPDATE challenge_model_phases
SET
    allowed_symbols_json = '["EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD","XAUUSD","XAGUSD","BTCUSD","ETHUSD","USOIL"]',
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (
    'PHASE_FX_1STEP_1',
    'PHASE_FX_2STEP_1',
    'PHASE_FX_2STEP_2',
    'PHASE_FX_INSTANT_1'
)
AND (allowed_symbols_json IS NULL OR allowed_symbols_json = '[]');
