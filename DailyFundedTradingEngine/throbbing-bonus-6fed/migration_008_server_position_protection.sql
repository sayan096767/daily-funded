PRAGMA foreign_keys = ON;

ALTER TABLE positions ADD COLUMN close_price REAL;
ALTER TABLE positions ADD COLUMN realized_pnl REAL;
ALTER TABLE positions ADD COLUMN closed_at TEXT;

CREATE TABLE IF NOT EXISTS market_tick_cursors (
    symbol TEXT PRIMARY KEY,
    timestamp_ms INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
