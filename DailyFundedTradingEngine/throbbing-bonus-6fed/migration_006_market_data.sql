PRAGMA foreign_keys = ON;

ALTER TABLE trading_symbols ADD COLUMN provider TEXT;
ALTER TABLE trading_symbols ADD COLUMN provider_symbol TEXT;
ALTER TABLE trading_symbols ADD COLUMN market_data_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE trading_symbols
SET provider = 'gold_api',
    provider_symbol = 'XAU/USD',
    market_data_enabled = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE symbol = 'XAUUSD';

UPDATE trading_symbols
SET provider = 'biquote',
    provider_symbol = symbol,
    market_data_enabled = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE symbol IN ('EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'XAGUSD', 'USOIL');

INSERT INTO trading_symbols (
    id,
    symbol,
    display_name,
    category,
    provider,
    provider_symbol,
    trading_enabled,
    market_data_enabled
) VALUES
    ('SYMBOL_MD_XCUUSD', 'XCUUSD', 'Copper vs US Dollar', 'METALS', 'biquote', 'XCUUSD', 0, 1),
    ('SYMBOL_MD_UKOIL', 'UKOIL', 'Crude Oil Brent', 'ENERGY', 'biquote', 'UKOIL', 0, 1),
    ('SYMBOL_MD_XNGUSD', 'XNGUSD', 'Natural Gas vs US Dollar', 'ENERGY', 'biquote', 'XNGUSD', 0, 1),
    ('SYMBOL_MD_USTEC', 'USTEC', 'US Tech 100 Index', 'INDEX', 'biquote', 'USTEC', 0, 1),
    ('SYMBOL_MD_US30', 'US30', 'US Wall Street 30 Index', 'INDEX', 'biquote', 'US30', 0, 1),
    ('SYMBOL_MD_US500', 'US500', 'US SPX 500 Index', 'INDEX', 'biquote', 'US500', 0, 1),
    ('SYMBOL_MD_GER40', 'GER40', 'GER40', 'INDEX', 'biquote', 'GER40', 0, 1),
    ('SYMBOL_MD_UK100', 'UK100', 'UK 100 Index', 'INDEX', 'biquote', 'UK100', 0, 1),
    ('SYMBOL_MD_AUS200', 'AUS200', 'Australia S&P ASX 200 Index', 'INDEX', 'biquote', 'AUS200', 0, 1)
ON CONFLICT(symbol) DO UPDATE SET
    display_name = excluded.display_name,
    category = excluded.category,
    provider = excluded.provider,
    provider_symbol = excluded.provider_symbol,
    trading_enabled = 0,
    market_data_enabled = 1,
    updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS market_candles (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
    open_time TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL,
    source TEXT NOT NULL CHECK (source = 'worker_generated'),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, interval, open_time),
    FOREIGN KEY (symbol) REFERENCES trading_symbols(symbol) ON DELETE CASCADE
);