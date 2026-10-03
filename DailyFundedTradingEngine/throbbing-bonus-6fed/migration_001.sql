ALTER TABLE trading_accounts ADD COLUMN challenge_model TEXT NOT NULL DEFAULT '1_STEP';
ALTER TABLE trading_accounts ADD COLUMN phase_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trading_accounts ADD COLUMN minimum_trading_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trading_accounts ADD COLUMN maximum_trading_days INTEGER;