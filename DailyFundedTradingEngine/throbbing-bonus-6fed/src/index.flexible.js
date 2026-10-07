import {
  protectionPrice,
  tickIsAfterPositionOpen,
  triggeredProtection,
} from "./positionProtection.js";
import {
  BIQUOTE_HUB_URL,
  negotiateBiquoteSignalR,
  parseSignalRFrames,
  signalRRecord,
} from "./biquoteSignalR.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

const MARKET_DATA_ORIGIN = "https://daily-funded.web.app";
const MARKET_DATA_PATHS = new Set([
  "/market/symbols",
  "/market/quotes",
  "/market/candles",
]);

function withMarketCors(response, request) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    !MARKET_DATA_PATHS.has(url.pathname) ||
    request.headers.get("Origin") !== MARKET_DATA_ORIGIN
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", MARKET_DATA_ORIGIN);
  headers.set("Vary", headers.has("Vary") ? `${headers.get("Vary")}, Origin` : "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrDefault(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.trunc(number);
}

function booleanToDb(value, fallback = 0) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (value === 1 || value === "1" || value === "true") {
    return 1;
  }

  return 0;
}

function parseJsonArray(value, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function jsonString(value, fallback = []) {
  if (value === undefined || value === null) {
    return JSON.stringify(fallback);
  }

  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(fallback);
    }
  }

  return JSON.stringify(value);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must contain valid JSON");
  }
}

function validatePositiveNumber(value, field) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${field} must be a positive number`);
  }

  return number;
}

function validateNonNegativeNumber(value, field) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }

  return number;
}

function getSymbolConfigurationError(symbol) {
  if (!symbol || Number(symbol.trading_enabled) !== 1) {
    return "Symbol is not enabled for trading";
  }

  for (const field of ["base_currency", "quote_currency", "volume_unit"]) {
    if (typeof symbol[field] !== "string" || !symbol[field].trim()) {
      return `${field} is missing from symbol configuration`;
    }
  }

  for (const field of ["contract_size", "pip_size", "lot_step", "minimum_lot"]) {
    if (!Number.isFinite(Number(symbol[field])) || Number(symbol[field]) <= 0) {
      return `${field} is missing or invalid in symbol configuration`;
    }
  }

  if (
    symbol.price_decimals === null ||
    symbol.price_decimals === undefined ||
    !Number.isInteger(Number(symbol.price_decimals)) ||
    Number(symbol.price_decimals) < 0
  ) {
    return "price_decimals is missing or invalid in symbol configuration";
  }

  if (
    symbol.maximum_lot !== null &&
    symbol.maximum_lot !== undefined &&
    (!Number.isFinite(Number(symbol.maximum_lot)) || Number(symbol.maximum_lot) <= 0)
  ) {
    return "maximum_lot is invalid in symbol configuration";
  }

  return null;
}

function validateVolume(volume, symbol, phaseMaxLotSize) {
  const minimumLot = Number(symbol.minimum_lot);
  const lotStep = Number(symbol.lot_step);
  const stepCount = (volume - minimumLot) / lotStep;
  const stepTolerance = Number.EPSILON * Math.max(1, Math.abs(stepCount)) * 8;

  if (volume < minimumLot) {
    throw new Error(`Minimum lot size is ${minimumLot}`);
  }

  if (Math.abs(stepCount - Math.round(stepCount)) > stepTolerance) {
    throw new Error(`Volume must follow lot step ${lotStep}`);
  }

  if (symbol.maximum_lot !== null && symbol.maximum_lot !== undefined && volume > Number(symbol.maximum_lot)) {
    throw new Error(`Maximum lot size is ${symbol.maximum_lot}`);
  }

  if (phaseMaxLotSize !== null && phaseMaxLotSize !== undefined) {
    if (!Number.isFinite(Number(phaseMaxLotSize)) || Number(phaseMaxLotSize) <= 0) {
      throw new Error("Phase maximum lot size is invalid");
    }
    if (volume > Number(phaseMaxLotSize)) {
      throw new Error(`Maximum lot size is ${phaseMaxLotSize}`);
    }
  }
}

function snapshotSymbolCalculationMetadata(symbol) {
  return {
    base_currency: symbol.base_currency,
    quote_currency: symbol.quote_currency,
    volume_unit: symbol.volume_unit,
    contract_size: Number(symbol.contract_size),
    price_decimals: Number(symbol.price_decimals),
    pip_size: Number(symbol.pip_size),
    lot_step: Number(symbol.lot_step),
    minimum_lot: Number(symbol.minimum_lot),
    maximum_lot: symbol.maximum_lot === null || symbol.maximum_lot === undefined
      ? null
      : Number(symbol.maximum_lot),
  };
}

function positionDisplayMetadata(metadata) {
  return {
    base_currency: metadata.base_currency,
    quote_currency: metadata.quote_currency,
    contract_size: Number(metadata.contract_size),
    price_decimals: Number(metadata.price_decimals),
    pip_size: Number(metadata.pip_size),
  };
}

function calculatePnlUsd(position, price, symbolMetadata) {
  const currentPrice = validatePositiveNumber(price, "price");
  const openPrice = validatePositiveNumber(position.open_price, "open_price");
  const volume = validatePositiveNumber(position.volume, "volume");
  const metadataError = getSymbolConfigurationError({
    ...symbolMetadata,
    trading_enabled: 1,
  });

  if (metadataError) {
    throw new Error(metadataError);
  }

  if (!["BUY", "SELL"].includes(position.side)) {
    throw new Error("Position side must be BUY or SELL");
  }

  const direction = position.side === "BUY" ? 1 : -1;
  const quotePnl = direction * (currentPrice - openPrice) * volume * Number(symbolMetadata.contract_size);
  const quoteCurrency = symbolMetadata.quote_currency.toUpperCase();

  if (quoteCurrency === "USD") {
    return quotePnl;
  }

  if (
    symbolMetadata.base_currency.toUpperCase() === "USD" &&
    ["JPY", "CHF", "CAD"].includes(quoteCurrency)
  ) {
    return quotePnl / currentPrice;
  }

  throw new Error(`USD conversion is not configured for ${symbolMetadata.base_currency}/${quoteCurrency}`);
}

async function getPositionCalculationSnapshot(env, positionId) {
  const snapshot = await env.daily_funded_trading_db
    .prepare(`
      SELECT metadata_json
      FROM position_calculation_snapshots
      WHERE position_id = ?
    `)
    .bind(positionId)
    .first();

  if (!snapshot || typeof snapshot.metadata_json !== "string") {
    throw new Error("Position calculation snapshot is unavailable");
  }

  const metadata = parseJsonObject(snapshot.metadata_json);
  const metadataError = getSymbolConfigurationError({ ...metadata, trading_enabled: 1 });
  if (metadataError) {
    throw new Error(metadataError);
  }

  return metadata;
}

async function calculateOpenPositionsPnlUsd(env, accountId, priceOverrides = {}, excludedPositionId = null) {
  const result = await env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM positions
      WHERE account_id = ? AND status = 'open'
    `)
    .bind(accountId)
    .all();

  let total = 0;
  for (const position of result.results || []) {
    if (position.id === excludedPositionId) continue;
    const metadata = await getPositionCalculationSnapshot(env, position.id);
    const markedPrice = Object.hasOwn(priceOverrides, position.id)
      ? priceOverrides[position.id]
      : position.current_price;
    total += calculatePnlUsd(position, markedPrice, metadata);
  }

  if (!Number.isFinite(total)) {
    throw new Error("Open-position P&L is invalid");
  }

  return total;
}

function validateDrawdownType(value, fallback = "STATIC") {
  const normalized = normalizeText(value, fallback).toUpperCase();

  if (!["STATIC", "TRAILING"].includes(normalized)) {
    throw new Error("drawdown type must be STATIC or TRAILING");
  }

  return normalized;
}

function validateDailyDrawdownType(
  value,
  fallback = "START_OF_DAY_EQUITY"
) {
  const normalized = normalizeText(value, fallback).toUpperCase();

  const allowed = [
    "START_OF_DAY_BALANCE",
    "START_OF_DAY_EQUITY",
    "HIGH_WATER_MARK",
  ];

  if (!allowed.includes(normalized)) {
    throw new Error(
      "daily drawdown type must be START_OF_DAY_BALANCE, START_OF_DAY_EQUITY or HIGH_WATER_MARK"
    );
  }

  return normalized;
}

async function getModel(env, modelId) {
  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_models
      WHERE id = ?
    `)
    .bind(modelId)
    .first();
}

async function getPhase(env, phaseId) {
  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_model_phases
      WHERE id = ?
    `)
    .bind(phaseId)
    .first();
}

async function getSize(env, sizeId) {
  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_model_sizes
      WHERE id = ?
    `)
    .bind(sizeId)
    .first();
}

function getProvisioningToken(env) {
  if (!env) {
    return "";
  }

  const token =
    env.PROVISIONING_TOKEN ??
    env.WORKER_PROVISIONING_TOKEN ??
    env.PROVISIONING_SECRET ??
    env.PROV_TOKEN;

  return typeof token === "string" ? token : "";
}

function getRequestProvisioningToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization.trim());

  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  const headerValue =
    request.headers.get("x-provisioning-token") ??
    request.headers.get("X-Provisioning-Token") ??
    "";

  return headerValue.trim();
}

function hasValidProvisioningToken(request, env) {
  const expected = getProvisioningToken(env);
  const received = getRequestProvisioningToken(request);

  if (!expected) {
    return false;
  }

  return received === expected;
}

async function findAccountByPurchaseId(env, purchaseId) {
  if (!purchaseId) {
    return null;
  }

  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM trading_accounts
      WHERE purchase_id = ?
      LIMIT 1
    `)
    .bind(purchaseId)
    .first();
}

function parseJsonObject(value) {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  const parsed = typeof value === "string" ? JSON.parse(value) : value;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Configuration JSON must contain an object");
  }

  return parsed;
}

function getRuleSnapshotValidationError(rules) {
  if (rules.profit_target_percent === undefined) {
    return "profit_target_percent is missing from the account rule snapshot";
  }

  if (
    rules.profit_target_percent !== null &&
    (!Number.isFinite(Number(rules.profit_target_percent)) ||
      Number(rules.profit_target_percent) < 0)
  ) {
    return "profit_target_percent is invalid in the account rule snapshot";
  }

  for (const field of ["daily_drawdown_percent", "max_drawdown_percent"]) {
    if (
      rules[field] === undefined ||
      rules[field] === null ||
      !Number.isFinite(Number(rules[field])) ||
      Number(rules[field]) < 0
    ) {
      return `${field} is missing or invalid in the account rule snapshot`;
    }
  }

  if (
    rules.minimum_trading_days === undefined ||
    rules.minimum_trading_days === null ||
    !Number.isInteger(Number(rules.minimum_trading_days)) ||
    Number(rules.minimum_trading_days) < 0
  ) {
    return "minimum_trading_days is missing or invalid in the account rule snapshot";
  }

  if (
    rules.profit_split_percent === undefined ||
    rules.profit_split_percent === null ||
    !Number.isFinite(Number(rules.profit_split_percent)) ||
    Number(rules.profit_split_percent) < 0
  ) {
    return "profit_split_percent is missing or invalid in the account rule snapshot";
  }

  try {
    validateDrawdownType(rules.max_drawdown_type);
    validateDailyDrawdownType(rules.daily_drawdown_type);
  } catch (error) {
    return error.message;
  }

  if (rules.allowed_symbols_json === null || rules.allowed_symbols_json === undefined) {
    return null;
  }

  if (typeof rules.allowed_symbols_json !== "string") {
    return "allowed_symbols_json must be JSON text";
  }

  try {
    if (!Array.isArray(JSON.parse(rules.allowed_symbols_json))) {
      return "allowed_symbols_json must contain an array";
    }
  } catch {
    return "allowed_symbols_json is invalid in the account rule snapshot";
  }

  return null;
}

async function getAccountRuleContext(env, accountId, ownerUserId = null) {
  const accountQuery = env.daily_funded_trading_db.prepare(`
    SELECT *
    FROM trading_accounts
    WHERE id = ?
    ${ownerUserId === null ? "" : "AND user_id = ?"}
  `);
  const account = await (ownerUserId === null
    ? accountQuery.bind(accountId)
    : accountQuery.bind(accountId, ownerUserId)
  ).first();

  if (!account) {
    return { error: "Trading account not found", status: 404 };
  }

  const snapshot = await env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM account_rule_snapshots
      WHERE account_id = ?
      LIMIT 1
    `)
    .bind(accountId)
    .first();

  if (!snapshot) {
    return {
      error: "Trading rules are not configured for this account",
      status: 400,
    };
  }

  const currentPhaseNumber = Number(account.phase_number);

  if (!Number.isInteger(currentPhaseNumber) || currentPhaseNumber <= 0) {
    return { error: "Trading account phase is invalid", status: 400 };
  }

  let configuration;

  try {
    configuration = parseJsonObject(snapshot.custom_rules_json);
  } catch {
    return { error: "Account rule snapshot configuration is invalid", status: 500 };
  }

  if (!Array.isArray(configuration.phases)) {
    if (Number(snapshot.phase_number) !== currentPhaseNumber) {
      return {
        error: "Account snapshot does not contain rules for its current phase",
        status: 400,
      };
    }

    const validationError = getRuleSnapshotValidationError(snapshot);

    if (validationError) {
      return { error: validationError, status: 400 };
    }

    return { account, snapshot, rules: snapshot };
  }

  const phase = configuration.phases.find(
    (candidate) => Number(candidate.phase_number) === currentPhaseNumber
  );

  if (!phase || phase.model_id !== snapshot.model_id) {
    return {
      error: "Account snapshot does not contain rules for its current phase",
      status: 400,
    };
  }

  let phaseCustomRules;

  try {
    phaseCustomRules = parseJsonObject(phase.custom_rules_json);
  } catch {
    return { error: "Account phase configuration is invalid", status: 500 };
  }

  const rules = {
    ...snapshot,
    ...phase,
    id: snapshot.id,
    account_id: snapshot.account_id,
    model_id: snapshot.model_id,
    phase_id: phase.id,
    size_id: snapshot.size_id,
    phase_number: currentPhaseNumber,
    custom_rules_json: JSON.stringify({
      model: configuration.model || {},
      phase: phaseCustomRules,
      size: configuration.size || {},
    }),
  };

  const validationError = getRuleSnapshotValidationError(rules);

  if (validationError) {
    return { error: validationError, status: 400 };
  }

  return { account, snapshot, rules };
}

async function timingSafeTokenMatches(received, expected) {
  const encoder = new TextEncoder();
  const [receivedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const receivedBytes = new Uint8Array(receivedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = received.length ^ expected.length;

  for (let index = 0; index < receivedBytes.length; index += 1) {
    difference |= receivedBytes[index] ^ expectedBytes[index];
  }

  return difference === 0;
}

async function authenticateTradingRequest(request, env) {
  const expectedToken = typeof env?.CLOUDFLARE_TRADING_API_TOKEN === "string"
    ? env.CLOUDFLARE_TRADING_API_TOKEN.trim()
    : "";
  if (!expectedToken) {
    return {
      response: json({ success: false, error: "Trading API authentication is unavailable" }, 503),
    };
  }

  const authorization = request.headers.get("Authorization") || "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!bearerMatch || !(await timingSafeTokenMatches(bearerMatch[1].trim(), expectedToken))) {
    return {
      response: json({ success: false, error: "Trading API authentication is required" }, 401),
    };
  }

  const userId = request.headers.get("X-Authenticated-User-Uid")?.trim();
  if (!userId) {
    return {
      response: json({ success: false, error: "Authenticated user identity is required" }, 401),
    };
  }

  return { userId };
}

async function findAccountForUser(env, accountId, userId) {
  return env.daily_funded_trading_db
    .prepare(`
      SELECT id
      FROM trading_accounts
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `)
    .bind(accountId, userId)
    .first();
}

function planCodeForKey(planKey) {
  const normalizedPlanKey = normalizeText(planKey, "").toLowerCase();
  const planCodeMap = {
    "1step": "1_STEP",
    "2step": "2_STEP",
    instant: "INSTANT",
  };

  return planCodeMap[normalizedPlanKey] || null;
}

function accountMatchesProvisioningRequest(account, userId, purchaseId, modelCode, size) {
  return account.user_id === userId &&
    account.purchase_id === purchaseId &&
    account.challenge_model === modelCode &&
    Number(account.challenge_size) === Number(size);
}

async function resolveActiveModelForPlan(env, planKey) {
  const planCode = planCodeForKey(planKey);

  if (!planCode) {
    return null;
  }

  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_models
      WHERE code = ?
        AND status = 'active'
      LIMIT 1
    `)
    .bind(planCode)
    .first();
}

async function resolveActivePhaseForModel(env, modelId, phaseNumber) {
  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_model_phases
      WHERE model_id = ?
        AND phase_number = ?
        AND status = 'active'
      LIMIT 1
    `)
    .bind(modelId, Number(phaseNumber))
    .first();
}

async function resolveActiveSizeForModel(env, modelId, accountSize) {
  const size = Number(accountSize);

  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  return env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_model_sizes
      WHERE model_id = ?
        AND size = ?
        AND status = 'active'
      LIMIT 1
    `)
    .bind(modelId, size)
    .first();
}

async function getActivePhasesForModel(env, modelId) {
  const result = await env.daily_funded_trading_db
    .prepare(`
      SELECT *
      FROM challenge_model_phases
      WHERE model_id = ?
        AND status = 'active'
      ORDER BY phase_number ASC
    `)
    .bind(modelId)
    .all();

  return result.results || [];
}

function hasValidPhaseProgression(phases) {
  const phaseNumbers = new Set(phases.map((phase) => Number(phase.phase_number)));

  return phases.every((phase) =>
    phase.next_phase_number === null ||
    phase.next_phase_number === undefined ||
    phaseNumbers.has(Number(phase.next_phase_number))
  );
}

function getPhaseConfigurationError(phase) {
  if (phase.profit_target_percent === undefined) {
    return "profit_target_percent is missing from an active phase";
  }

  if (
    phase.profit_target_percent !== null &&
    (!Number.isFinite(Number(phase.profit_target_percent)) ||
      Number(phase.profit_target_percent) < 0)
  ) {
    return "profit_target_percent is invalid in an active phase";
  }

  for (const field of ["daily_drawdown_percent", "max_drawdown_percent"]) {
    if (
      phase[field] === undefined ||
      phase[field] === null ||
      !Number.isFinite(Number(phase[field])) ||
      Number(phase[field]) < 0
    ) {
      return `${field} is missing or invalid in an active phase`;
    }
  }

  if (
    phase.minimum_trading_days === undefined ||
    phase.minimum_trading_days === null ||
    !Number.isInteger(Number(phase.minimum_trading_days)) ||
    Number(phase.minimum_trading_days) < 0
  ) {
    return "minimum_trading_days is missing or invalid in an active phase";
  }

  try {
    validateDrawdownType(phase.max_drawdown_type);
    validateDailyDrawdownType(phase.daily_drawdown_type);
    parseJsonObject(phase.custom_rules_json);
  } catch (error) {
    return error.message;
  }

  return null;
}

async function createAccountAndRuleSnapshot(
  env,
  accountData,
  model,
  phases,
  size
) {
  const accountId = generateId("ACC");
  const snapshotId = generateId("RULE");
  const initialPhase = phases.find((phase) => Number(phase.phase_number) === 1);

  if (!initialPhase) {
    throw new Error("An active phase 1 is required to provision an account");
  }

  // trading_accounts keeps a NOT NULL legacy mirror; the snapshot retains NULL for no target.
  const accountProfitTarget =
    initialPhase.profit_target_percent === null
      ? 0
      : initialPhase.profit_target_percent;

  const accountInsert = env.daily_funded_trading_db
    .prepare(`
      INSERT INTO trading_accounts (
        id,
        user_id,
        purchase_id,
        challenge_model,
        phase_number,
        challenge_size,
        starting_balance,
        balance,
        equity,
        profit_target_percent,
        daily_drawdown_percent,
        max_drawdown_percent,
        minimum_trading_days,
        maximum_trading_days,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      accountId,
      accountData.user_id,
      accountData.purchase_id,
      model.code,
      initialPhase.phase_number,
      size.size,
      size.size,
      size.size,
      size.size,
      accountProfitTarget,
      initialPhase.daily_drawdown_percent,
      initialPhase.max_drawdown_percent,
      initialPhase.minimum_trading_days,
      initialPhase.maximum_trading_days,
      "active"
    );

  const snapshotInsert = env.daily_funded_trading_db
    .prepare(`
      INSERT INTO account_rule_snapshots (
        id,
        account_id,
        model_id,
        phase_id,
        size_id,
        model_code,
        model_name,
        phase_number,
        phase_name,
        challenge_size,
        currency,
        leverage,
        profit_target_percent,
        daily_drawdown_percent,
        max_drawdown_percent,
        max_drawdown_type,
        daily_drawdown_type,
        minimum_trading_days,
        maximum_trading_days,
        minimum_profitable_days,
        max_lot_size,
        max_open_positions,
        max_trades_per_day,
        max_risk_per_trade_percent,
        max_daily_risk_percent,
        max_exposure_percent,
        stop_loss_required,
        take_profit_required,
        weekend_holding_allowed,
        overnight_holding_allowed,
        news_trading_allowed,
        ea_allowed,
        allowed_symbols_json,
        allowed_categories_json,
        profit_split_percent,
        minimum_payout,
        maximum_payout,
        payout_frequency,
        payout_waiting_period_days,
        pass_rule,
        fail_rule,
        custom_rules_json,
        high_water_mark,
        starting_day_balance,
        starting_day_equity
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    .bind(
      snapshotId,
      accountId,
      model.id,
      initialPhase.id,
      size.id,
      model.code,
      model.name,
      initialPhase.phase_number,
      initialPhase.phase_name,
      size.size,
      model.currency,
      model.leverage,
      initialPhase.profit_target_percent,
      initialPhase.daily_drawdown_percent,
      initialPhase.max_drawdown_percent,
      initialPhase.max_drawdown_type,
      initialPhase.daily_drawdown_type,
      initialPhase.minimum_trading_days,
      initialPhase.maximum_trading_days,
      initialPhase.minimum_profitable_days,
      initialPhase.max_lot_size,
      initialPhase.max_open_positions,
      initialPhase.max_trades_per_day,
      initialPhase.max_risk_per_trade_percent,
      initialPhase.max_daily_risk_percent,
      initialPhase.max_exposure_percent,
      initialPhase.stop_loss_required,
      initialPhase.take_profit_required,
      initialPhase.weekend_holding_allowed,
      initialPhase.overnight_holding_allowed,
      initialPhase.news_trading_allowed,
      initialPhase.ea_allowed,
      initialPhase.allowed_symbols_json,
      initialPhase.allowed_categories_json,
      model.profit_split_percent,
      model.minimum_payout,
      model.maximum_payout,
      model.payout_frequency,
      model.payout_waiting_period_days,
      initialPhase.pass_rule,
      initialPhase.fail_rule,
      JSON.stringify({
        model: parseJsonObject(model.custom_rules_json),
        phases: phases.map((phase) => ({
          ...phase,
          custom_rules_json: parseJsonObject(phase.custom_rules_json),
        })),
        size: parseJsonObject(size.custom_rules_json),
      }),
      size.size,
      size.size,
      size.size
    );

  try {
    await env.daily_funded_trading_db.batch([accountInsert, snapshotInsert]);
    return { accountId, snapshotId };
  } catch (error) {
    const existing = await findAccountByPurchaseId(env, accountData.purchase_id);
    if (existing) {
      return { accountId: existing.id, snapshotId: null, existing };
    }
    throw error;
  }
}

async function createRuleSnapshot(
  env,
  accountId,
  model,
  phase,
  size
) {
  const snapshotId = generateId("RULE");

  await env.daily_funded_trading_db
    .prepare(`
      INSERT INTO account_rule_snapshots (
        id,
        account_id,
        model_id,
        phase_id,
        size_id,
        model_code,
        model_name,
        phase_number,
        phase_name,
        challenge_size,
        currency,
        leverage,
        profit_target_percent,
        daily_drawdown_percent,
        max_drawdown_percent,
        max_drawdown_type,
        daily_drawdown_type,
        minimum_trading_days,
        maximum_trading_days,
        minimum_profitable_days,
        max_lot_size,
        max_open_positions,
        max_trades_per_day,
        max_risk_per_trade_percent,
        max_daily_risk_percent,
        max_exposure_percent,
        stop_loss_required,
        take_profit_required,
        weekend_holding_allowed,
        overnight_holding_allowed,
        news_trading_allowed,
        ea_allowed,
        allowed_symbols_json,
        allowed_categories_json,
        profit_split_percent,
        minimum_payout,
        maximum_payout,
        payout_frequency,
        payout_waiting_period_days,
        pass_rule,
        fail_rule,
        custom_rules_json,
        high_water_mark,
        starting_day_balance,
        starting_day_equity
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    .bind(
      snapshotId,
      accountId,
      model.id,
      phase.id,
      size.id,
      model.code,
      model.name,
      phase.phase_number,
      phase.phase_name,
      size.size,
      model.currency,
      model.leverage,
      phase.profit_target_percent,
      phase.daily_drawdown_percent,
      phase.max_drawdown_percent,
      phase.max_drawdown_type,
      phase.daily_drawdown_type,
      phase.minimum_trading_days,
      phase.maximum_trading_days,
      phase.minimum_profitable_days,
      phase.max_lot_size,
      phase.max_open_positions,
      phase.max_trades_per_day,
      phase.max_risk_per_trade_percent,
      phase.max_daily_risk_percent,
      phase.max_exposure_percent,
      phase.stop_loss_required,
      phase.take_profit_required,
      phase.weekend_holding_allowed,
      phase.overnight_holding_allowed,
      phase.news_trading_allowed,
      phase.ea_allowed,
      phase.allowed_symbols_json,
      phase.allowed_categories_json,
      model.profit_split_percent,
      model.minimum_payout,
      model.maximum_payout,
      model.payout_frequency,
      model.payout_waiting_period_days,
      phase.pass_rule,
      phase.fail_rule,
      JSON.stringify({
        model: model.custom_rules_json
          ? JSON.parse(model.custom_rules_json)
          : {},
        phase: phase.custom_rules_json
          ? JSON.parse(phase.custom_rules_json)
          : {},
        size: size.custom_rules_json
          ? JSON.parse(size.custom_rules_json)
          : {},
      }),
      size.size,
      size.size,
      size.size
    )
    .run();

  return snapshotId;
}

const MARKET_DATA_MAX_AGE_MS = 5 * 60 * 1000;
const MARKET_DATA_CACHE_TTL_SECONDS = 5;
const MARKET_FEED_ALARM_MS = 60 * 1000;
const MARKET_FEED_REFRESH_MS = 10 * 60 * 1000;
const MARKET_FEED_HEALTH_TIMEOUT_MS = 45 * 1000;
const MARKET_FEED_SYMBOL_TICK_TIMEOUT_MS = 15 * 1000;
const MARKET_FEED_FAILURE_REASONS = new Set([
  "biquote_negotiation_failed",
  "websocket_upgrade_failed",
  "signalr_handshake_failed",
  "subscription_failed",
  "feed_not_connected",
]);
const MARKET_FEED_FAILURE_MESSAGES = {
  biquote_negotiation_failed: "Biquote negotiation failed",
  websocket_upgrade_failed: "Biquote WebSocket upgrade failed",
  signalr_handshake_failed: "Biquote SignalR handshake failed",
  subscription_failed: "Biquote subscription failed",
  feed_not_connected: "Biquote feed is not connected",
};
const MARKET_CANDLE_INTERVALS = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const workerCandleBuckets = new Map();

function parseProviderTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    return number < 1_000_000_000_000 ? number * 1000 : number;
  }

  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  return null;
}

function optionalPositivePrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Provider returned an invalid price");
  }
  return price;
}

function normalizeProviderQuote({
  symbol,
  provider,
  payload,
  receivedAt = Date.now(),
  fallbackPrice = null,
  providerStale = false,
  quoteAgeSeconds = null,
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Provider returned a malformed quote");
  }

  const bid = optionalPositivePrice(payload.bid);
  const ask = optionalPositivePrice(payload.ask);
  if (bid !== null && ask !== null && ask < bid) {
    throw new Error("Provider returned an invalid bid/ask spread");
  }

  let mid = optionalPositivePrice(payload.mid);
  if (mid === null && bid !== null && ask !== null) {
    mid = (bid + ask) / 2;
  }
  if (mid === null) {
    mid = optionalPositivePrice(fallbackPrice);
  }
  if (mid === null) {
    throw new Error("Provider returned no usable price");
  }

  const providerTimestamp = parseProviderTimestamp(payload.timestamp ?? payload.datetime);
  const ageMs = providerTimestamp === null ? null : receivedAt - providerTimestamp;
  const reportedAgeMs = quoteAgeSeconds !== null && quoteAgeSeconds !== undefined &&
    Number.isFinite(Number(quoteAgeSeconds))
    ? Number(quoteAgeSeconds) * 1000
    : null;
  const stale = Boolean(providerStale) ||
    providerTimestamp === null ||
    ageMs > MARKET_DATA_MAX_AGE_MS ||
    ageMs < -60_000 ||
    (reportedAgeMs !== null && reportedAgeMs > MARKET_DATA_MAX_AGE_MS);

  return {
    symbol,
    provider,
    bid,
    ask,
    mid,
    timestamp: providerTimestamp === null ? null : new Date(providerTimestamp).toISOString(),
    received_at: new Date(receivedAt).toISOString(),
    stale,
    age_seconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
    ...(payload.marketState ? { market_state: String(payload.marketState) } : {}),
  };
}

async function fetchBiquoteQuotes(symbolRecords) {
  const providerUrl = new URL("https://biquote.io/api/latest");
  for (const symbolRecord of symbolRecords) {
    providerUrl.searchParams.append("symbols", symbolRecord.provider_symbol);
  }

  let response;
  try {
    response = await fetch(providerUrl, { signal: AbortSignal.timeout(5000) });
  } catch {
    return new Map(symbolRecords.map((record) => [record.symbol, {
      error: "provider_unreachable",
      status: 502,
    }]));
  }

  if (!response.ok) {
    return new Map(symbolRecords.map((record) => [record.symbol, {
      error: "provider_http_error",
      status: 502,
    }]));
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return new Map(symbolRecords.map((record) => [record.symbol, {
      error: "provider_invalid_json",
      status: 502,
    }]));
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new Map(symbolRecords.map((record) => [record.symbol, {
      error: "provider_invalid_response",
      status: 502,
    }]));
  }

  const receivedAt = Date.now();
  return new Map(symbolRecords.map((record) => {
    const providerQuote = payload[record.provider_symbol] ?? payload.data?.[record.provider_symbol];
    if (!providerQuote) {
      return [record.symbol, { error: "provider_quote_unavailable", status: 502 }];
    }

    try {
      return [record.symbol, {
        quote: normalizeProviderQuote({
          symbol: record.symbol,
          provider: "biquote",
          payload: providerQuote,
          providerStale: providerQuote.stale,
          quoteAgeSeconds: providerQuote.quoteAgeSeconds,
        }),
      }];
    } catch {
      return [record.symbol, { error: "provider_invalid_quote", status: 502 }];
    }
  }));
}

function refreshQuoteFreshness(quote, now = Date.now()) {
  const timestamp = parseProviderTimestamp(quote.timestamp);
  const ageMs = timestamp === null ? null : now - timestamp;
  return {
    ...quote,
    stale: Boolean(quote.stale) ||
      ageMs === null ||
      ageMs > MARKET_DATA_MAX_AGE_MS ||
      ageMs < -60_000,
    age_seconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
  };
}

async function persistWorkerCandle(env, bucket) {
  try {
    await env.daily_funded_trading_db.prepare(`
      INSERT INTO market_candles (
        symbol, interval, open_time, open, high, low, close, volume, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'worker_generated')
      ON CONFLICT(symbol, interval, open_time) DO NOTHING
    `).bind(
      bucket.symbol,
      bucket.interval,
      new Date(bucket.openTime).toISOString(),
      bucket.open,
      bucket.high,
      bucket.low,
      bucket.close
    ).run();
  } catch {
    // Quote delivery remains available if optional candle persistence fails.
  }
}

async function addQuoteToCandleBuilder(env, quote) {
  if (quote.stale || !Number.isFinite(quote.mid) || !quote.timestamp) return;
  const tickTime = Date.parse(quote.timestamp);
  if (!Number.isFinite(tickTime)) return;

  for (const [interval, duration] of Object.entries(MARKET_CANDLE_INTERVALS)) {
    const openTime = Math.floor(tickTime / duration) * duration;
    const key = `${quote.symbol}:${interval}`;
    const existing = workerCandleBuckets.get(key);

    if (!existing || openTime > existing.openTime) {
      if (existing) await persistWorkerCandle(env, existing);
      workerCandleBuckets.set(key, {
        symbol: quote.symbol,
        interval,
        openTime,
        open: quote.mid,
        high: quote.mid,
        low: quote.mid,
        close: quote.mid,
      });
      continue;
    }

    if (openTime === existing.openTime) {
      existing.high = Math.max(existing.high, quote.mid);
      existing.low = Math.min(existing.low, quote.mid);
      existing.close = quote.mid;
    }
  }
}

async function getConfiguredMarketSymbols(env) {
  const result = await env.daily_funded_trading_db.prepare(`
    SELECT symbol, display_name, category, provider, provider_symbol
    FROM trading_symbols
    WHERE market_data_enabled = 1
      AND provider IS NOT NULL
      AND provider_symbol IS NOT NULL
    ORDER BY symbol
  `).all();
  return (result.results || []).map((record) => record.symbol === "XAUUSD"
    ? { ...record, provider: "biquote", provider_symbol: "XAUUSD" }
    : record);
}

function parseRequestedMarketSymbols(url) {
  const rawSymbols = url.searchParams.getAll("symbols").flatMap((value) => value.split(","));
  const symbols = rawSymbols.map((value) => value.trim().toUpperCase());
  if (!symbols.length || symbols.some((symbol) => !/^[A-Z0-9]{3,12}$/.test(symbol))) {
    return { error: "symbols must contain comma-separated canonical symbols" };
  }
  return { symbols: [...new Set(symbols)] };
}

function marketQuoteCacheKey(request, symbols) {
  const url = new URL(request.url);
  return new Request(`${url.origin}/__market-cache/quotes?symbols=${encodeURIComponent([...symbols].sort().join(","))}`);
}

async function getMarketQuotes(request, env, url) {
  const parsed = parseRequestedMarketSymbols(url);
  if (parsed.error) return json({ success: false, error: parsed.error }, 400);

  const symbolRecords = await getConfiguredMarketSymbols(env);
  const recordsBySymbol = new Map(symbolRecords.map((record) => [record.symbol, record]));
  const unknownSymbols = parsed.symbols.filter((symbol) => !recordsBySymbol.has(symbol));
  if (unknownSymbols.length) {
    return json({ success: false, error: "Unknown or disabled market symbols", symbols: unknownSymbols }, 400);
  }

  const cache = globalThis.caches?.default;
  const cacheKey = marketQuoteCacheKey(request, parsed.symbols);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const payload = await cached.json();
        payload.quotes = payload.quotes.map((quote) => refreshQuoteFreshness(quote));
        return json(payload);
      }
    } catch {
      // Cache is an optimization; provider reads remain the source of truth.
    }
  }

  const records = parsed.symbols.map((symbol) => recordsBySymbol.get(symbol));
  const biquoteRecords = records.filter((record) => record.provider === "biquote");
  const resultBySymbol = new Map();
  if (biquoteRecords.length) {
    for (const [symbol, result] of await fetchBiquoteQuotes(biquoteRecords)) {
      resultBySymbol.set(symbol, result);
    }
  }

  const quotes = [];
  const errors = [];
  for (const record of records) {
    const result = resultBySymbol.get(record.symbol);
    if (result?.quote) {
      quotes.push(result.quote);
      await addQuoteToCandleBuilder(env, result.quote);
    } else {
      errors.push({
        symbol: record.symbol,
        provider: record.provider,
        status: "unavailable",
        code: result?.error || "provider_not_configured",
      });
    }
  }

  const payload = {
    success: errors.length === 0,
    partial: quotes.length > 0 && errors.length > 0,
    requested_symbols: parsed.symbols,
    quotes,
    errors,
    cache_ttl_seconds: MARKET_DATA_CACHE_TTL_SECONDS,
  };
  const status = quotes.length === 0 && errors.length > 0 ? 502 : 200;
  const response = json(payload, status);
  response.headers.set("Cache-Control", status === 200 ? `public, max-age=${MARKET_DATA_CACHE_TTL_SECONDS}` : "no-store");

  if (cache && status === 200 && errors.length === 0 && quotes.every((quote) => !quote.stale)) {
    try {
      await cache.put(cacheKey, response.clone());
    } catch {
      // A cache write failure must not fail the market-data request.
    }
  }

  return response;
}

function normalizeProviderCandle(symbol, interval, bar) {
  const openTime = parseProviderTimestamp(bar?.openTime ?? bar?.open_time);
  const prices = [bar?.open, bar?.high, bar?.low, bar?.close].map(Number);
  if (
    openTime === null ||
    prices.some((price) => !Number.isFinite(price) || price <= 0) ||
    prices[1] < Math.max(prices[0], prices[3]) ||
    prices[2] > Math.min(prices[0], prices[3])
  ) {
    throw new Error("Provider returned an invalid candle");
  }

  return {
    symbol,
    interval,
    open_time: new Date(openTime).toISOString(),
    open: prices[0],
    high: prices[1],
    low: prices[2],
    close: prices[3],
    volume: null,
    source: "provider_historical",
    is_open: Boolean(bar.isOpen),
  };
}

function parseOptionalCandleDateTime(value, field) {
  if (value === null) return { value: null };
  const match = typeof value === "string"
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/)
    : null;
  if (!match) return { error: `${field} must be an ISO 8601 timestamp with a timezone` };

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, zone] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59
  ) return { error: `${field} must be a valid ISO 8601 timestamp` };
  if (zone !== "Z") {
    const [, zoneHour, zoneMinute] = zone.match(/^[+-](\d{2}):(\d{2})$/) || [];
    if (Number(zoneHour) > 23 || Number(zoneMinute) > 59) {
      return { error: `${field} must be a valid ISO 8601 timestamp` };
    }
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { error: `${field} must be a valid ISO 8601 timestamp` };
  return { value: new Date(timestamp).toISOString(), timestamp };
}

async function getMarketQuotesForSymbols(env, symbols) {
  if (!symbols.length) return { quotes: [], errors: [] };
  const url = new URL("https://internal.dailyfunded/market/quotes");
  url.searchParams.set("symbols", [...new Set(symbols)].join(","));
  const response = await getMarketQuotes(new Request(url), env, url);
  const payload = await response.json();
  return { ...payload, status: response.status };
}

async function requireExecutionQuote(env, symbol, side) {
  const payload = await getMarketQuotesForSymbols(env, [symbol]);
  const quote = payload.quotes?.find((item) => item.symbol === symbol);
  if (!quote) {
    throw Object.assign(new Error("Market data is unavailable for this symbol"), {
      code: "market_unavailable",
      status: 503,
    });
  }
  if (quote.stale || quote.market_state?.toLowerCase() === "closed") {
    throw Object.assign(new Error("The market quote is stale or the market is closed"), {
      code: "stale_quote",
      status: 409,
    });
  }
  const price = side === "BUY" ? quote.ask : quote.bid;
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
    throw Object.assign(new Error(`A valid ${side === "BUY" ? "Ask" : "Bid"} quote is unavailable`), {
      code: "market_unavailable",
      status: 503,
    });
  }
  return { price: Number(price), quote };
}

function optionalPositiveNumber(value, field, code) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") {
    throw Object.assign(new Error(`${field} must be a positive number`), { code, status: 400 });
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw Object.assign(new Error(`${field} must be a positive number`), { code, status: 400 });
  }
  return number;
}

function marginForPosition(position, price, metadata, leverage) {
  const baseNotional = Number(position.volume) * Number(metadata.contract_size);
  const baseCurrency = String(metadata.base_currency).toUpperCase();
  const quoteCurrency = String(metadata.quote_currency).toUpperCase();
  if (!Number.isFinite(baseNotional) || baseNotional <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
    throw new Error("Margin requirements are unavailable for this position");
  }
  if (baseCurrency === "USD") return baseNotional / leverage;
  if (quoteCurrency === "USD") return (baseNotional * Number(price)) / leverage;
  throw new Error(`USD margin conversion is not configured for ${baseCurrency}/${quoteCurrency}`);
}

function tradingError(code, message, status) {
  return json({ success: false, code, error: message }, status);
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function eventSigningKey(env) {
  const secret = typeof env.TRADING_EVENTS_SIGNING_SECRET === "string"
    ? env.TRADING_EVENTS_SIGNING_SECRET.trim()
    : "";
  if (secret.length < 32) throw new Error("Trading event signing secret is not configured");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function createEventTicket(env, userId, accountId) {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    user_id: userId,
    account_id: accountId,
    expires_at: Date.now() + 15 * 60 * 1000,
  })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await eventSigningKey(env),
    new TextEncoder().encode(payload)
  );
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyEventTicket(env, ticket) {
  const [payload, signature, extra] = String(ticket || "").split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const key = await eventSigningKey(env);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(payload)
    );
    if (!valid) return null;
    const value = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    if (
      typeof value.user_id !== "string" ||
      typeof value.account_id !== "string" ||
      !Number.isFinite(value.expires_at) ||
      value.expires_at <= Date.now()
    ) return null;
    return value;
  } catch {
    return null;
  }
}

async function sendPositionEvent(env, userId, accountId, event) {
  if (!env.POSITION_EVENTS) throw new Error("Position event delivery is not configured");
  const id = env.POSITION_EVENTS.idFromName(`user:${userId}`);
  const response = await env.POSITION_EVENTS.get(id).fetch("https://position-events/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: accountId, event }),
  });
  if (!response.ok) throw new Error(`Position event delivery failed (${response.status})`);
}

async function publishPositionEvent(env, userId, accountId, event) {
  try {
    await sendPositionEvent(env, userId, accountId, event);
  } catch (error) {
    console.error("Unable to publish authoritative position event:", error);
  }
}

async function withAccountQueue(state, accountId, callback) {
  const key = String(accountId);
  const previous = state.accountQueues?.get(key) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  if (!state.accountQueues) state.accountQueues = new Map();
  state.accountQueues.set(key, queued);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (state.accountQueues.get(key) === queued) state.accountQueues.delete(key);
  }
}

async function settlePosition(env, positionId, userId, {
  source,
  tick,
  reason,
  latestTicks,
} = {}) {
  const db = env.daily_funded_trading_db;
  const position = await db.prepare(`
    SELECT p.*, a.user_id
    FROM positions p
    INNER JOIN trading_accounts a ON a.id = p.account_id
    WHERE p.id = ? AND a.user_id = ? AND p.status = 'open'
  `).bind(positionId, userId).first();
  if (!position) return { error: "position_not_found", status: 404 };
  const accountContext = await getAccountRuleContext(env, position.account_id, userId);
  if (accountContext.error) {
    return { error: "trading_account_not_found", message: accountContext.error, status: accountContext.status };
  }

  let closePrice;
  let protectionReason = null;
  let protectionTickTimestamp = null;
  if (source === "tick") {
    const triggered = triggeredProtection(position, tick);
    if (!triggered || (reason && reason !== triggered.reason)) return { skipped: true };
    closePrice = triggered.price;
    protectionReason = triggered.reason;
    protectionTickTimestamp = new Date(Number(tick.timestamp_ms)).toISOString();
  } else {
    try {
      closePrice = (await requireExecutionQuote(
        env,
        position.symbol,
        position.side === "BUY" ? "SELL" : "BUY"
      )).price;
    } catch (error) {
      return {
        error: error.code || "market_unavailable",
        message: error.message,
        status: error.status || 503,
      };
    }
  }

  let metadata;
  let realizedPnl;
  try {
    metadata = await getPositionCalculationSnapshot(env, position.id);
    realizedPnl = calculatePnlUsd(position, closePrice, metadata);
  } catch (error) {
    return { error: "server_error", message: error.message, status: 500 };
  }

  let remainingFloatingPnl = 0;
  let remainingUsedMargin = 0;
  let marginDataComplete = Number(accountContext.snapshot.leverage) > 0;
  const remainingPositionMarkUpdates = [];
  const remainingResult = await db.prepare(`
    SELECT p.*
    FROM positions p
    WHERE p.account_id = ? AND p.status = 'open' AND p.id != ?
  `).bind(position.account_id, position.id).all();
  const remainingPositions = remainingResult.results || [];

  if (source === "tick") {
    for (const item of remainingPositions) {
      const currentTick = latestTicks?.get(item.symbol);
      const currentMark = currentTick &&
        Date.now() - Number(currentTick.timestamp_ms) <= MARKET_DATA_MAX_AGE_MS &&
        tickIsAfterPositionOpen(item, currentTick)
        ? protectionPrice(item, currentTick)
        : null;
      let markPrice = Number(item.current_price);
      let floatingPnl = Number.isFinite(Number(item.floating_pnl)) ? Number(item.floating_pnl) : 0;
      try {
        const positionMetadata = await getPositionCalculationSnapshot(env, item.id);
        if (currentMark !== null) {
          markPrice = currentMark;
          floatingPnl = calculatePnlUsd(item, currentMark, positionMetadata);
          remainingPositionMarkUpdates.push(db.prepare(`
            UPDATE positions SET current_price = ?, floating_pnl = ?
            WHERE id = ? AND account_id = ? AND status = 'open'
          `).bind(currentMark, floatingPnl, item.id, item.account_id));
        }
        remainingUsedMargin += marginForPosition(
          item, markPrice, positionMetadata, Number(accountContext.snapshot.leverage)
        );
      } catch {
        marginDataComplete = false;
      }
      remainingFloatingPnl += floatingPnl;
    }
  } else {
    const quotes = await getMarketQuotesForSymbols(env, remainingPositions.map((item) => item.symbol));
    const quoteBySymbol = new Map((quotes.quotes || []).map((quote) => [quote.symbol, quote]));
    try {
      for (const remaining of remainingPositions) {
        const quote = quoteBySymbol.get(remaining.symbol);
        const markPrice = remaining.side === "BUY" ? quote?.bid : quote?.ask;
        if (!quote || quote.stale || quote.market_state?.toLowerCase() === "closed" ||
          !Number.isFinite(Number(markPrice)) || Number(markPrice) <= 0) {
          throw new Error("Live market data is required to close this position safely");
        }
        remainingFloatingPnl += calculatePnlUsd(
          remaining,
          markPrice,
          await getPositionCalculationSnapshot(env, remaining.id)
        );
        try {
          remainingUsedMargin += marginForPosition(
            remaining,
            markPrice,
            await getPositionCalculationSnapshot(env, remaining.id),
            Number(accountContext.snapshot.leverage)
          );
        } catch {
          marginDataComplete = false;
        }
      }
    } catch {
      return {
        error: "market_unavailable",
        message: "Live market data is required to close this position safely",
        status: 503,
      };
    }
  }

  const tradeId = generateId("TRD");
  const settlementStatements = [
    db.prepare(`
      UPDATE positions SET status = 'closing'
      WHERE id = ? AND account_id = ? AND status = 'open'
        AND (? != 'tick' OR strftime('%Y-%m-%dT%H:%M:%fZ', opened_at) < ?)
    `).bind(position.id, position.account_id, source, protectionTickTimestamp),
    ...remainingPositionMarkUpdates,
    db.prepare(`
      INSERT INTO trades (
        id, account_id, order_id, symbol, side, volume, open_price, close_price, realized_pnl, opened_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM positions WHERE id = ? AND account_id = ? AND status = 'closing'
      )
    `).bind(
      tradeId, position.account_id, position.order_id, position.symbol, position.side,
      Number(position.volume), Number(position.open_price), closePrice, realizedPnl, position.opened_at,
      position.id, position.account_id
    ),
    db.prepare(`
      UPDATE trading_accounts
      SET balance = balance + ?,
          equity = balance + ? + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND EXISTS (
        SELECT 1 FROM positions WHERE id = ? AND account_id = ? AND status = 'closing'
      )
    `).bind(
      realizedPnl, realizedPnl, remainingFloatingPnl,
      position.account_id, userId, position.id, position.account_id
    ),
    db.prepare(`
      UPDATE orders SET status = 'closed'
      WHERE id = ? AND account_id = ? AND EXISTS (
        SELECT 1 FROM positions WHERE id = ? AND account_id = ? AND status = 'closing'
      )
    `).bind(position.order_id, position.account_id, position.id, position.account_id),
    db.prepare(`
      UPDATE positions
      SET status = 'closed',
          current_price = ?,
          floating_pnl = 0,
          close_price = ?,
          realized_pnl = ?,
          closed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND account_id = ? AND status = 'closing'
    `).bind(closePrice, closePrice, realizedPnl, position.id, position.account_id),
  ];
  const results = await db.batch(settlementStatements);

  if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
    return source === "tick" ? { skipped: true } : { error: "position_not_found", status: 404 };
  }
  const settlementRowsWritten = results.reduce(
    (total, result) => total + Number(result?.meta?.changes || 0),
    0
  );

  const trade = {
    id: tradeId,
    account_id: position.account_id,
    symbol: position.symbol,
    side: position.side,
    volume: Number(position.volume),
    open_price: Number(position.open_price),
    close_price: closePrice,
    realized_pnl: realizedPnl,
    closed_at: new Date().toISOString(),
    ...(protectionReason ? { close_reason: protectionReason } : {}),
  };
  const accountAfterClose = await db.prepare(`
    SELECT balance, equity FROM trading_accounts WHERE id = ? AND user_id = ?
  `).bind(position.account_id, userId).first();
  const account = {
    ...accountContext.account,
    balance: Number(accountAfterClose.balance),
    equity: Number(accountAfterClose.equity),
    open_pnl: remainingFloatingPnl,
    used_margin: marginDataComplete ? remainingUsedMargin : null,
    free_margin: marginDataComplete
      ? Number(accountAfterClose.equity) - remainingUsedMargin
      : null,
    available_margin: marginDataComplete
      ? Number(accountAfterClose.equity) - remainingUsedMargin
      : null,
  };
  const closedPosition = {
    ...position,
    status: "closed",
    close_price: closePrice,
    current_price: closePrice,
    floating_pnl: 0,
  };
  await publishPositionEvent(env, userId, position.account_id, {
    type: "POSITION_CLOSED",
    position_id: position.id,
    account_id: position.account_id,
    position: closedPosition,
    trade,
    account,
  });
  return {
    trade,
    account,
    position: closedPosition,
    _settlementRowsWritten: settlementRowsWritten,
  };
}

function freshProviderTick(tick, now = Date.now()) {
  return Number.isInteger(Number(tick?.timestamp_ms)) &&
    Number(tick.timestamp_ms) > 0 &&
    Number(tick.timestamp_ms) <= now + 60_000 &&
    now - Number(tick.timestamp_ms) <= MARKET_DATA_MAX_AGE_MS &&
    Number.isFinite(Number(tick.bid)) && Number(tick.bid) > 0 &&
    Number.isFinite(Number(tick.ask)) && Number(tick.ask) >= Number(tick.bid);
}

function feedTickFromSignalR(message, providerToCanonical) {
  if (!message || typeof message !== "object") return null;
  const providerSymbol = normalizeText(message.symbol ?? message.Symbol).toUpperCase();
  const symbol = providerToCanonical.get(providerSymbol);
  const timestamp = message.timestamp ?? message.Timestamp ?? message.time ?? message.Time;
  const timestampMs = parseProviderTimestamp(timestamp);
  const bid = numberOrNull(message.bid ?? message.Bid);
  const ask = numberOrNull(message.ask ?? message.Ask);
  if (!symbol || timestampMs === null || bid === null || ask === null) return null;
  return { symbol, provider_symbol: providerSymbol, timestamp_ms: timestampMs, bid, ask };
}

export class MarketFeedDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.positionsById = new Map();
    this.positionIdsBySymbol = new Map();
    this.positionMetadataById = new Map();
    this.pendingSettlements = new Map();
    this.pendingAccountSyncs = new Set();
    this.symbolByProvider = new Map();
    this.symbolRecords = [];
    this.baselineTimestamps = new Map();
    this.latestTicks = new Map();
    this.symbolReadinessWaiters = new Map();
    this.safeAfterTimestamp = new Map();
    this.trustedSymbols = new Set();
    this.connections = new Set();
    this.activeConnection = null;
    this.connectionGeneration = 0;
    this.connecting = null;
    this.nextInvocationId = 1;
    this.initialized = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(() => this.loadInitialState())
      : this.loadInitialState();
    this.metrics = {
      startedAt: Date.now(),
      webSocketMessages: 0,
      reconnects: 0,
      ticksByMinute: new Map(),
      d1PositionLifecycleReads: 0,
      d1SettlementRowsWritten: 0,
      protectionEvaluations: 0,
      protectionTicks: 0,
      protectionLatencyTotalMs: 0,
      protectionLatencyMaxMs: 0,
      lastMetricsLogAt: 0,
    };
  }

  async loadInitialState() {
    const [records, checkpoints] = await Promise.all([
      getConfiguredMarketSymbols(this.env),
      this.state.storage?.get("tick-checkpoints") || Promise.resolve(null),
    ]);
    this.symbolRecords = records.filter((record) => record.provider === "biquote");
    this.symbolByProvider = new Map(this.symbolRecords.map((record) => [
      String(record.provider_symbol).toUpperCase(),
      record.symbol,
    ]));
    for (const [symbol, timestamp] of Object.entries(checkpoints || {})) {
      if (Number.isFinite(Number(timestamp)) && Number(timestamp) > 0) {
        this.safeAfterTimestamp.set(symbol, Number(timestamp));
      }
    }
    const openPositions = await this.env.daily_funded_trading_db.prepare(`
      SELECT p.*, a.user_id, a.balance AS account_balance
      FROM positions p
      INNER JOIN trading_accounts a ON a.id = p.account_id
      WHERE p.status = 'open'
    `).all();
    this.metrics.d1PositionLifecycleReads += 1;
    for (const position of openPositions.results || []) {
      if (this.symbolRecords.some((record) => record.symbol === position.symbol)) {
        this.putPosition(position);
      }
    }
  }

  putPosition(position) {
    this.positionsById.set(position.id, position);
    const ids = this.positionIdsBySymbol.get(position.symbol) || new Set();
    ids.add(position.id);
    this.positionIdsBySymbol.set(position.symbol, ids);
  }

  removePosition(positionId) {
    const position = this.positionsById.get(positionId);
    this.pendingSettlements.delete(positionId);
    this.positionMetadataById.delete(positionId);
    if (!position) return;
    this.positionsById.delete(positionId);
    const ids = this.positionIdsBySymbol.get(position.symbol);
    ids?.delete(positionId);
    if (ids?.size === 0) this.positionIdsBySymbol.delete(position.symbol);
  }

  async refreshAccountPositions(accountId) {
    const result = await this.env.daily_funded_trading_db.prepare(`
      SELECT p.*, a.user_id, a.balance AS account_balance
      FROM positions p
      INNER JOIN trading_accounts a ON a.id = p.account_id
      WHERE p.account_id = ? AND p.status = 'open'
    `).bind(accountId).all();
    this.metrics.d1PositionLifecycleReads += 1;
    for (const position of [...this.positionsById.values()]) {
      if (position.account_id === accountId) this.removePosition(position.id);
    }
    for (const position of result.results || []) {
      if (this.symbolRecords.some((record) => record.symbol === position.symbol)) {
        this.putPosition(position);
      }
    }
    return result.results || [];
  }

  async getPositionMetadata(position) {
    let metadata = this.positionMetadataById.get(position.id);
    if (!metadata) {
      metadata = await getPositionCalculationSnapshot(this.env, position.id);
      this.positionMetadataById.set(position.id, metadata);
    }
    return metadata;
  }

  async publishAccountMarkUpdate(accountId, timestampMs) {
    if (!this.env.POSITION_EVENTS) return;
    const accountPositions = [...this.positionsById.values()].filter(
      (position) => position.account_id === accountId
    );
    if (!accountPositions.length) return;

    let totalFloatingPnl = 0;
    let completeMarketData = true;
    const positions = [];
    for (const position of accountPositions) {
      const tick = this.latestTicks.get(position.symbol);
      const price = protectionPrice(position, tick);
      if (!freshProviderTick(tick) || !tickIsAfterPositionOpen(position, tick) ||
        price === null) {
        completeMarketData = false;
        positions.push({
          id: position.id,
          current_price: null,
          floating_pnl: null,
          market_data_status: "unavailable",
        });
        continue;
      }
      try {
        const floatingPnl = calculatePnlUsd(
          position,
          price,
          await this.getPositionMetadata(position)
        );
        position.current_price = price;
        position.floating_pnl = floatingPnl;
        totalFloatingPnl += floatingPnl;
        positions.push({
          id: position.id,
          current_price: price,
          floating_pnl: floatingPnl,
          market_data_status: "live",
        });
      } catch (error) {
        completeMarketData = false;
        console.error(`Unable to calculate live P/L for position ${position.id}:`, error);
        positions.push({
          id: position.id,
          current_price: null,
          floating_pnl: null,
          market_data_status: "unavailable",
        });
      }
    }

    const balanceValue = accountPositions[0].account_balance;
    const balance = balanceValue === null || balanceValue === undefined || balanceValue === ""
      ? NaN
      : Number(balanceValue);
    const accountIsLive = completeMarketData && Number.isFinite(balance);
    await publishPositionEvent(this.env, accountPositions[0].user_id, accountId, {
      type: "ACCOUNT_MARK_UPDATED",
      account_id: accountId,
      timestamp: new Date(timestampMs).toISOString(),
      positions,
      account: {
        balance: Number.isFinite(balance) ? balance : null,
        open_pnl: accountIsLive ? totalFloatingPnl : null,
        equity: accountIsLive ? balance + totalFloatingPnl : null,
        market_data_status: accountIsLive ? "live" : "unavailable",
      },
    });
  }

  async refreshProviderBaselines() {
    const quotes = await fetchBiquoteQuotes(this.symbolRecords);
    for (const record of this.symbolRecords) {
      const quote = quotes.get(record.symbol)?.quote;
      const timestampMs = quote ? parseProviderTimestamp(quote.timestamp) : null;
      const bid = numberOrNull(quote?.bid);
      const ask = numberOrNull(quote?.ask);
      if (!quote || quote.stale || timestampMs === null ||
        bid === null || bid <= 0 || ask === null || ask < bid) {
        this.trustedSymbols.delete(record.symbol);
        continue;
      }
      const previous = this.safeAfterTimestamp.get(record.symbol) || 0;
      const highWater = Math.max(previous, timestampMs);
      this.safeAfterTimestamp.set(record.symbol, highWater);
      this.baselineTimestamps.set(record.symbol, highWater);
      this.trustedSymbols.add(record.symbol);
    }
  }

  hasFreshSymbolTick(symbol) {
    const baselineTimestamp = this.baselineTimestamps.get(symbol);
    const latestTick = this.latestTicks.get(symbol);
    return this.trustedSymbols.has(symbol) &&
      this.safeAfterTimestamp.has(symbol) &&
      baselineTimestamp !== undefined &&
      freshProviderTick(latestTick) &&
      Number(latestTick.timestamp_ms) > baselineTimestamp;
  }

  waitForFreshSymbolTick(symbol, timeoutMs = MARKET_FEED_SYMBOL_TICK_TIMEOUT_MS) {
    if (this.hasFreshSymbolTick(symbol)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.symbolReadinessWaiters.get(symbol) || new Set();
      let timer;
      const finish = (ready) => {
        clearTimeout(timer);
        waiters.delete(onTick);
        if (waiters.size === 0) this.symbolReadinessWaiters.delete(symbol);
        resolve(ready);
      };
      const onTick = () => {
        if (this.hasFreshSymbolTick(symbol)) finish(true);
      };
      waiters.add(onTick);
      this.symbolReadinessWaiters.set(symbol, waiters);
      timer = setTimeout(() => finish(this.hasFreshSymbolTick(symbol)), timeoutMs);
      onTick();
    });
  }

  async ensureConnection({ refresh = false } = {}) {
    await this.initialized;
    if (this.connecting) return this.connecting;
    if (!refresh && this.activeConnection?.socket.readyState === WebSocket.OPEN) {
      return { connected: true };
    }
    this.connecting = this.openSignalRConnection()
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async openSignalRConnection() {
    const previousConnection = this.activeConnection;
    const generation = ++this.connectionGeneration;
    let candidateConnection = null;
    let failureReason = "feed_not_connected";
    try {
      await this.refreshProviderBaselines();
      failureReason = "biquote_negotiation_failed";
      const { socketUrl } = await negotiateBiquoteSignalR(fetch);
      failureReason = "websocket_upgrade_failed";
      const response = await fetch(socketUrl, {
        headers: { Upgrade: "websocket" },
        signal: AbortSignal.timeout(10_000),
      });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        throw new Error(`Biquote WebSocket upgrade failed (${response.status})`);
      }
      socket.accept();
      const connection = {
        socket,
        generation,
        active: false,
        buffer: "",
        handshakeComplete: false,
        subscriptionInvocationId: `subscribe-${this.nextInvocationId++}`,
        connectedAt: Date.now(),
        lastMessageAt: Date.now(),
        intentionalClose: false,
        ready: null,
        resolveReady: null,
        rejectReady: null,
        failureReason: "signalr_handshake_failed",
      };
      candidateConnection = connection;
      connection.ready = new Promise((resolve, reject) => {
        connection.resolveReady = resolve;
        connection.rejectReady = reject;
      });
      this.connections.add(connection);
      socket.addEventListener("message", (event) => {
        void this.handleSocketMessage(connection, event.data);
      });
      socket.addEventListener("close", () => this.handleSocketClosed(connection, "close"));
      socket.addEventListener("error", () => this.handleSocketClosed(connection, "error"));
      socket.send(signalRRecord({ protocol: "json", version: 1 }));
      let handshakeTimeout;
      try {
        await Promise.race([
          connection.ready,
          new Promise((_, reject) => {
            handshakeTimeout = setTimeout(
              () => reject(new Error("Biquote SignalR handshake or subscription timed out")),
              15_000
            );
          }),
        ]);
      } finally {
        clearTimeout(handshakeTimeout);
      }
      connection.active = true;
      this.activeConnection = connection;
      this.metrics.reconnects += 1;
      if (previousConnection && previousConnection !== connection) {
        previousConnection.active = false;
        previousConnection.intentionalClose = true;
        previousConnection.socket.close(1000, "SignalR connection refreshed");
      }
      console.info(JSON.stringify({
        event: "biquote_connected",
        hub: BIQUOTE_HUB_URL,
        subscribed_symbols: this.symbolRecords.length,
        generation,
      }));
      return { connected: true };
    } catch (error) {
      if (candidateConnection) {
        candidateConnection.intentionalClose = true;
        candidateConnection.rejectReady?.(error);
        this.connections.delete(candidateConnection);
        candidateConnection.socket.close(1011, "Biquote connection setup failed");
      }
      console.error("Biquote SignalR connection failed:", failureReason);
      if (this.activeConnection === previousConnection &&
        previousConnection?.socket.readyState === WebSocket.OPEN) {
        return { connected: true, refresh_failed: true };
      }
      return {
        connected: false,
        reason: candidateConnection?.failureReason || failureReason,
      };
    }
  }

  async handleSocketMessage(connection, data) {
    try {
      connection.lastMessageAt = Date.now();
      this.metrics.webSocketMessages += 1;
      const parsed = parseSignalRFrames(connection.buffer, data);
      connection.buffer = parsed.buffer;
      for (const message of parsed.frames) {
        if (!connection.handshakeComplete) {
          if (message.error) throw new Error(`SignalR handshake rejected: ${message.error}`);
          connection.handshakeComplete = true;
          connection.failureReason = "subscription_failed";
          connection.socket.send(signalRRecord({
            type: 1,
            target: "Subscribe",
            arguments: [this.symbolRecords.map((record) => record.provider_symbol)],
            invocationId: connection.subscriptionInvocationId,
          }));
          continue;
        }
        if (message.type === 6) {
          connection.socket.send(signalRRecord({ type: 6 }));
          continue;
        }
        if (message.type === 7) throw new Error(message.error || "Biquote closed the SignalR connection");
        if (message.type === 3 && message.invocationId === connection.subscriptionInvocationId) {
          if (message.error) throw new Error(`Biquote Subscribe failed: ${message.error}`);
          connection.resolveReady();
          console.info(JSON.stringify({
            event: "biquote_subscribed",
            method: "Subscribe",
            symbols: this.symbolRecords.length,
          }));
          continue;
        }
        if (this.activeConnection === connection && message.type === 1 &&
          String(message.target).toLowerCase() === "receivetick") {
          for (const providerTick of message.arguments || []) {
            const tick = feedTickFromSignalR(providerTick, this.symbolByProvider);
            if (tick) await this.acceptTick(tick);
          }
        }
      }
    } catch (error) {
      connection.rejectReady?.(error);
      console.error("Biquote SignalR message processing failed");
      connection.socket.close(1011, "SignalR message processing failed");
    }
  }

  handleSocketClosed(connection, reason) {
    this.connections.delete(connection);
    connection.rejectReady?.(new Error(`Biquote WebSocket ${reason}`));
    if (!connection.intentionalClose && this.activeConnection === connection) {
      this.activeConnection = null;
      console.error(`Biquote WebSocket ${reason}; scheduling reconnect`);
      this.state.waitUntil?.(this.ensureConnection());
    }
  }

  recordTick(tick) {
    const minute = Math.floor(Date.now() / 60_000);
    let counts = this.metrics.ticksByMinute.get(minute);
    if (!counts) {
      counts = new Map();
      this.metrics.ticksByMinute.set(minute, counts);
    }
    counts.set(tick.symbol, (counts.get(tick.symbol) || 0) + 1);
    for (const key of this.metrics.ticksByMinute.keys()) {
      if (key < minute - 60) this.metrics.ticksByMinute.delete(key);
    }
  }

  async acceptTick(tick) {
    await this.initialized;
    const startedAt = performance.now();
    if (!freshProviderTick(tick)) return { accepted: false, reason: "invalid_or_stale_tick" };
    if (this.symbolByProvider.get(String(tick.provider_symbol).toUpperCase()) !== tick.symbol) {
      return { accepted: false, reason: "symbol_mismatch" };
    }
    const previous = this.latestTicks.get(tick.symbol);
    if (previous && Number(tick.timestamp_ms) <= Number(previous.timestamp_ms)) {
      return { accepted: false, reason: "duplicate_or_out_of_order" };
    }
    const safeAfter = this.safeAfterTimestamp.get(tick.symbol);
    if (!this.trustedSymbols.has(tick.symbol) || safeAfter === undefined ||
      Number(tick.timestamp_ms) <= safeAfter) {
      return { accepted: false, reason: "before_fresh_provider_baseline" };
    }
    this.safeAfterTimestamp.set(tick.symbol, Number(tick.timestamp_ms));
    this.latestTicks.set(tick.symbol, tick);
    this.recordTick(tick);
    for (const onTick of this.symbolReadinessWaiters.get(tick.symbol) || []) onTick();

    const positionIds = [...(this.positionIdsBySymbol.get(tick.symbol) || [])];
    const updatedAccountIds = new Set();
    this.metrics.protectionTicks += 1;
    this.metrics.protectionEvaluations += positionIds.length;
    for (const positionId of positionIds) {
      const position = this.positionsById.get(positionId);
      if (!position || !tickIsAfterPositionOpen(position, tick)) continue;
      const trigger = triggeredProtection(position, tick);
      if (!trigger) continue;
      await this.settleTriggeredPosition(position.id, tick, trigger.reason);
    }
    for (const positionId of positionIds) {
      const position = this.positionsById.get(positionId);
      if (position && tickIsAfterPositionOpen(position, tick)) {
        updatedAccountIds.add(position.account_id);
      }
    }
    for (const accountId of updatedAccountIds) {
      await this.publishAccountMarkUpdate(accountId, Number(tick.timestamp_ms));
    }
    const elapsed = performance.now() - startedAt;
    this.metrics.protectionLatencyTotalMs += elapsed;
    this.metrics.protectionLatencyMaxMs = Math.max(this.metrics.protectionLatencyMaxMs, elapsed);
    return { accepted: true, evaluated_positions: positionIds.length };
  }

  async settleTriggeredPosition(positionId, tick, reason) {
    const position = this.positionsById.get(positionId);
    if (!position) {
      this.pendingSettlements.delete(positionId);
      return;
    }
    try {
      await withAccountQueue(this, position.account_id, async () => {
        const result = await settlePosition(this.env, position.id, position.user_id, {
          source: "tick",
          tick,
          reason,
          latestTicks: this.latestTicks,
        });
        if (result.error && result.error !== "position_not_found") {
          throw new Error(result.message || result.error);
        }
        if (result._settlementRowsWritten) {
          this.metrics.d1SettlementRowsWritten += result._settlementRowsWritten;
        }
        if (result.skipped || result.error === "position_not_found") {
          this.pendingSettlements.delete(position.id);
          if (result.error === "position_not_found") this.removePosition(position.id);
          await this.refreshAccountPositions(position.account_id);
          return;
        }
        this.pendingSettlements.delete(position.id);
        this.removePosition(position.id);
        await this.refreshAccountPositions(position.account_id);
      });
    } catch (error) {
      this.pendingSettlements.set(positionId, { tick, reason });
      console.error(`Protection settlement failed for position ${position.id}; retrying on feed alarm:`, error);
    }
  }

  async retryPendingSettlements() {
    for (const [positionId, pending] of this.pendingSettlements) {
      await this.settleTriggeredPosition(positionId, pending.tick, pending.reason);
    }
  }

  async retryPendingAccountSyncs() {
    for (const accountId of this.pendingAccountSyncs) {
      try {
        await withAccountQueue(this, accountId, async () => {
          const positions = await this.refreshAccountPositions(accountId);
          if (positions.some((position) => !this.trustedSymbols.has(position.symbol))) {
            await this.refreshProviderBaselines();
          }
          await this.evaluateLatestForAccount(accountId, positions);
          this.pendingAccountSyncs.delete(accountId);
        });
      } catch (error) {
        console.error(`Market-feed position synchronization failed for account ${accountId}:`, error);
      }
    }
  }

  async evaluateLatestForAccount(accountId, positions) {
    for (const position of positions) {
      const tick = this.latestTicks.get(position.symbol);
      if (!tick || !tickIsAfterPositionOpen(position, tick)) continue;
      const trigger = triggeredProtection(position, tick);
      if (!trigger) continue;
      const result = await settlePosition(this.env, position.id, position.user_id, {
        source: "tick",
        tick,
        reason: trigger.reason,
        latestTicks: this.latestTicks,
      });
      if (result._settlementRowsWritten) {
        this.metrics.d1SettlementRowsWritten += result._settlementRowsWritten;
      }
      if (result.error && result.error !== "position_not_found") {
        throw new Error(result.message || result.error);
      }
      if (result.skipped) {
        await this.refreshAccountPositions(accountId);
        continue;
      }
      this.removePosition(position.id);
      await this.refreshAccountPositions(accountId);
    }
  }

  metricsSnapshot() {
    const currentMinute = Math.floor(Date.now() / 60_000);
    const current = this.metrics.ticksByMinute.get(currentMinute) || new Map();
    const uptimeMinutes = Math.max(1, (Date.now() - this.metrics.startedAt) / 60_000);
    return {
      ticks_per_symbol_current_minute: Object.fromEntries(current),
      estimated_ticks_per_day_by_symbol: Object.fromEntries(
        [...current].map(([symbol, count]) => [symbol, Math.round(count * 1440)])
      ),
      do_incoming_websocket_messages: this.metrics.webSocketMessages,
      position_lifecycle_d1_reads: this.metrics.d1PositionLifecycleReads,
      settlement_d1_rows_written: this.metrics.d1SettlementRowsWritten,
      reconnects: this.metrics.reconnects,
      protection_evaluations: this.metrics.protectionEvaluations,
      protection_latency_average_ms: this.metrics.protectionEvaluations
        ? this.metrics.protectionLatencyTotalMs / Math.max(1, this.metrics.protectionTicks)
        : 0,
      protection_latency_max_ms: this.metrics.protectionLatencyMaxMs,
      uptime_minutes: uptimeMinutes,
      connected: Boolean(this.activeConnection),
    };
  }

  async scheduleNextAlarm() {
    await this.state.storage?.setAlarm?.(Date.now() + MARKET_FEED_ALARM_MS);
  }

  async persistCheckpoints() {
    await this.state.storage?.put?.(
      "tick-checkpoints",
      Object.fromEntries([...this.safeAfterTimestamp])
    );
  }

  logMetricsIfDue() {
    if (Date.now() - this.metrics.lastMetricsLogAt < 60_000) return;
    this.metrics.lastMetricsLogAt = Date.now();
    console.info(JSON.stringify({ event: "market_feed_metrics", ...this.metricsSnapshot() }));
  }

  async alarm() {
    await this.initialized;
    await this.scheduleNextAlarm();
    await this.persistCheckpoints();
    this.logMetricsIfDue();
    await this.retryPendingSettlements();
    await this.retryPendingAccountSyncs();
    if ([...this.positionsById.values()].some(
      (position) => !this.trustedSymbols.has(position.symbol)
    )) {
      await this.refreshProviderBaselines();
    }
    const active = this.activeConnection;
    if (active && Date.now() - active.lastMessageAt > MARKET_FEED_HEALTH_TIMEOUT_MS) {
      active.intentionalClose = true;
      active.socket.close(4000, "Biquote SignalR heartbeat timed out");
      this.activeConnection = null;
    }
    const refresh = this.activeConnection &&
      Date.now() - this.activeConnection.connectedAt >= MARKET_FEED_REFRESH_MS;
    if (!this.activeConnection || refresh) {
      await this.ensureConnection({ refresh: Boolean(refresh) });
    }
  }

  async fetch(request) {
    await this.initialized;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ensure") {
      await this.scheduleNextAlarm();
      const result = await this.ensureConnection();
      const requiredSymbol = normalizeText(url.searchParams.get("symbol")).toUpperCase();
      let connected = result.connected;
      let reason = result.reason;
      if (connected && requiredSymbol) {
        if (!this.symbolRecords.some((record) => record.symbol === requiredSymbol)) {
          connected = false;
        } else {
          if (!this.trustedSymbols.has(requiredSymbol) ||
            !this.safeAfterTimestamp.has(requiredSymbol)) {
            await this.refreshProviderBaselines();
          }
          const baselineReady = this.trustedSymbols.has(requiredSymbol) &&
            this.safeAfterTimestamp.has(requiredSymbol) &&
            this.baselineTimestamps.has(requiredSymbol);
          connected = baselineReady &&
            await this.waitForFreshSymbolTick(requiredSymbol);
        }
        if (!connected) reason = "feed_not_connected";
      }
      this.logMetricsIfDue();
      return json({
        success: connected,
        connected,
        symbols: this.symbolRecords.length,
        ...(connected ? {} : {
          reason: MARKET_FEED_FAILURE_REASONS.has(reason)
            ? reason
            : "feed_not_connected",
        }),
      }, connected ? 200 : 503);
    }
    if (request.method === "POST" && url.pathname === "/sync-account") {
      const body = await readJson(request);
      const accountId = normalizeText(body.account_id);
      if (!accountId) return json({ success: false, error: "account_id is required" }, 400);
      return withAccountQueue(this, accountId, async () => {
        try {
          const positions = await this.refreshAccountPositions(accountId);
          const connection = await this.ensureConnection();
          if (positions.some((position) => !this.trustedSymbols.has(position.symbol))) {
            await this.refreshProviderBaselines();
          }
          await this.evaluateLatestForAccount(accountId, positions);
          const stillOpen = [...this.positionsById.values()].filter(
            (position) => position.account_id === accountId
          );
          const baselineReady = stillOpen.every((position) =>
            this.trustedSymbols.has(position.symbol) && this.safeAfterTimestamp.has(position.symbol)
          );
          const ready = connection.connected && baselineReady;
          this.pendingAccountSyncs.delete(accountId);
          return json({
            success: ready,
            ready,
            open_positions: stillOpen.length,
            error: ready ? undefined : connection.error || "A fresh provider baseline is unavailable",
          }, ready ? 200 : 503);
        } catch (error) {
          this.pendingAccountSyncs.add(accountId);
          throw error;
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/tick") {
      const tick = await readJson(request);
      const result = await this.acceptTick(tick);
      return json({ success: true, ...result });
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      return json({ success: true, ...this.metricsSnapshot() });
    }
    return json({ success: false, error: "Route not found" }, 404);
  }
}

function marketFeedStub(env) {
  if (!env.MARKET_FEED) throw new Error("Biquote market feed Durable Object is not configured");
  return env.MARKET_FEED.get(env.MARKET_FEED.idFromName("biquote-market-feed"));
}

async function syncMarketFeedAccount(env, accountId) {
  const response = await marketFeedStub(env).fetch("https://market-feed/sync-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: accountId }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Market feed position refresh failed (${response.status})`);
  }
  return response.json();
}

async function ensureMarketFeed(env, symbol) {
  try {
    const ensureUrl = new URL("https://market-feed/ensure");
    ensureUrl.searchParams.set("symbol", symbol);
    const response = await marketFeedStub(env).fetch(ensureUrl, {
      method: "POST",
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.connected === true) return { connected: true };
    return {
      connected: false,
      reason: MARKET_FEED_FAILURE_REASONS.has(result.reason)
        ? result.reason
        : "feed_not_connected",
    };
  } catch {
    return { connected: false, reason: "feed_not_connected" };
  }
}

export class PositionEventsDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.accountQueues = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      const { account_id: accountId, event } = await readJson(request);
      const isAccountMark = event?.type === "ACCOUNT_MARK_UPDATED" &&
        event.account_id === accountId && Array.isArray(event.positions);
      if (!accountId || !event || (typeof event.position_id !== "string" && !isAccountMark)) {
        return json({ success: false, error: "Invalid position event" }, 400);
      }
      const message = JSON.stringify(event);
      for (const socket of this.state.getWebSockets(String(accountId))) {
        try { socket.send(message); } catch { socket.close(1011, "Event delivery failed"); }
      }
      return json({ success: true });
    }
    if (request.method === "GET" && url.pathname === "/connect") {
      const accountId = request.headers.get("X-Event-Account-Id");
      if (!accountId || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ success: false, error: "WebSocket upgrade required" }, 400);
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], [accountId]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.method === "POST" && url.pathname === "/settle") {
      const body = await readJson(request);
      const accountId = normalizeText(body.account_id);
      if (!accountId || !body.position_id || !body.user_id ||
        !["manual", "tick"].includes(body.source)) {
        return json({ success: false, error: "Invalid settlement request" }, 400);
      }
      return withAccountQueue(this, accountId, async () => {
        const result = await settlePosition(this.env, body.position_id, body.user_id, {
          source: body.source,
          tick: body.tick,
          reason: body.reason,
        });
        if (result.error) return tradingError(result.error, result.message || "Position could not be closed", result.status);
        const { _settlementRowsWritten, ...publicResult } = result;
        if (body.source === "manual") {
          try {
            await syncMarketFeedAccount(this.env, accountId);
          } catch (error) {
            console.error("Manual close settled, but market-feed state refresh failed:", error);
          }
        }
        return json({ success: true, ...publicResult });
      });
    }
    if (request.method === "POST" && url.pathname === "/modify") {
      const body = await readJson(request);
      return withAccountQueue(this, body.account_id, async () => {
        const assignments = [];
        const values = [];
        if (body.has_stop_loss) {
          assignments.push("stop_loss = ?");
          values.push(body.stop_loss);
        }
        if (body.has_take_profit) {
          assignments.push("take_profit = ?");
          values.push(body.take_profit);
        }
        const updateResult = await this.env.daily_funded_trading_db.prepare(`
          UPDATE positions SET ${assignments.join(", ")}
          WHERE id = ? AND account_id = ? AND status = 'open'
            AND EXISTS (SELECT 1 FROM trading_accounts WHERE id = ? AND user_id = ?)
        `).bind(
          ...values, body.position_id, body.account_id, body.account_id, body.user_id
        ).run();
        if (Number(updateResult?.meta?.changes || 0) !== 1) {
          return tradingError("position_not_found", "Position not found", 404);
        }
        const position = await this.env.daily_funded_trading_db.prepare(`
          SELECT p.* FROM positions p
          INNER JOIN trading_accounts a ON a.id = p.account_id
          WHERE p.id = ? AND a.user_id = ? AND p.status = 'open'
        `).bind(body.position_id, body.user_id).first();
        if (!position) return tradingError("position_not_found", "Position not found", 404);
        try {
          await syncMarketFeedAccount(this.env, body.account_id);
        } catch (error) {
          console.error("Position protection changed, but market-feed state refresh failed:", error);
          return tradingError("protection_state_sync_failed", error.message, 503);
        }
        const authoritativePosition = { ...position, pnl_metadata: body.pnl_metadata };
        await publishPositionEvent(
          this.env,
          body.user_id,
          body.account_id,
          {
            type: "POSITION_MODIFIED",
            position_id: position.id,
            account_id: body.account_id,
            position: authoritativePosition,
          }
        );
        return json({ success: true, position: authoritativePosition });
      });
    }
    return json({ success: false, error: "Route not found" }, 404);
  }

  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}
}

async function getMarketCandles(env, url) {
  const symbol = normalizeText(url.searchParams.get("symbol")).toUpperCase();
  const interval = normalizeText(url.searchParams.get("interval")).toLowerCase();
  const limit = Number(url.searchParams.get("limit") || 1000);
  const from = parseOptionalCandleDateTime(url.searchParams.get("from"), "from");
  const to = parseOptionalCandleDateTime(url.searchParams.get("to"), "to");
  if (!symbol || !Object.hasOwn(MARKET_CANDLE_INTERVALS, interval)) {
    return json({ success: false, error: "symbol and a supported interval are required" }, 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return json({ success: false, error: "limit must be an integer from 1 to 1000" }, 400);
  }
  if (from.error || to.error) {
    return json({ success: false, error: from.error || to.error }, 400);
  }
  if (from.timestamp !== undefined && to.timestamp !== undefined && from.timestamp > to.timestamp) {
    return json({ success: false, error: "from must not be later than to" }, 400);
  }

  const records = await getConfiguredMarketSymbols(env);
  const record = records.find((candidate) => candidate.symbol === symbol);
  if (!record) return json({ success: false, error: "Unknown or disabled market symbol" }, 400);

  if (record.provider === "biquote") {
    const providerUrl = new URL(`https://biquote.io/api/${encodeURIComponent(record.provider_symbol)}/ohlc`);
    providerUrl.searchParams.set("interval", interval);
    providerUrl.searchParams.set("limit", String(limit));
    if (from.value !== null) providerUrl.searchParams.set("from", from.value);
    if (to.value !== null) providerUrl.searchParams.set("to", to.value);
    let response;
    try {
      response = await fetch(providerUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return json({ success: false, error: "Candle provider is unavailable", code: "provider_http_error" }, 502);
    } catch {
      return json({ success: false, error: "Candle provider is unavailable", code: "provider_unreachable" }, 502);
    }

    let payload;
    try {
      payload = await response.json();
      if (!Array.isArray(payload?.bars)) throw new Error("Invalid bars payload");
      const bars = payload.bars
        .slice(0, limit + 1)
        .map((bar) => normalizeProviderCandle(symbol, interval, bar));
      return json({ success: true, symbol, provider: record.provider, source: "provider_historical", interval, bars });
    } catch {
      return json({ success: false, error: "Candle provider returned malformed data", code: "provider_invalid_response" }, 502);
    }
  }

  return json({ success: false, error: "Candle provider is not configured", code: "provider_misconfigured" }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isMarketDataPath = MARKET_DATA_PATHS.has(url.pathname);

    if (request.method === "OPTIONS" && isMarketDataPath) {
      const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      const preflightAllowed =
        request.headers.get("Origin") === MARKET_DATA_ORIGIN &&
        request.headers.get("Access-Control-Request-Method") === "GET" &&
        requestedHeaders.every((header) => header === "accept");

      if (!preflightAllowed) {
        return json({ success: false, error: "CORS preflight not allowed" }, 403);
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": MARKET_DATA_ORIGIN,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Accept",
          "Vary": "Origin",
        },
      });
    }

    const disabledConfigurationRoutes = new Set([
      "POST /models",
      "GET /models",
      "GET /models/detail",
      "PUT /models",
      "PATCH /models/status",
      "POST /model-phases",
      "PUT /model-phases",
      "POST /model-sizes",
      "PUT /model-sizes",
      "POST /symbols",
      "GET /symbols",
    ]);
    if (disabledConfigurationRoutes.has(`${request.method} ${url.pathname}`)) {
      return json({ success: false, error: "Route not found" }, 404);
    }

    try {
      if (
        (request.method === "POST" && url.pathname === "/internal/market-feed/ensure") ||
        (request.method === "GET" && url.pathname === "/internal/market-feed/metrics")
      ) {
        const expectedToken = typeof env.MARKET_TICK_INGEST_TOKEN === "string"
          ? env.MARKET_TICK_INGEST_TOKEN.trim()
          : "";
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
        if (!expectedToken || !bearer ||
          !(await timingSafeTokenMatches(bearer[1].trim(), expectedToken))) {
          return json({ success: false, error: "Market feed diagnostics are unauthorized" }, 401);
        }
        const route = request.method === "POST" ? "/ensure" : "/metrics";
        return marketFeedStub(env).fetch(`https://market-feed${route}`, { method: request.method });
      }
      if (request.method === "POST" && url.pathname === "/internal/market-tick") {
        const expectedToken = typeof env.MARKET_TICK_INGEST_TOKEN === "string"
          ? env.MARKET_TICK_INGEST_TOKEN.trim()
          : "";
        const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
        if (!expectedToken) {
          return json({ success: false, error: "Market tick ingestion is not configured" }, 503);
        }
        if (!bearer || !(await timingSafeTokenMatches(bearer[1].trim(), expectedToken))) {
          return json({ success: false, error: "Market tick ingestion is unauthorized" }, 401);
        }
        const body = await readJson(request);
        const symbol = normalizeText(body.symbol).toUpperCase();
        const providerSymbol = normalizeText(body.provider_symbol).toUpperCase();
        const timestampMs = parseProviderTimestamp(body.timestamp);
        let bid;
        let ask;
        try {
          bid = optionalPositivePrice(body.bid);
          ask = optionalPositivePrice(body.ask);
        } catch {
          return json({ success: false, error: "Tick prices are invalid" }, 400);
        }
        if (
          !symbol || !providerSymbol || timestampMs === null ||
          bid === null || ask === null || ask < bid ||
          timestampMs > Date.now() + 60_000 ||
          Date.now() - timestampMs > MARKET_DATA_MAX_AGE_MS
        ) {
          return json({ success: false, error: "Tick is invalid or stale" }, 400);
        }
        if (!env.MARKET_FEED) {
          return json({ success: false, error: "Server-side market feed is not configured" }, 503);
        }
        const tick = { symbol, provider_symbol: providerSymbol, timestamp_ms: timestampMs, bid, ask };
        return marketFeedStub(env).fetch("https://market-feed/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tick),
        });
      }

      // =====================================================
      // HEALTH
      // =====================================================

      if (request.method === "GET" && url.pathname === "/") {
        return json({
          success: true,
          service: "Daily Funded Trading Engine",
          version: "2.0-flexible-models",
        });
      }

      if (request.method === "GET" && url.pathname === "/market/symbols") {
        const symbols = await getConfiguredMarketSymbols(env);
        return withMarketCors(json({
          success: true,
          symbols: symbols.map(({ symbol, display_name, category, provider, provider_symbol }) => ({
            symbol,
            display_name,
            category,
            provider,
            provider_symbol,
          })),
        }), request);
      }

      if (request.method === "POST" && url.pathname === "/events/token") {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;
        const body = await readJson(request);
        const accountId = normalizeText(body.account_id);
        if (!accountId || !(await findAccountForUser(env, accountId, tradingAuth.userId))) {
          return tradingError("trading_account_not_found", "Trading account not found", 404);
        }
        try {
          return json({
            success: true,
            ticket: await createEventTicket(env, tradingAuth.userId, accountId),
          });
        } catch (error) {
          console.error("Unable to issue position event ticket:", error);
          return json({ success: false, error: "Position event delivery is not configured" }, 503);
        }
      }

      if (request.method === "GET" && url.pathname === "/trading/events") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return json({ success: false, error: "WebSocket upgrade required" }, 426);
        }
        const ticket = await verifyEventTicket(env, url.searchParams.get("ticket"));
        if (!ticket || !env.POSITION_EVENTS) {
          return json({ success: false, error: "Position event ticket is invalid or expired" }, 401);
        }
        const id = env.POSITION_EVENTS.idFromName(`user:${ticket.user_id}`);
        return env.POSITION_EVENTS.get(id).fetch("https://position-events/connect", {
          method: "GET",
          headers: {
            Upgrade: "websocket",
            "X-Event-Account-Id": ticket.account_id,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/market/quotes") {
        return withMarketCors(await getMarketQuotes(request, env, url), request);
      }

      if (request.method === "GET" && url.pathname === "/market/candles") {
        return withMarketCors(await getMarketCandles(env, url), request);
      }

      // =====================================================
      // CREATE CHALLENGE MODEL
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/models"
      ) {
        const body = await readJson(request);

        const code = normalizeText(body.code);
        const name = normalizeText(body.name);

        if (!code || !name) {
          return json(
            {
              success: false,
              error: "code and name are required",
            },
            400
          );
        }

        const leverage = validatePositiveNumber(
          body.leverage ?? 100,
          "leverage"
        );

        const profitSplit = validateNonNegativeNumber(
          body.profit_split_percent ?? 80,
          "profit_split_percent"
        );

        const modelId = generateId("MODEL");

        await env.daily_funded_trading_db
          .prepare(`
            INSERT INTO challenge_models (
              id,
              code,
              name,
              description,
              currency,
              leverage,
              profit_split_percent,
              minimum_payout,
              maximum_payout,
              payout_frequency,
              payout_waiting_period_days,
              status,
              custom_rules_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            modelId,
            code,
            name,
            normalizeText(body.description, null),
            normalizeText(body.currency, "USD"),
            leverage,
            profitSplit,
            numberOrNull(body.minimum_payout),
            numberOrNull(body.maximum_payout),
            normalizeText(body.payout_frequency, null),
            body.payout_waiting_period_days === undefined
              ? null
              : integerOrDefault(
                  body.payout_waiting_period_days,
                  0
                ),
            normalizeText(body.status, "active"),
            jsonString(body.custom_rules, {})
          )
          .run();

        return json(
          {
            success: true,
            model: {
              id: modelId,
              code,
              name,
            },
          },
          201
        );
      }

      // =====================================================
      // LIST MODELS
      // =====================================================

      if (
        request.method === "GET" &&
        url.pathname === "/models"
      ) {
        const includeDisabled =
          url.searchParams.get("include_disabled") === "true";

        const result = await env.daily_funded_trading_db
          .prepare(
            includeDisabled
              ? `
                SELECT *
                FROM challenge_models
                ORDER BY created_at DESC
              `
              : `
                SELECT *
                FROM challenge_models
                WHERE status = 'active'
                ORDER BY created_at DESC
              `
          )
          .all();

        return json({
          success: true,
          models: result.results || [],
        });
      }

      // =====================================================
      // GET ONE MODEL WITH PHASES AND SIZES
      // =====================================================

      if (
        request.method === "GET" &&
        url.pathname === "/models/detail"
      ) {
        const modelId = url.searchParams.get("model_id");

        if (!modelId) {
          return json(
            {
              success: false,
              error: "model_id is required",
            },
            400
          );
        }

        const model = await getModel(env, modelId);

        if (!model) {
          return json(
            {
              success: false,
              error: "Challenge model not found",
            },
            404
          );
        }

        const phases = await env.daily_funded_trading_db
          .prepare(`
            SELECT *
            FROM challenge_model_phases
            WHERE model_id = ?
            ORDER BY phase_number ASC
          `)
          .bind(modelId)
          .all();

        const sizes = await env.daily_funded_trading_db
          .prepare(`
            SELECT *
            FROM challenge_model_sizes
            WHERE model_id = ?
            ORDER BY size ASC
          `)
          .bind(modelId)
          .all();

        return json({
          success: true,
          model,
          phases: phases.results || [],
          sizes: sizes.results || [],
        });
      }

      // =====================================================
      // UPDATE MODEL
      // =====================================================

      if (
        request.method === "PUT" &&
        url.pathname === "/models"
      ) {
        const body = await readJson(request);
        const modelId = normalizeText(body.model_id);

        if (!modelId) {
          return json(
            {
              success: false,
              error: "model_id is required",
            },
            400
          );
        }

        const existing = await getModel(env, modelId);

        if (!existing) {
          return json(
            {
              success: false,
              error: "Challenge model not found",
            },
            404
          );
        }

        const code = normalizeText(
          body.code,
          existing.code
        );

        const name = normalizeText(
          body.name,
          existing.name
        );

        const leverage = validatePositiveNumber(
          body.leverage ?? existing.leverage,
          "leverage"
        );

        const profitSplit = validateNonNegativeNumber(
          body.profit_split_percent ??
            existing.profit_split_percent,
          "profit_split_percent"
        );

        await env.daily_funded_trading_db
          .prepare(`
            UPDATE challenge_models
            SET
              code = ?,
              name = ?,
              description = ?,
              currency = ?,
              leverage = ?,
              profit_split_percent = ?,
              minimum_payout = ?,
              maximum_payout = ?,
              payout_frequency = ?,
              payout_waiting_period_days = ?,
              status = ?,
              custom_rules_json = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            code,
            name,
            body.description !== undefined
              ? normalizeText(body.description, null)
              : existing.description,
            body.currency !== undefined
              ? normalizeText(body.currency, "USD")
              : existing.currency,
            leverage,
            profitSplit,
            body.minimum_payout !== undefined
              ? numberOrNull(body.minimum_payout)
              : existing.minimum_payout,
            body.maximum_payout !== undefined
              ? numberOrNull(body.maximum_payout)
              : existing.maximum_payout,
            body.payout_frequency !== undefined
              ? normalizeText(body.payout_frequency, null)
              : existing.payout_frequency,
            body.payout_waiting_period_days !== undefined
              ? integerOrDefault(
                  body.payout_waiting_period_days,
                  0
                )
              : existing.payout_waiting_period_days,
            body.status !== undefined
              ? normalizeText(body.status, "active")
              : existing.status,
            body.custom_rules !== undefined
              ? jsonString(body.custom_rules, {})
              : existing.custom_rules_json,
            modelId
          )
          .run();

        return json({
          success: true,
          message: "Challenge model updated",
        });
      }

      // =====================================================
      // ENABLE / DISABLE MODEL
      // =====================================================

      if (
        request.method === "PATCH" &&
        url.pathname === "/models/status"
      ) {
        const body = await readJson(request);
        const modelId = normalizeText(body.model_id);
        const status = normalizeText(body.status).toLowerCase();

        if (!modelId || !["active", "disabled"].includes(status)) {
          return json(
            {
              success: false,
              error:
                "model_id and status (active or disabled) are required",
            },
            400
          );
        }

        const result = await env.daily_funded_trading_db
          .prepare(`
            UPDATE challenge_models
            SET
              status = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(status, modelId)
          .run();

        if (!result.meta.changes) {
          return json(
            {
              success: false,
              error: "Challenge model not found",
            },
            404
          );
        }

        return json({
          success: true,
          message: `Challenge model ${status}`,
        });
      }

      // =====================================================
      // CREATE PHASE
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/model-phases"
      ) {
        const body = await readJson(request);

        const modelId = normalizeText(body.model_id);
        const phaseNumber = integerOrDefault(
          body.phase_number,
          1
        );
        const phaseName = normalizeText(
          body.phase_name,
          `Phase ${phaseNumber}`
        );

        if (!modelId) {
          return json(
            {
              success: false,
              error: "model_id is required",
            },
            400
          );
        }

        if (phaseNumber <= 0) {
          return json(
            {
              success: false,
              error: "phase_number must be greater than zero",
            },
            400
          );
        }

        const model = await getModel(env, modelId);

        if (!model) {
          return json(
            {
              success: false,
              error: "Challenge model not found",
            },
            404
          );
        }

        const phaseId = generateId("PHASE");

        const maxDrawdownType = validateDrawdownType(
          body.max_drawdown_type,
          "STATIC"
        );

        const dailyDrawdownType =
          validateDailyDrawdownType(
            body.daily_drawdown_type,
            "START_OF_DAY_EQUITY"
          );

        await env.daily_funded_trading_db
          .prepare(`
            INSERT INTO challenge_model_phases (
              id,
              model_id,
              phase_number,
              phase_name,
              description,
              profit_target_percent,
              daily_drawdown_percent,
              max_drawdown_percent,
              max_drawdown_type,
              daily_drawdown_type,
              minimum_trading_days,
              maximum_trading_days,
              minimum_profitable_days,
              max_lot_size,
              max_open_positions,
              max_trades_per_day,
              max_risk_per_trade_percent,
              max_daily_risk_percent,
              max_exposure_percent,
              stop_loss_required,
              take_profit_required,
              weekend_holding_allowed,
              overnight_holding_allowed,
              news_trading_allowed,
              ea_allowed,
              allowed_symbols_json,
              allowed_categories_json,
              pass_rule,
              fail_rule,
              next_phase_number,
              custom_rules_json,
              status
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
          `)
          .bind(
            phaseId,
            modelId,
            phaseNumber,
            phaseName,
            normalizeText(body.description, null),
            numberOrNull(body.profit_target_percent),
            numberOrNull(body.daily_drawdown_percent),
            numberOrNull(body.max_drawdown_percent),
            maxDrawdownType,
            dailyDrawdownType,
            integerOrDefault(
              body.minimum_trading_days,
              0
            ),
            numberOrNull(body.maximum_trading_days),
            integerOrDefault(
              body.minimum_profitable_days,
              0
            ),
            numberOrNull(body.max_lot_size),
            body.max_open_positions === undefined
              ? null
              : integerOrDefault(
                  body.max_open_positions,
                  0
                ),
            body.max_trades_per_day === undefined
              ? null
              : integerOrDefault(
                  body.max_trades_per_day,
                  0
                ),
            numberOrNull(
              body.max_risk_per_trade_percent
            ),
            numberOrNull(
              body.max_daily_risk_percent
            ),
            numberOrNull(body.max_exposure_percent),
            booleanToDb(body.stop_loss_required),
            booleanToDb(body.take_profit_required),
            booleanToDb(
              body.weekend_holding_allowed,
              1
            ),
            booleanToDb(
              body.overnight_holding_allowed,
              1
            ),
            booleanToDb(
              body.news_trading_allowed,
              1
            ),
            booleanToDb(body.ea_allowed, 1),
            jsonString(body.allowed_symbols, []),
            jsonString(body.allowed_categories, []),
            normalizeText(body.pass_rule, null),
            normalizeText(body.fail_rule, null),
            body.next_phase_number === undefined
              ? null
              : integerOrDefault(
                  body.next_phase_number,
                  0
                ),
            jsonString(body.custom_rules, {}),
            normalizeText(body.status, "active")
          )
          .run();

        return json(
          {
            success: true,
            phase: {
              id: phaseId,
              model_id: modelId,
              phase_number: phaseNumber,
              phase_name: phaseName,
            },
          },
          201
        );
      }

      // =====================================================
      // UPDATE PHASE
      // =====================================================

      if (
        request.method === "PUT" &&
        url.pathname === "/model-phases"
      ) {
        const body = await readJson(request);
        const phaseId = normalizeText(body.phase_id);

        if (!phaseId) {
          return json(
            {
              success: false,
              error: "phase_id is required",
            },
            400
          );
        }

        const existing = await getPhase(env, phaseId);

        if (!existing) {
          return json(
            {
              success: false,
              error: "Challenge phase not found",
            },
            404
          );
        }

        const phaseNumber = integerOrDefault(
          body.phase_number,
          existing.phase_number
        );

        const maxDrawdownType =
          body.max_drawdown_type !== undefined
            ? validateDrawdownType(
                body.max_drawdown_type,
                existing.max_drawdown_type
              )
            : existing.max_drawdown_type;

        const dailyDrawdownType =
          body.daily_drawdown_type !== undefined
            ? validateDailyDrawdownType(
                body.daily_drawdown_type,
                existing.daily_drawdown_type
              )
            : existing.daily_drawdown_type;

        await env.daily_funded_trading_db
          .prepare(`
            UPDATE challenge_model_phases
            SET
              phase_number = ?,
              phase_name = ?,
              description = ?,
              profit_target_percent = ?,
              daily_drawdown_percent = ?,
              max_drawdown_percent = ?,
              max_drawdown_type = ?,
              daily_drawdown_type = ?,
              minimum_trading_days = ?,
              maximum_trading_days = ?,
              minimum_profitable_days = ?,
              max_lot_size = ?,
              max_open_positions = ?,
              max_trades_per_day = ?,
              max_risk_per_trade_percent = ?,
              max_daily_risk_percent = ?,
              max_exposure_percent = ?,
              stop_loss_required = ?,
              take_profit_required = ?,
              weekend_holding_allowed = ?,
              overnight_holding_allowed = ?,
              news_trading_allowed = ?,
              ea_allowed = ?,
              allowed_symbols_json = ?,
              allowed_categories_json = ?,
              pass_rule = ?,
              fail_rule = ?,
              next_phase_number = ?,
              custom_rules_json = ?,
              status = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            phaseNumber,
            body.phase_name !== undefined
              ? normalizeText(
                  body.phase_name,
                  `Phase ${phaseNumber}`
                )
              : existing.phase_name,
            body.description !== undefined
              ? normalizeText(body.description, null)
              : existing.description,
            body.profit_target_percent !== undefined
              ? numberOrNull(
                  body.profit_target_percent
                )
              : existing.profit_target_percent,
            body.daily_drawdown_percent !== undefined
              ? numberOrNull(
                  body.daily_drawdown_percent
                )
              : existing.daily_drawdown_percent,
            body.max_drawdown_percent !== undefined
              ? numberOrNull(
                  body.max_drawdown_percent
                )
              : existing.max_drawdown_percent,
            maxDrawdownType,
            dailyDrawdownType,
            body.minimum_trading_days !== undefined
              ? integerOrDefault(
                  body.minimum_trading_days,
                  0
                )
              : existing.minimum_trading_days,
            body.maximum_trading_days !== undefined
              ? numberOrNull(
                  body.maximum_trading_days
                )
              : existing.maximum_trading_days,
            body.minimum_profitable_days !== undefined
              ? integerOrDefault(
                  body.minimum_profitable_days,
                  0
                )
              : existing.minimum_profitable_days,
            body.max_lot_size !== undefined
              ? numberOrNull(body.max_lot_size)
              : existing.max_lot_size,
            body.max_open_positions !== undefined
              ? integerOrDefault(
                  body.max_open_positions,
                  0
                )
              : existing.max_open_positions,
            body.max_trades_per_day !== undefined
              ? integerOrDefault(
                  body.max_trades_per_day,
                  0
                )
              : existing.max_trades_per_day,
            body.max_risk_per_trade_percent !== undefined
              ? numberOrNull(
                  body.max_risk_per_trade_percent
                )
              : existing.max_risk_per_trade_percent,
            body.max_daily_risk_percent !== undefined
              ? numberOrNull(
                  body.max_daily_risk_percent
                )
              : existing.max_daily_risk_percent,
            body.max_exposure_percent !== undefined
              ? numberOrNull(
                  body.max_exposure_percent
                )
              : existing.max_exposure_percent,
            body.stop_loss_required !== undefined
              ? booleanToDb(
                  body.stop_loss_required
                )
              : existing.stop_loss_required,
            body.take_profit_required !== undefined
              ? booleanToDb(
                  body.take_profit_required
                )
              : existing.take_profit_required,
            body.weekend_holding_allowed !== undefined
              ? booleanToDb(
                  body.weekend_holding_allowed
                )
              : existing.weekend_holding_allowed,
            body.overnight_holding_allowed !== undefined
              ? booleanToDb(
                  body.overnight_holding_allowed
                )
              : existing.overnight_holding_allowed,
            body.news_trading_allowed !== undefined
              ? booleanToDb(
                  body.news_trading_allowed
                )
              : existing.news_trading_allowed,
            body.ea_allowed !== undefined
              ? booleanToDb(body.ea_allowed)
              : existing.ea_allowed,
            body.allowed_symbols !== undefined
              ? jsonString(
                  body.allowed_symbols,
                  []
                )
              : existing.allowed_symbols_json,
            body.allowed_categories !== undefined
              ? jsonString(
                  body.allowed_categories,
                  []
                )
              : existing.allowed_categories_json,
            body.pass_rule !== undefined
              ? normalizeText(body.pass_rule, null)
              : existing.pass_rule,
            body.fail_rule !== undefined
              ? normalizeText(body.fail_rule, null)
              : existing.fail_rule,
            body.next_phase_number !== undefined
              ? integerOrDefault(
                  body.next_phase_number,
                  0
                )
              : existing.next_phase_number,
            body.custom_rules !== undefined
              ? jsonString(body.custom_rules, {})
              : existing.custom_rules_json,
            body.status !== undefined
              ? normalizeText(body.status, "active")
              : existing.status,
            phaseId
          )
          .run();

        return json({
          success: true,
          message: "Challenge phase updated",
        });
      }

      // =====================================================
      // CREATE ACCOUNT SIZE
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/model-sizes"
      ) {
        const body = await readJson(request);

        const modelId = normalizeText(body.model_id);

        if (!modelId) {
          return json(
            {
              success: false,
              error: "model_id is required",
            },
            400
          );
        }

        const model = await getModel(env, modelId);

        if (!model) {
          return json(
            {
              success: false,
              error: "Challenge model not found",
            },
            404
          );
        }

        const size = validatePositiveNumber(
          body.size,
          "size"
        );

        const sizeId = generateId("SIZE");

        await env.daily_funded_trading_db
          .prepare(`
            INSERT INTO challenge_model_sizes (
              id,
              model_id,
              size,
              display_name,
              price,
              currency,
              status,
              custom_rules_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            sizeId,
            modelId,
            size,
            normalizeText(
              body.display_name,
              `$${size.toLocaleString()}`
            ),
            numberOrNull(body.price),
            normalizeText(
              body.currency,
              model.currency
            ),
            normalizeText(body.status, "active"),
            jsonString(body.custom_rules, {})
          )
          .run();

        return json(
          {
            success: true,
            size: {
              id: sizeId,
              model_id: modelId,
              size,
            },
          },
          201
        );
      }

      // =====================================================
      // UPDATE ACCOUNT SIZE
      // =====================================================

      if (
        request.method === "PUT" &&
        url.pathname === "/model-sizes"
      ) {
        const body = await readJson(request);
        const sizeId = normalizeText(body.size_id);

        if (!sizeId) {
          return json(
            {
              success: false,
              error: "size_id is required",
            },
            400
          );
        }

        const existing = await getSize(env, sizeId);

        if (!existing) {
          return json(
            {
              success: false,
              error: "Account size not found",
            },
            404
          );
        }

        const size = validatePositiveNumber(
          body.size ?? existing.size,
          "size"
        );

        await env.daily_funded_trading_db
          .prepare(`
            UPDATE challenge_model_sizes
            SET
              size = ?,
              display_name = ?,
              price = ?,
              currency = ?,
              status = ?,
              custom_rules_json = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            size,
            body.display_name !== undefined
              ? normalizeText(
                  body.display_name,
                  `$${size.toLocaleString()}`
                )
              : existing.display_name,
            body.price !== undefined
              ? numberOrNull(body.price)
              : existing.price,
            body.currency !== undefined
              ? normalizeText(
                  body.currency,
                  existing.currency
                )
              : existing.currency,
            body.status !== undefined
              ? normalizeText(body.status, "active")
              : existing.status,
            body.custom_rules !== undefined
              ? jsonString(body.custom_rules, {})
              : existing.custom_rules_json,
            sizeId
          )
          .run();

        return json({
          success: true,
          message: "Account size updated",
        });
      }

      // =====================================================
      // CREATE SYMBOL
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/symbols"
      ) {
        const body = await readJson(request);

        const symbol = normalizeText(body.symbol).toUpperCase();

        if (!symbol) {
          return json(
            {
              success: false,
              error: "symbol is required",
            },
            400
          );
        }

        const requiredFields = [
          "base_currency",
          "quote_currency",
          "volume_unit",
          "contract_size",
          "price_decimals",
          "pip_size",
          "lot_step",
          "minimum_lot",
        ];
        if (requiredFields.some((field) => body[field] === undefined || body[field] === null || body[field] === "")) {
          return json(
            { success: false, error: "Complete symbol calculation metadata is required" },
            400
          );
        }

        const symbolMetadata = {
          base_currency: normalizeText(body.base_currency).toUpperCase(),
          quote_currency: normalizeText(body.quote_currency).toUpperCase(),
          volume_unit: normalizeText(body.volume_unit),
          contract_size: validatePositiveNumber(body.contract_size, "contract_size"),
          price_decimals: Number(body.price_decimals),
          pip_size: validatePositiveNumber(body.pip_size, "pip_size"),
          lot_step: validatePositiveNumber(body.lot_step, "lot_step"),
          minimum_lot: validatePositiveNumber(body.minimum_lot, "minimum_lot"),
          maximum_lot:
            body.maximum_lot === undefined || body.maximum_lot === null || body.maximum_lot === ""
              ? null
              : validatePositiveNumber(body.maximum_lot, "maximum_lot"),
        };
        const symbolMetadataError = getSymbolConfigurationError({
          ...symbolMetadata,
          trading_enabled: 1,
        });
        if (symbolMetadataError) {
          return json({ success: false, error: symbolMetadataError }, 400);
        }

        const symbolId = generateId("SYM");

        await env.daily_funded_trading_db
          .prepare(`
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            symbolId,
            symbol,
            normalizeText(body.display_name, symbol),
            normalizeText(body.category, "FOREX").toUpperCase(),
            symbolMetadata.base_currency,
            symbolMetadata.quote_currency,
            symbolMetadata.volume_unit,
            symbolMetadata.contract_size,
            symbolMetadata.price_decimals,
            symbolMetadata.pip_size,
            symbolMetadata.lot_step,
            symbolMetadata.minimum_lot,
            symbolMetadata.maximum_lot,
            booleanToDb(
              body.trading_enabled,
              1
            )
          )
          .run();

        return json(
          {
            success: true,
            symbol: {
              id: symbolId,
              symbol,
            },
          },
          201
        );
      }

      // =====================================================
      // LIST SYMBOLS
      // =====================================================

      if (
        request.method === "GET" &&
        url.pathname === "/symbols"
      ) {
        const result = await env.daily_funded_trading_db
          .prepare(`
            SELECT *
            FROM trading_symbols
            ORDER BY category, symbol
          `)
          .all();

        return json({
          success: true,
          symbols: result.results || [],
        });
      }

      // =====================================================
      // CREATE ACCOUNT FROM MODEL
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/accounts/from-model"
      ) {
        if (!hasValidProvisioningToken(request, env)) {
          return json(
            {
              success: false,
              error: "Provisioning token is required.",
            },
            401
          );
        }

        const body = await readJson(request);
        const userId = normalizeText(body.user_id);
        const purchaseId = normalizeText(body.purchase_id, null);
        const planKey = normalizeText(body.plan_key, "").toLowerCase();
        const requestedSize = Number(body.account_size);
        const planCode = planCodeForKey(planKey);

        if (!userId || !purchaseId || !planKey) {
          return json(
            {
              success: false,
              error: "user_id, purchase_id and plan_key are required",
            },
            400
          );
        }

        if (!planCode) {
          return json(
            {
              success: false,
              error: "Invalid or inactive plan_key",
            },
            404
          );
        }

        if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
          return json(
            {
              success: false,
              error: "account_size must be a positive number",
            },
            400
          );
        }

        const existingAccount = await findAccountByPurchaseId(env, purchaseId);

        if (existingAccount) {
          if (!accountMatchesProvisioningRequest(
            existingAccount,
            userId,
            purchaseId,
            planCode,
            requestedSize
          )) {
            return json(
              {
                success: false,
                error: "purchase_id is already linked to a different account request",
              },
              409
            );
          }

          const context = await getAccountRuleContext(env, existingAccount.id);

          if (context.error) {
            return json({ success: false, error: context.error }, context.status);
          }

          return json(
            {
              success: true,
              account: {
                id: context.account.id,
                user_id: context.account.user_id,
                purchase_id: context.account.purchase_id,
                model_code: context.snapshot.model_code,
                phase_number: context.rules.phase_number,
                challenge_size: context.account.challenge_size,
                starting_balance: context.account.starting_balance,
                balance: context.account.balance,
                equity: context.account.equity,
                status: context.account.status,
              },
              rules: context.rules,
              idempotent: true,
            },
            200
          );
        }

        const model = await resolveActiveModelForPlan(env, planKey);

        if (!model) {
          return json(
            {
              success: false,
              error: "Invalid or inactive plan_key",
            },
            404
          );
        }

        if (
          model.profit_split_percent === null ||
          model.profit_split_percent === undefined ||
          !Number.isFinite(Number(model.profit_split_percent)) ||
          Number(model.profit_split_percent) < 0
        ) {
          return json(
            {
              success: false,
              error: "profit_split_percent is missing or invalid for the active model",
            },
            400
          );
        }

        const phases = await getActivePhasesForModel(env, model.id);
        const initialPhase = phases.find(
          (phase) => Number(phase.phase_number) === 1
        );

        if (!initialPhase) {
          return json(
            {
              success: false,
              error: "No active phase 1 exists for this model",
            },
            404
          );
        }

        if (!hasValidPhaseProgression(phases)) {
          return json(
            {
              success: false,
              error: "Active phase configuration contains an invalid next_phase_number",
            },
            400
          );
        }

        for (const phase of phases) {
          const phaseConfigurationError = getPhaseConfigurationError(phase);

          if (phaseConfigurationError) {
            return json(
              {
                success: false,
                error: phaseConfigurationError,
              },
              400
            );
          }
        }

        const size = await resolveActiveSizeForModel(env, model.id, requestedSize);

        if (!size) {
          return json(
            {
              success: false,
              error: "Account size is not available for this model",
            },
            404
          );
        }

        if (Number(size.size) !== Number(requestedSize)) {
          return json(
            {
              success: false,
              error: "Requested account_size does not match the active size for this model",
            },
            400
          );
        }

        const accountData = {
          user_id: userId,
          purchase_id: purchaseId,
        };

        const created = await createAccountAndRuleSnapshot(
          env,
          accountData,
          model,
          phases,
          size
        );

        if (!created || !created.accountId) {
          return json(
            {
              success: false,
              error: "Account provisioning failed",
            },
            500
          );
        }

        if (created.existing && !accountMatchesProvisioningRequest(
          created.existing,
          userId,
          purchaseId,
          model.code,
          size.size
        )) {
          return json(
            {
              success: false,
              error: "purchase_id is already linked to a different account request",
            },
            409
          );
        }

        const context = await getAccountRuleContext(env, created.accountId);

        if (context.error) {
          return json({ success: false, error: context.error }, context.status);
        }

        return json(
          {
            success: true,
            account: {
              id: context.account.id,
              user_id: context.account.user_id,
              purchase_id: context.account.purchase_id,
              model_id: context.snapshot.model_id,
              model_code: context.snapshot.model_code,
              model_name: context.snapshot.model_name,
              phase_id: context.rules.phase_id,
              phase_number: context.rules.phase_number,
              phase_name: context.rules.phase_name,
              size_id: context.snapshot.size_id,
              challenge_size: context.account.challenge_size,
              starting_balance: context.account.starting_balance,
              balance: context.account.balance,
              equity: context.account.equity,
              currency: context.snapshot.currency,
              leverage: context.snapshot.leverage,
              rule_snapshot_id: context.snapshot.id,
              status: context.account.status,
            },
            rules: context.rules,
          },
          201
        );
      }

      // =====================================================
      // GET ACCOUNT + RULE SNAPSHOT
      // =====================================================

      if (
        request.method === "GET" &&
        url.pathname === "/accounts"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const accountId =
          url.searchParams.get("account_id");

        if (!accountId) {
          return json(
            {
              success: false,
              error: "account_id is required",
            },
            400
          );
        }

        const context = await getAccountRuleContext(env, accountId, tradingAuth.userId);

        if (context.error) {
          return json({ success: false, error: context.error }, context.status);
        }

        const positionResult = await env.daily_funded_trading_db
          .prepare(`
            SELECT
              p.id,
              p.order_id,
              p.symbol,
              p.side,
              p.volume,
              p.open_price,
              p.current_price,
              p.floating_pnl,
              p.take_profit,
              p.stop_loss,
              p.status,
              p.opened_at
            FROM positions p
            INNER JOIN trading_accounts a ON a.id = p.account_id
            WHERE p.account_id = ? AND a.user_id = ? AND p.status = 'open'
            ORDER BY p.opened_at DESC
          `)
          .bind(accountId, tradingAuth.userId)
          .all();
        const openPositions = positionResult.results || [];
        const quotePayload = await getMarketQuotesForSymbols(
          env,
          openPositions.map((position) => position.symbol)
        );
        const quoteBySymbol = new Map((quotePayload.quotes || []).map((quote) => [quote.symbol, quote]));
        let totalFloatingPnl = 0;
        let totalUsedMargin = 0;
        let completeMarketData = true;
        let completeMarginData = Number(context.snapshot.leverage) > 0;
        const markedPositions = [];
        const positionUpdates = [];

        for (const position of openPositions) {
          const quote = quoteBySymbol.get(position.symbol);
          const currentPrice = position.side === "BUY" ? quote?.bid : quote?.ask;
          let metadata;
          try {
            metadata = await getPositionCalculationSnapshot(env, position.id);
          } catch {
            completeMarketData = false;
            completeMarginData = false;
            markedPositions.push({
              ...position,
              current_price: null,
              floating_pnl: null,
              market_data_status: "unavailable",
            });
            continue;
          }
          const pnlMetadata = positionDisplayMetadata(metadata);
          if (
            !quote ||
            quote.stale ||
            quote.market_state?.toLowerCase() === "closed" ||
            !Number.isFinite(Number(currentPrice)) ||
            Number(currentPrice) <= 0
          ) {
            completeMarketData = false;
            markedPositions.push({
              ...position,
              pnl_metadata: pnlMetadata,
              current_price: null,
              floating_pnl: null,
              market_data_status: quote?.stale ? "stale" : "unavailable",
            });
            continue;
          }

          try {
            const floatingPnl = calculatePnlUsd(position, currentPrice, metadata);
            totalFloatingPnl += floatingPnl;
            try {
              totalUsedMargin += marginForPosition(
                position,
                currentPrice,
                metadata,
                Number(context.snapshot.leverage)
              );
            } catch {
              completeMarginData = false;
            }
            markedPositions.push({
              ...position,
              pnl_metadata: pnlMetadata,
              current_price: Number(currentPrice),
              floating_pnl: floatingPnl,
              market_data_status: "live",
            });
            positionUpdates.push(env.daily_funded_trading_db.prepare(`
              UPDATE positions
              SET current_price = ?, floating_pnl = ?
              WHERE id = ? AND account_id = ? AND status = 'open'
            `).bind(Number(currentPrice), floatingPnl, position.id, accountId));
          } catch {
            completeMarketData = false;
            completeMarginData = false;
            markedPositions.push({
              ...position,
              pnl_metadata: pnlMetadata,
              current_price: null,
              floating_pnl: null,
              market_data_status: "unavailable",
            });
          }
        }

        const account = {
          ...context.account,
          open_pnl: completeMarketData ? totalFloatingPnl : null,
          equity: completeMarketData ? Number(context.account.balance) + totalFloatingPnl : null,
          used_margin: completeMarketData && completeMarginData ? totalUsedMargin : null,
          free_margin: completeMarketData && completeMarginData
            ? Number(context.account.balance) + totalFloatingPnl - totalUsedMargin
            : null,
          available_margin: completeMarketData && completeMarginData
            ? Number(context.account.balance) + totalFloatingPnl - totalUsedMargin
            : null,
          market_data_status: completeMarketData ? "live" : "unavailable",
        };

        if (completeMarketData) {
          positionUpdates.push(env.daily_funded_trading_db.prepare(`
            UPDATE trading_accounts
            SET equity = (
              SELECT balance FROM trading_accounts WHERE id = ? AND user_id = ?
            ) + COALESCE((
              SELECT SUM(floating_pnl) FROM positions
              WHERE account_id = ? AND status = 'open'
            ), 0), updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
          `).bind(
            accountId,
            tradingAuth.userId,
            accountId,
            accountId,
            tradingAuth.userId
          ));
          if (positionUpdates.length) await env.daily_funded_trading_db.batch(positionUpdates);
        }

        return json({
          success: true,
          account,
          rules: context.rules,
          positions: markedPositions,
        });
      }

      // =====================================================
      // OPEN POSITION
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/positions"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const body = await readJson(request);

        const accountId = normalizeText(
          body.account_id
        );

        const symbol = normalizeText(
          body.symbol
        ).toUpperCase();

        const side = normalizeText(
          body.side
        ).toUpperCase();

        const orderType = normalizeText(body.order_type, "MARKET").toUpperCase();
        let takeProfit;
        let stopLoss;
        try {
          takeProfit = optionalPositiveNumber(body.take_profit, "take_profit", "invalid_tp");
          stopLoss = optionalPositiveNumber(body.stop_loss, "stop_loss", "invalid_sl");
        } catch (error) {
          return tradingError(error.code || "rule_violation", error.message, error.status || 400);
        }

        if (!accountId || !symbol || !side || body.volume === undefined) {
          return tradingError("rule_violation", "Account, symbol, side and volume are required", 400);
        }
        if (orderType !== "MARKET") {
          return tradingError("invalid_order_type", "Only market orders are currently supported", 400);
        }

        if (!["BUY", "SELL"].includes(side)) {
          return tradingError("rule_violation", "Side must be BUY or SELL", 400);
        }

        let volume;
        try {
          volume = validatePositiveNumber(body.volume, "volume");
        } catch (error) {
          return tradingError("invalid_volume", error.message, 400);
        }

        const context = await getAccountRuleContext(env, accountId, tradingAuth.userId);

        if (context.error) {
          return json({ success: false, error: context.error }, context.status);
        }

        const account = context.account;

        if (account.status !== "active") {
          return tradingError("trading_disabled", "Trading account is not active", 409);
        }

        const rules = context.rules;

        if (Number(rules.phase_number) !== Number(account.phase_number)) {
          return tradingError("rule_violation", "Trading rules do not match the account's current phase", 400);
        }

        const symbolRecord = await env.daily_funded_trading_db
          .prepare(`
            SELECT *
            FROM trading_symbols
            WHERE symbol = ?
              AND trading_enabled = 1
            LIMIT 1
          `)
          .bind(symbol)
          .first();

        if (!symbolRecord) {
          return tradingError("rule_violation", `Symbol ${symbol} is not available for trading`, 400);
        }
        if (symbolRecord.provider === "biquote") {
          const feed = await ensureMarketFeed(env, symbol);
          if (!feed.connected) {
            const reason = MARKET_FEED_FAILURE_REASONS.has(feed.reason)
              ? feed.reason
              : "feed_not_connected";
            return json({
              success: false,
              code: "protection_unavailable",
              error: `The server-side Biquote protection feed is not ready (${MARKET_FEED_FAILURE_MESSAGES[reason]})`,
              reason,
            }, 503);
          }
        }

        const symbolConfigurationError = getSymbolConfigurationError(symbolRecord);
        if (symbolConfigurationError) {
          return json(
            { success: false, error: symbolConfigurationError },
            400
          );
        }

        // Allowed symbols
        const allowedSymbols = parseJsonArray(
          rules.allowed_symbols_json,
          []
        ).map((item) =>
          String(item).toUpperCase()
        );

        if (!allowedSymbols.includes(symbol)) {
          return tradingError("rule_violation", `Symbol ${symbol} is not allowed for this account`, 400);
        }

        try {
          validateVolume(volume, symbolRecord, rules.max_lot_size);
        } catch (error) {
          return tradingError("invalid_volume", error.message, 400);
        }

        let execution;
        try {
          execution = await requireExecutionQuote(env, symbol, side);
        } catch (error) {
          return tradingError(error.code || "market_unavailable", error.message, error.status || 503);
        }
        const openPrice = execution.price;

        if (
          (side === "BUY" && takeProfit !== null && takeProfit <= openPrice) ||
          (side === "SELL" && takeProfit !== null && takeProfit >= openPrice)
        ) {
          return tradingError("invalid_tp", "Take profit must be on the profitable side of entry", 400);
        }
        if (
          (side === "BUY" && stopLoss !== null && stopLoss >= openPrice) ||
          (side === "SELL" && stopLoss !== null && stopLoss <= openPrice)
        ) {
          return tradingError("invalid_sl", "Stop loss must be on the risk side of entry", 400);
        }
        if (Number(rules.stop_loss_required) === 1 && stopLoss === null) {
          return tradingError("rule_violation", "A stop loss is required by this account's rules", 400);
        }
        if (Number(rules.take_profit_required) === 1 && takeProfit === null) {
          return tradingError("rule_violation", "A take profit is required by this account's rules", 400);
        }

        const orderId = generateId("ORD");
        const positionId = generateId("POS");
        const openedAt = new Date().toISOString();
        const symbolMetadata = snapshotSymbolCalculationMetadata(symbolRecord);
        const existingResult = await env.daily_funded_trading_db.prepare(`
          SELECT p.*
          FROM positions p
          INNER JOIN trading_accounts a ON a.id = p.account_id
          WHERE p.account_id = ? AND a.user_id = ? AND p.status = 'open'
        `).bind(accountId, tradingAuth.userId).all();
        const existingPositions = existingResult.results || [];
        if (
          rules.max_open_positions !== null &&
          rules.max_open_positions !== undefined &&
          Number(rules.max_open_positions) > 0 &&
          existingPositions.length >= Number(rules.max_open_positions)
        ) {
          return tradingError("rule_violation", "Maximum open positions reached", 400);
        }

        let existingPnl = 0;
        let existingMargin = 0;
        if (existingPositions.length) {
          const liveQuotes = await getMarketQuotesForSymbols(
            env,
            existingPositions.map((position) => position.symbol)
          );
          const existingQuoteBySymbol = new Map(
            (liveQuotes.quotes || []).map((quote) => [quote.symbol, quote])
          );
          try {
            for (const position of existingPositions) {
              const quote = existingQuoteBySymbol.get(position.symbol);
              const markPrice = position.side === "BUY" ? quote?.bid : quote?.ask;
              if (
                !quote ||
                quote.stale ||
                quote.market_state?.toLowerCase() === "closed" ||
                !Number.isFinite(Number(markPrice)) ||
                Number(markPrice) <= 0
              ) {
                throw Object.assign(new Error("Live market data is required to verify available margin"), {
                  code: "market_unavailable",
                  status: 503,
                });
              }
              const metadata = await getPositionCalculationSnapshot(env, position.id);
              existingPnl += calculatePnlUsd(position, markPrice, metadata);
              existingMargin += marginForPosition(
                position,
                markPrice,
                metadata,
                Number(context.snapshot.leverage)
              );
            }
          } catch (error) {
            return tradingError(error.code || "market_unavailable", error.code ? error.message : "Account margin is unavailable", error.status || 503);
          }
        }

        const leverage = Number(context.snapshot.leverage);
        let requiredMargin;
        try {
          requiredMargin = marginForPosition(
            { volume, open_price: openPrice },
            openPrice,
            symbolMetadata,
            leverage
          );
        } catch {
          return tradingError("insufficient_margin", "Required margin cannot be calculated for this symbol", 400);
        }
        if (Number(account.balance) + existingPnl - existingMargin < requiredMargin) {
          return tradingError("insufficient_margin", "There is not enough free margin for this order", 409);
        }

        if (rules.max_risk_per_trade_percent !== null && rules.max_risk_per_trade_percent !== undefined) {
          if (stopLoss === null) {
            return tradingError("rule_violation", "A stop loss is required by the account risk limit", 400);
          }
          try {
            const risk = Math.abs(calculatePnlUsd(
              { side, volume, open_price: openPrice },
              stopLoss,
              symbolMetadata
            ));
            const maxRisk = Number(account.balance) * Number(rules.max_risk_per_trade_percent) / 100;
            if (!Number.isFinite(maxRisk) || risk > maxRisk) {
              return tradingError("rule_violation", "The order exceeds the maximum risk per trade", 400);
            }
          } catch {
            return tradingError("rule_violation", "The order risk could not be validated", 400);
          }
        }

        await env.daily_funded_trading_db.batch([
          env.daily_funded_trading_db
          .prepare(`
            INSERT INTO orders (
              id,
              account_id,
              symbol,
              side,
              volume,
              requested_price,
              order_type,
              status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            orderId,
            accountId,
            symbol,
            side,
            volume,
            openPrice,
            orderType,
            "filled"
          )
          ,
          env.daily_funded_trading_db
          .prepare(`
            INSERT INTO positions (
              id,
              account_id,
              order_id,
              symbol,
              side,
              volume,
              open_price,
              current_price,
              floating_pnl,
              take_profit,
              stop_loss,
              status,
              opened_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            positionId,
            accountId,
            orderId,
            symbol,
            side,
            volume,
            openPrice,
            openPrice,
            0,
            takeProfit,
            stopLoss,
            "open",
            openedAt
          ),
          env.daily_funded_trading_db
            .prepare(`
              INSERT INTO position_calculation_snapshots (
                position_id,
                metadata_json
              )
              VALUES (?, ?)
            `)
            .bind(positionId, JSON.stringify(symbolMetadata)),
        ]);

        const position = {
          id: positionId,
          account_id: accountId,
          symbol,
          side,
          volume,
          open_price: openPrice,
          opened_at: openedAt,
          current_price: openPrice,
          floating_pnl: 0,
          pnl_metadata: {
            base_currency: symbolMetadata.base_currency,
            quote_currency: symbolMetadata.quote_currency,
            contract_size: symbolMetadata.contract_size,
            price_decimals: symbolMetadata.price_decimals,
            pip_size: symbolMetadata.pip_size,
          },
          take_profit: takeProfit,
          stop_loss: stopLoss,
          status: "open",
        };
        if (symbolRecord.provider === "biquote") {
          try {
            await syncMarketFeedAccount(env, accountId);
          } catch (error) {
            console.error(`Position ${positionId} opened, but the market-feed coordinator did not synchronize it:`, error);
            return json({
              success: false,
              error: "Position was opened but server-side protection state synchronization failed",
              code: "protection_state_sync_failed",
              position_id: positionId,
            }, 503);
          }
        }
        await publishPositionEvent(env, tradingAuth.userId, accountId, {
          type: "POSITION_OPENED",
          position_id: positionId,
          account_id: accountId,
          position,
        });
        return json({
          success: true,
          order: {
            id: orderId,
            account_id: accountId,
            symbol,
            side,
            volume,
            order_type: orderType,
            requested_price: openPrice,
            status: "filled",
          },
          position,
        }, 201);
      }

      // =====================================================
      // MODIFY POSITION PROTECTION LEVELS
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/positions/modify"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const body = await readJson(request);
        const positionId = normalizeText(body.position_id);
        const hasStopLoss = Object.prototype.hasOwnProperty.call(body, "stop_loss");
        const hasTakeProfit = Object.prototype.hasOwnProperty.call(body, "take_profit");
        if (!positionId || (!hasStopLoss && !hasTakeProfit)) {
          return tradingError("rule_violation", "position_id and at least one protection level are required", 400);
        }

        const position = await env.daily_funded_trading_db
          .prepare(`
            SELECT p.*
            FROM positions p
            INNER JOIN trading_accounts a ON a.id = p.account_id
            WHERE p.id = ? AND a.user_id = ? AND p.status = 'open'
          `)
          .bind(positionId, tradingAuth.userId)
          .first();
        if (!position) {
          return tradingError("position_not_found", "Position not found", 404);
        }

        const context = await getAccountRuleContext(
          env,
          position.account_id,
          tradingAuth.userId
        );
        if (context.error) {
          return json({ success: false, error: context.error }, context.status);
        }
        if (context.account.status !== "active") {
          return tradingError("trading_disabled", "Trading account is not active", 409);
        }
        if (Number(context.rules.phase_number) !== Number(context.account.phase_number)) {
          return tradingError("rule_violation", "Trading rules do not match the account's current phase", 400);
        }

        const symbolRecord = await env.daily_funded_trading_db
          .prepare(`
            SELECT *
            FROM trading_symbols
            WHERE symbol = ?
            LIMIT 1
          `)
          .bind(position.symbol)
          .first();
        const symbolConfigurationError = getSymbolConfigurationError(symbolRecord);
        if (symbolConfigurationError) {
          return tradingError("rule_violation", symbolConfigurationError, 400);
        }

        let stopLoss;
        let takeProfit;
        try {
          const requestedLevel = (value, field, code) => {
            if (value === null) return null;
            if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
              throw Object.assign(new Error(`${field} must be a positive number or null`), {
                code,
                status: 400,
              });
            }
            return value;
          };
          stopLoss = hasStopLoss
            ? requestedLevel(body.stop_loss, "stop_loss", "invalid_sl")
            : optionalPositiveNumber(position.stop_loss, "stop_loss", "invalid_sl");
          takeProfit = hasTakeProfit
            ? requestedLevel(body.take_profit, "take_profit", "invalid_tp")
            : optionalPositiveNumber(position.take_profit, "take_profit", "invalid_tp");
        } catch (error) {
          return tradingError(error.code || "rule_violation", error.message, error.status || 400);
        }

        const metadata = snapshotSymbolCalculationMetadata(symbolRecord);
        const alignPrice = (price, field, code) => {
          if (price === null) return null;
          const scale = 10 ** metadata.price_decimals;
          const scaledPrice = price * scale;
          const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaledPrice)) * 8;
          if (Math.abs(scaledPrice - Math.round(scaledPrice)) > tolerance) {
            throw Object.assign(new Error(`${field} must match the symbol's configured price precision`), {
              code,
              status: 400,
            });
          }
          return Number((Math.round(scaledPrice) / scale).toFixed(metadata.price_decimals));
        };

        try {
          stopLoss = alignPrice(stopLoss, "stop_loss", "invalid_sl");
          takeProfit = alignPrice(takeProfit, "take_profit", "invalid_tp");
        } catch (error) {
          return tradingError(error.code || "rule_violation", error.message, error.status || 400);
        }

        if (Number(context.rules.stop_loss_required) === 1 && stopLoss === null) {
          return tradingError("rule_violation", "A stop loss is required by this account's rules", 400);
        }
        if (Number(context.rules.take_profit_required) === 1 && takeProfit === null) {
          return tradingError("rule_violation", "A take profit is required by this account's rules", 400);
        }

        let executablePrice;
        try {
          const execution = await requireExecutionQuote(
            env,
            position.symbol,
            position.side === "BUY" ? "SELL" : "BUY"
          );
          executablePrice = execution.price;
        } catch (error) {
          return tradingError(error.code || "market_unavailable", error.message, error.status || 503);
        }
        let pnlMetadata;
        try {
          pnlMetadata = positionDisplayMetadata(
            await getPositionCalculationSnapshot(env, positionId)
          );
        } catch (error) {
          return tradingError("server_error", error.message, 500);
        }

        if (
          (stopLoss !== null && (position.side === "BUY" ? stopLoss >= executablePrice : stopLoss <= executablePrice))
        ) {
          return tradingError("invalid_sl", "Stop loss is not on the protective side of the current executable price", 400);
        }
        if (
          (takeProfit !== null && (position.side === "BUY" ? takeProfit <= executablePrice : takeProfit >= executablePrice))
        ) {
          return tradingError("invalid_tp", "Take profit is not on the profitable side of the current executable price", 400);
        }

        if (!env.POSITION_EVENTS) {
          return json({ success: false, error: "Position event delivery is not configured" }, 503);
        }
        const actorId = env.POSITION_EVENTS.idFromName(`account:${position.account_id}`);
        const result = await env.POSITION_EVENTS.get(actorId).fetch("https://position-events/modify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            position_id: positionId,
            account_id: position.account_id,
            user_id: tradingAuth.userId,
            has_stop_loss: hasStopLoss,
            stop_loss: stopLoss,
            has_take_profit: hasTakeProfit,
            take_profit: takeProfit,
            pnl_metadata: pnlMetadata,
          }),
        });
        if (!result.ok) return result;
        const resultPayload = await result.json();
        return json(resultPayload);
      }

      // =====================================================
      // UPDATE POSITION PRICE
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/positions/price"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const body = await readJson(request);

        const positionId = normalizeText(
          body.position_id
        );

        if (!positionId) {
          return json(
            {
              success: false,
              error: "position_id is required",
            },
            400
          );
        }

        const position =
          await env.daily_funded_trading_db
            .prepare(`
              SELECT p.*
              FROM positions p
              INNER JOIN trading_accounts a ON a.id = p.account_id
              WHERE p.id = ? AND a.user_id = ? AND p.status = 'open'
            `)
            .bind(positionId, tradingAuth.userId)
            .first();

        if (!position) {
          return tradingError("position_not_found", "Position not found", 404);
        }

        const context = await getAccountRuleContext(
          env,
          position.account_id,
          tradingAuth.userId
        );

        if (context.error) {
          return json({ success: false, error: context.error }, context.status);
        }

        const account = context.account;
        const openPrice = Number(position.open_price);
        const volume = Number(position.volume);
        let price;
        let floatingPnl;
        let totalFloatingPnl;
        try {
          const execution = await requireExecutionQuote(
            env,
            position.symbol,
            position.side === "BUY" ? "SELL" : "BUY"
          );
          price = execution.price;
          const metadata = await getPositionCalculationSnapshot(env, positionId);
          floatingPnl = calculatePnlUsd(position, price, metadata);
          totalFloatingPnl = await calculateOpenPositionsPnlUsd(
            env,
            position.account_id,
            { [positionId]: price }
          );
        } catch (error) {
          return tradingError(error.code || "market_unavailable", error.code ? error.message : "Position price could not be calculated", error.status || 400);
        }

        const newEquity = Number(account.balance) + totalFloatingPnl;

        await env.daily_funded_trading_db
          .prepare(`
            UPDATE positions
            SET
              current_price = ?,
              floating_pnl = ?
            WHERE id = ? AND account_id = ? AND status = 'open'
          `)
          .bind(
            price,
            floatingPnl,
            positionId,
            position.account_id
          )
          .run();

        await env.daily_funded_trading_db
          .prepare(`
            UPDATE trading_accounts
            SET
              equity = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
          `)
          .bind(
            newEquity,
            position.account_id,
            tradingAuth.userId
          )
          .run();

        return json({
          success: true,
          position: {
            id: position.id,
            account_id: position.account_id,
            symbol: position.symbol,
            side: position.side,
            volume,
            open_price: openPrice,
            current_price: price,
            floating_pnl: floatingPnl,
          },
          account: {
            balance: Number(account.balance),
            equity: newEquity,
          },
        });
      }

      // =====================================================
      // CLOSE POSITION
      // =====================================================

      if (
        request.method === "POST" &&
        url.pathname === "/positions/close"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const body = await readJson(request);

        const positionId = normalizeText(
          body.position_id
        );

        if (!positionId) {
          return tradingError("position_not_found", "Position not found", 404);
        }

        const position =
          await env.daily_funded_trading_db
            .prepare(`
              SELECT p.*
              FROM positions p
              INNER JOIN trading_accounts a ON a.id = p.account_id
              WHERE p.id = ? AND a.user_id = ? AND p.status = 'open'
            `)
            .bind(positionId, tradingAuth.userId)
            .first();

        if (!position) {
          return tradingError("position_not_found", "Position not found", 404);
        }
        if (!env.POSITION_EVENTS) {
          return json({ success: false, error: "Position event delivery is not configured" }, 503);
        }
        const actorId = env.POSITION_EVENTS.idFromName(`account:${position.account_id}`);
        return env.POSITION_EVENTS.get(actorId).fetch("https://position-events/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "manual",
            position_id: positionId,
            account_id: position.account_id,
            user_id: tradingAuth.userId,
          }),
        });
      }

      // =====================================================
      // TRADE HISTORY
      // =====================================================

      if (
        request.method === "GET" &&
        url.pathname === "/trades"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const accountId =
          url.searchParams.get("account_id");

        if (!accountId) {
          return json(
            {
              success: false,
              error: "account_id is required",
            },
            400
          );
        }

        const ownedAccount = await findAccountForUser(
          env,
          accountId,
          tradingAuth.userId
        );
        if (!ownedAccount) {
          return json({ success: false, error: "Trading account not found" }, 404);
        }

        const trades =
          await env.daily_funded_trading_db
            .prepare(`
              SELECT
                t.id,
                t.account_id,
                t.order_id,
                t.symbol,
                t.side,
                t.volume,
                t.open_price,
                t.close_price,
                t.realized_pnl,
                t.opened_at,
                t.closed_at
              FROM trades t
              INNER JOIN trading_accounts a ON a.id = t.account_id
              WHERE t.account_id = ? AND a.user_id = ?
              ORDER BY t.closed_at DESC
            `)
            .bind(accountId, tradingAuth.userId)
            .all();

        return json({
          success: true,
          account_id: accountId,
          trades: trades.results || [],
        });
      }

      // =====================================================
      // GET RULE SNAPSHOT
      // =====================================================

      if (
        request.method === "GET" &&
        url.pathname === "/account-rules"
      ) {
        const tradingAuth = await authenticateTradingRequest(request, env);
        if (tradingAuth.response) return tradingAuth.response;

        const accountId =
          url.searchParams.get("account_id");

        if (!accountId) {
          return json(
            {
              success: false,
              error: "account_id is required",
            },
            400
          );
        }

        const context = await getAccountRuleContext(
          env,
          accountId,
          tradingAuth.userId
        );

        if (context.error) {
          const status = context.error === "Trading rules are not configured for this account"
            ? 404
            : context.status;
          return json({ success: false, error: context.error }, status);
        }

        return json({
          success: true,
          rules: context.rules,
        });
      }

      // =====================================================
      // FALLBACK
      // =====================================================

      return withMarketCors(json(
        {
          success: false,
          error: "Route not found",
        },
        404
      ), request);
    } catch (error) {
      return withMarketCors(json(
        {
          success: false,
          error: "Internal server error",
        },
        500
      ), request);
    }
  },
  async scheduled(_controller, env, context) {
    context.waitUntil((async () => {
      try {
        const response = await marketFeedStub(env).fetch("https://market-feed/ensure", {
          method: "POST",
        });
        if (!response.ok) {
          console.error(`Scheduled Biquote feed activation failed (${response.status})`);
        }
      } catch (error) {
        console.error("Scheduled Biquote feed activation failed:", error);
      }
    })());
  },
};