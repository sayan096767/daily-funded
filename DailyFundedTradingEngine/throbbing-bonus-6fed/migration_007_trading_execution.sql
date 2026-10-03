PRAGMA foreign_keys = ON;

ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'MARKET';
ALTER TABLE positions ADD COLUMN take_profit REAL;
ALTER TABLE positions ADD COLUMN stop_loss REAL;
ALTER TABLE positions ADD COLUMN status TEXT NOT NULL DEFAULT 'open';

CREATE INDEX IF NOT EXISTS idx_positions_account_status
ON positions(account_id, status);
