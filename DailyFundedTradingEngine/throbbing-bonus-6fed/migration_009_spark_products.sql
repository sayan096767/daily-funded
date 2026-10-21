-- Add Spark Forex products without changing existing Classic Forex or Futures rows.
INSERT OR IGNORE INTO challenge_models (
    id, code, name, description, currency, leverage, profit_split_percent,
    minimum_payout, maximum_payout, payout_frequency, payout_waiting_period_days,
    status, custom_rules_json
) VALUES
    ('MODEL_FX_SPARK_1STEP', 'SPARK_1_STEP', 'Spark 1-Step', 'Spark Forex 1-Step challenge', 'USD', 100, 70, NULL, NULL, 'on_demand', NULL, 'active', '{"reward_cycle_label":"On demand"}'),
    ('MODEL_FX_SPARK_INSTANT', 'SPARK_INSTANT', 'Spark Instant', 'Spark Forex Instant Funding', 'USD', 100, 70, NULL, NULL, 'on_demand', NULL, 'active', '{"reward_cycle_label":"On demand"}');

INSERT OR IGNORE INTO challenge_model_phases (
    id, model_id, phase_number, phase_name, description, profit_target_percent,
    daily_drawdown_percent, max_drawdown_percent, max_drawdown_type,
    daily_drawdown_type, minimum_trading_days, maximum_trading_days,
    minimum_profitable_days, max_lot_size, max_open_positions, max_trades_per_day,
    max_risk_per_trade_percent, max_daily_risk_percent, max_exposure_percent,
    stop_loss_required, take_profit_required, weekend_holding_allowed,
    overnight_holding_allowed, news_trading_allowed, ea_allowed,
    allowed_symbols_json, allowed_categories_json, pass_rule, fail_rule,
    next_phase_number, custom_rules_json, status
) VALUES
    ('PHASE_FX_SPARK_1STEP_1', 'MODEL_FX_SPARK_1STEP', 1, 'Phase 1', NULL, 6, 3, 7, 'TRAILING', 'START_OF_DAY_EQUITY', 5, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 1, 1, 1, '["EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD","XAUUSD","XAGUSD","BTCUSD","ETHUSD","USOIL"]', NULL, NULL, NULL, NULL, '{"consistency_rule_percent":30}', 'active'),
    ('PHASE_FX_SPARK_INSTANT_1', 'MODEL_FX_SPARK_INSTANT', 1, 'Phase 1', NULL, NULL, 3, 7, 'TRAILING', 'START_OF_DAY_EQUITY', 5, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 1, 1, 1, 1, '["EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD","XAUUSD","XAGUSD","BTCUSD","ETHUSD","USOIL"]', NULL, NULL, NULL, NULL, '{"consistency_rule_percent":30}', 'active');

INSERT OR IGNORE INTO challenge_model_sizes (
    id, model_id, size, display_name, price, currency, status, custom_rules_json
) VALUES
    ('SIZE_FX_SPARK_1STEP_25000', 'MODEL_FX_SPARK_1STEP', 25000, '$25,000', 39, 'USD', 'active', '{}'),
    ('SIZE_FX_SPARK_1STEP_50000', 'MODEL_FX_SPARK_1STEP', 50000, '$50,000', 59, 'USD', 'active', '{}'),
    ('SIZE_FX_SPARK_1STEP_100000', 'MODEL_FX_SPARK_1STEP', 100000, '$100,000', 79, 'USD', 'active', '{}'),
    ('SIZE_FX_SPARK_INSTANT_25000', 'MODEL_FX_SPARK_INSTANT', 25000, '$25,000', 59, 'USD', 'active', '{}'),
    ('SIZE_FX_SPARK_INSTANT_50000', 'MODEL_FX_SPARK_INSTANT', 50000, '$50,000', 79, 'USD', 'active', '{}'),
    ('SIZE_FX_SPARK_INSTANT_100000', 'MODEL_FX_SPARK_INSTANT', 100000, '$100,000', 99, 'USD', 'active', '{}');
