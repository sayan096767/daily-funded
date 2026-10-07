import { MarketFeedDO } from "../src/index.flexible.js";
import { BIQUOTE_HUB_URL, parseSignalRFrames } from "../src/biquoteSignalR.js";
import {
  protectionPrice,
  triggeredProtection,
} from "../src/positionProtection.js";

const PROVIDER_SYMBOLS = ["USTEC"];
const TEST_USER_ID = "isolated-sltp-test-user";
const TEST_ACCOUNT_RULES = {
  challenge_size: 100_000,
  leverage: 100,
  profit_target_percent: 10,
  daily_drawdown_percent: 5,
  max_drawdown_percent: 10,
  max_drawdown_type: "STATIC",
  daily_drawdown_type: "START_OF_DAY_EQUITY",
  minimum_trading_days: 0,
  profit_split_percent: 80,
  allowed_symbols_json: JSON.stringify(["USTEC"]),
  custom_rules_json: "{}",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function instrumentTestDatabase(database) {
  const metrics = {
    executed_statements: 0,
    full_open_position_scans: 0,
    market_tick_cursor_writes: 0,
  };
  const statementTargets = new WeakMap();
  const statementSql = new WeakMap();
  const record = (sql) => {
    metrics.executed_statements += 1;
    if (/^\s*SELECT\s+p\.\*,\s*a\.user_id\s+FROM\s+positions\s+p/i.test(sql)) {
      metrics.full_open_position_scans += 1;
    }
    if (/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+market_tick_cursors/i.test(sql)) {
      metrics.market_tick_cursor_writes += 1;
    }
  };
  const wrapStatement = (statement, sql) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
      const value = target[property];
      if (property === "bind") {
        return (...args) => wrapStatement(value.apply(target, args), sql);
      }
      if (["all", "first", "run", "raw"].includes(property)) {
        return async (...args) => {
          const result = await value.apply(target, args);
          record(sql);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statementTargets.set(wrapped, statement);
    statementSql.set(wrapped, sql);
    return wrapped;
  };
  const wrappedDatabase = new Proxy(database, {
    get(target, property) {
      const value = target[property];
      if (property === "prepare") {
        return (sql) => wrapStatement(value.call(target, sql), sql);
      }
      if (property === "batch") {
        return async (statements) => {
          const rawStatements = statements.map((statement) =>
            statementTargets.get(statement) || statement
          );
          const result = await value.call(target, rawStatements);
          for (const statement of statements) record(statementSql.get(statement) || "");
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrappedDatabase, metrics };
}

function eventStub(env, userId = TEST_USER_ID) {
  return env.TEST_POSITION_EVENTS.get(
    env.TEST_POSITION_EVENTS.idFromName(`user:${userId}`)
  );
}

async function readTestEvents(env, accountId) {
  const response = await eventStub(env).fetch(
    `https://test-position-events/events?account_id=${encodeURIComponent(accountId)}`
  );
  if (!response.ok) throw new Error(`Test event read failed (${response.status})`);
  return response.json();
}

async function latestUstecQuote() {
  const response = await fetch("https://biquote.io/api/latest?symbols=USTEC", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Biquote USTEC quote failed (${response.status})`);
  const payload = await response.json();
  const quote = payload?.USTEC;
  const timestampMs = Date.parse(quote?.timestamp);
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!quote || quote.stale || !Number.isFinite(timestampMs) ||
    Date.now() - timestampMs > 60_000 || timestampMs > Date.now() + 60_000 ||
    !Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask < bid) {
    throw new Error("Biquote did not return a fresh, valid USTEC quote");
  }
  return {
    bid,
    ask,
    provider_timestamp: new Date(timestampMs).toISOString(),
    opened_at: new Date(timestampMs).toISOString(),
  };
}

async function readLatestRun(database) {
  return database.prepare(`
    SELECT run_id, account_id, phase
    FROM isolated_sltp_runs
    ORDER BY created_at DESC
    LIMIT 1
  `).first();
}

async function readPositionResult(database, positionId) {
  return database.prepare(`
    SELECT audit.*, position.status, position.close_price, position.realized_pnl,
           position.closed_at, position.open_price, position.stop_loss,
           position.opened_at, position.side, position.volume
    FROM isolated_sltp_positions audit
    INNER JOIN positions position ON position.id = audit.position_id
    WHERE audit.position_id = ?
  `).bind(positionId).first();
}

async function seedPosition(env, runId, accountId, side) {
  const quote = await latestUstecQuote();
  const entry = side === "BUY" ? quote.ask : quote.bid;
  const stopLoss = Number((side === "BUY" ? quote.bid - 0.01 : quote.ask + 0.01).toFixed(2));
  if (stopLoss <= 0 || (side === "BUY" ? stopLoss >= entry : stopLoss <= entry)) {
    throw new Error("The live quote did not permit a valid close stop loss");
  }
  const positionId = `TEST_POS_${crypto.randomUUID()}`;
  const orderId = `TEST_ORDER_${crypto.randomUUID()}`;
  const volume = 0.01;
  const database = env.daily_funded_trading_db;
  const statements = [
    database.prepare(`
      INSERT OR IGNORE INTO trading_symbols (
        id, symbol, display_name, category, base_currency, quote_currency,
        volume_unit, contract_size, price_decimals, pip_size, lot_step,
        minimum_lot, maximum_lot, trading_enabled, provider, provider_symbol,
        market_data_enabled
      ) VALUES (
        'TEST_SYMBOL_USTEC', 'USTEC', 'US Tech 100 Index', 'INDEX',
        'USTEC', 'USD', 'lot', 1, 2, 0.01, 0.01, 0.01, NULL, 1,
        'biquote', 'USTEC', 1
      )
    `),
    ...(side === "BUY" ? [
      database.prepare(`
        INSERT INTO trading_accounts (
          id, user_id, challenge_model, phase_number, challenge_size,
          starting_balance, balance, equity, status
        ) VALUES (?, ?, 'ISOLATED_TEST', 1, 100000, 100000, 100000, 100000, 'active')
      `).bind(accountId, TEST_USER_ID),
      database.prepare(`
        INSERT INTO account_rule_snapshots (
          id, account_id, phase_number, challenge_size, leverage,
          profit_target_percent, daily_drawdown_percent, max_drawdown_percent,
          max_drawdown_type, daily_drawdown_type, minimum_trading_days,
          profit_split_percent, allowed_symbols_json, custom_rules_json
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        `TEST_RULE_${runId}`, accountId,
        TEST_ACCOUNT_RULES.challenge_size,
        TEST_ACCOUNT_RULES.leverage,
        TEST_ACCOUNT_RULES.profit_target_percent,
        TEST_ACCOUNT_RULES.daily_drawdown_percent,
        TEST_ACCOUNT_RULES.max_drawdown_percent,
        TEST_ACCOUNT_RULES.max_drawdown_type,
        TEST_ACCOUNT_RULES.daily_drawdown_type,
        TEST_ACCOUNT_RULES.minimum_trading_days,
        TEST_ACCOUNT_RULES.profit_split_percent,
        TEST_ACCOUNT_RULES.allowed_symbols_json,
        TEST_ACCOUNT_RULES.custom_rules_json
      ),
      database.prepare(`
        INSERT INTO isolated_sltp_runs (run_id, account_id, phase, created_at)
        VALUES (?, ?, 'BUY_RUNNING', ?)
      `).bind(runId, accountId, new Date().toISOString()),
    ] : []),
    database.prepare(`
      INSERT INTO orders (
        id, account_id, symbol, side, volume, requested_price,
        order_type, status, created_at
      ) VALUES (?, ?, 'USTEC', ?, ?, ?, 'MARKET', 'open', ?)
    `).bind(orderId, accountId, side, volume, entry, quote.opened_at),
    database.prepare(`
      INSERT INTO positions (
        id, account_id, order_id, symbol, side, volume, open_price,
        current_price, floating_pnl, take_profit, stop_loss, status, opened_at
      ) VALUES (?, ?, ?, 'USTEC', ?, ?, ?, ?, 0, NULL, ?, 'open', ?)
    `).bind(
      positionId, accountId, orderId, side, volume, entry, entry, stopLoss, quote.opened_at
    ),
    database.prepare(`
      INSERT INTO position_calculation_snapshots (position_id, metadata_json)
      VALUES (?, ?)
    `).bind(positionId, JSON.stringify({
      symbol: "USTEC",
      base_currency: "USTEC",
      quote_currency: "USD",
      volume_unit: "lot",
      contract_size: 1,
      price_decimals: 2,
      pip_size: 0.01,
      lot_step: 0.01,
      minimum_lot: 0.01,
      maximum_lot: null,
    })),
    database.prepare(`
      INSERT INTO isolated_sltp_positions (
        position_id, run_id, side, opened_at, entry_price, stop_loss,
        initial_bid, initial_ask, provider_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      positionId, runId, side, quote.opened_at, entry, stopLoss,
      quote.bid, quote.ask, quote.provider_timestamp
    ),
  ];
  await database.batch(statements);
  return {
    position_id: positionId,
    order_id: orderId,
    side,
    opened_at: quote.opened_at,
    entry,
    stop_loss: stopLoss,
    initial_bid: quote.bid,
    initial_ask: quote.ask,
    provider_timestamp: quote.provider_timestamp,
    volume,
  };
}

async function negotiateTestSignalR() {
  const hub = new URL(BIQUOTE_HUB_URL);
  const negotiateUrl = new URL(hub);
  negotiateUrl.pathname = `${negotiateUrl.pathname.replace(/\/+$/, "")}/negotiate`;
  negotiateUrl.searchParams.set("negotiateVersion", "1");
  const response = await fetch(negotiateUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: "",
    signal: AbortSignal.timeout(10_000),
  });
  const negotiateStatus = response.status;
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Biquote SignalR negotiate failed (${negotiateStatus})`);
  }
  const negotiation = await response.json();
  if (!negotiation.availableTransports?.some((item) => item.transport === "WebSockets")) {
    throw new Error("Biquote SignalR does not offer WebSockets");
  }
  const connectionToken = negotiation.connectionToken || negotiation.connectionId;
  if (typeof connectionToken !== "string" || !connectionToken) {
    throw new Error("Biquote SignalR negotiation returned no connection token");
  }

  const socketUrl = new URL(hub);
  socketUrl.searchParams.set("id", connectionToken);
  return { socketUrl, negotiateStatus };
}

class IsolatedMarketFeedDO extends MarketFeedDO {
  constructor(state, env) {
    const instrumented = instrumentTestDatabase(env.daily_funded_trading_db);
    super(state, {
      ...env,
      daily_funded_trading_db: instrumented.database,
      POSITION_EVENTS: env.TEST_POSITION_EVENTS,
    });
    this.d1Metrics = instrumented.metrics;
    this.receivedTickEvents = 0;
    this.receiveTickCountBySymbol = new Map();
    this.firstReceiveTickBySymbol = new Map();
    this.lastReceiveTickBySymbol = new Map();
    this.acceptedTicksBySymbol = new Map();
    this.acceptedTicksByMinute = new Map();
    this.normalizedRealTicksBySymbol = new Map();
    this.normalizedRealTicksByMinute = new Map();
    this.lastNormalizedProviderTimestamp = new Map();
    this.normalizedRealTickSamples = [];
    this.firstAcceptedTick = null;
    this.lastAcceptedTickBySymbol = new Map();
    this.negotiateStatuses = [];
    this.webSocketUpgradeStatuses = [];
    this.handshakeSuccesses = 0;
    this.subscribeSuccesses = 0;
    this.successfulConnections = 0;
    this.connectionErrors = [];
    this.receiveTickPayloadSamples = [];
    this.receiveTickNormalizationSamples = [];
    this.closeEvents = [];
    this.triggerProofs = [];
    this.nonTriggerRealTickCount = 0;
    this.nonTriggerD1StatementCount = 0;
    this.nonTriggerFullPositionScanCount = 0;
  }

  async openSignalRConnection() {
    const previousConnection = this.activeConnection;
    const generation = ++this.connectionGeneration;
    let candidate = null;
    try {
      await this.refreshProviderBaselines();
      const { socketUrl, negotiateStatus } = await negotiateTestSignalR();
      this.negotiateStatuses.push(negotiateStatus);
      const response = await fetch(socketUrl, {
        headers: { Upgrade: "websocket" },
      });
      this.webSocketUpgradeStatuses.push(response.status);
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        throw new Error(`Biquote WebSocket upgrade failed (${response.status})`);
      }

      socket.accept();
      candidate = {
        socket,
        generation,
        active: false,
        buffer: "",
        testProbeBuffer: "",
        handshakeComplete: false,
        subscriptionInvocationId: `test-subscribe-${this.nextInvocationId++}`,
        connectedAt: Date.now(),
        lastMessageAt: Date.now(),
        intentionalClose: false,
        ready: null,
        resolveReady: null,
        rejectReady: null,
      };
      candidate.ready = new Promise((resolve, reject) => {
        candidate.resolveReady = resolve;
        candidate.rejectReady = reject;
      });
      this.connections.add(candidate);
      socket.addEventListener("message", (event) => {
        void this.handleSocketMessage(candidate, event.data);
      });
      socket.addEventListener("close", (event) => {
        this.closeEvents.push({
          code: event.code,
          reason: event.reason,
          timestamp: new Date().toISOString(),
        });
        this.handleSocketClosed(candidate, "close");
      });
      socket.addEventListener("error", () => this.handleSocketClosed(candidate, "error"));
      socket.send(`${JSON.stringify({ protocol: "json", version: 1 })}\x1e`);

      let handshakeTimeout;
      try {
        await Promise.race([
          candidate.ready,
          new Promise((_, reject) => {
            handshakeTimeout = setTimeout(
              () => reject(new Error("Biquote SignalR handshake or Subscribe timed out")),
              15_000
            );
          }),
        ]);
      } finally {
        clearTimeout(handshakeTimeout);
      }

      candidate.active = true;
      this.activeConnection = candidate;
      this.metrics.reconnects += 1;
      this.successfulConnections += 1;
      if (previousConnection && previousConnection !== candidate) {
        previousConnection.active = false;
        previousConnection.intentionalClose = true;
        previousConnection.socket.close(1000, "Isolated test feed refreshed");
      }
      console.info(JSON.stringify({
        event: "isolated_biquote_connected",
        negotiate_status: negotiateStatus,
        websocket_upgrade_status: response.status,
        handshake: "succeeded",
        subscribe: "succeeded",
        subscribed_symbols: PROVIDER_SYMBOLS.length,
        generation,
      }));
      return { connected: true };
    } catch (error) {
      if (candidate) {
        candidate.intentionalClose = true;
        candidate.rejectReady?.(error);
        this.connections.delete(candidate);
        candidate.socket.close(1011, "Isolated Biquote setup failed");
      }
      this.connectionErrors.push(error.message);
      console.error("Isolated Biquote SignalR connection failed:", error);
      if (this.activeConnection === previousConnection &&
        previousConnection?.socket.readyState === WebSocket.OPEN) {
        return { connected: true, refresh_failed: true };
      }
      return { connected: false, error: error.message };
    }
  }

  async handleSocketMessage(connection, data) {
    const parsed = parseSignalRFrames(connection.testProbeBuffer || "", data);
    connection.testProbeBuffer = parsed.buffer;
    for (const frame of parsed.frames) {
      if (frame.type === 1 && String(frame.target).toLowerCase() === "receivetick") {
        this.receivedTickEvents += 1;
        const args = Array.isArray(frame.arguments) ? frame.arguments : [];
        for (const argument of args) {
          const providerSymbol = String(argument?.symbol ?? argument?.Symbol ?? "").toUpperCase();
          const symbol = this.symbolByProvider.get(providerSymbol);
          const rawTimestamp = argument?.timestamp ?? argument?.Timestamp ??
            argument?.time ?? argument?.Time;
          const timestampMs = typeof rawTimestamp === "number"
            ? rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp
            : typeof rawTimestamp === "string" && /^\d+(\.\d+)?$/.test(rawTimestamp)
              ? Number(rawTimestamp) < 1_000_000_000_000
                ? Number(rawTimestamp) * 1000
                : Number(rawTimestamp)
              : Date.parse(rawTimestamp);
          const bid = Number(argument?.bid ?? argument?.Bid);
          const ask = Number(argument?.ask ?? argument?.Ask);
          if (symbol) {
            const receiveTick = {
              provider_symbol: providerSymbol,
              provider_timestamp: rawTimestamp ?? null,
              parsed_provider_timestamp: Number.isFinite(timestampMs)
                ? new Date(timestampMs).toISOString()
                : null,
              bid: Number.isFinite(bid) ? bid : null,
              ask: Number.isFinite(ask) ? ask : null,
            };
            this.receiveTickCountBySymbol.set(
              symbol,
              (this.receiveTickCountBySymbol.get(symbol) || 0) + 1
            );
            if (!this.firstReceiveTickBySymbol.has(symbol)) {
              this.firstReceiveTickBySymbol.set(symbol, receiveTick);
            }
            this.lastReceiveTickBySymbol.set(symbol, receiveTick);
          }
          const previousTimestamp = this.lastNormalizedProviderTimestamp.get(symbol);
          if (symbol && Number.isFinite(timestampMs) &&
            Date.now() - timestampMs <= 5 * 60 * 1000 &&
            timestampMs <= Date.now() + 60_000 &&
            Number.isFinite(bid) && bid > 0 &&
            Number.isFinite(ask) && ask >= bid &&
            (previousTimestamp === undefined || timestampMs > previousTimestamp)) {
            this.lastNormalizedProviderTimestamp.set(symbol, timestampMs);
            this.normalizedRealTicksBySymbol.set(
              symbol,
              (this.normalizedRealTicksBySymbol.get(symbol) || 0) + 1
            );
            const minute = Math.floor(Date.now() / 60_000);
            const counts = this.normalizedRealTicksByMinute.get(minute) || new Map();
            counts.set(symbol, (counts.get(symbol) || 0) + 1);
            this.normalizedRealTicksByMinute.set(minute, counts);
            if (this.normalizedRealTickSamples.length < 20) {
              this.normalizedRealTickSamples.push({
                symbol,
                provider_symbol: providerSymbol,
                provider_timestamp: new Date(timestampMs).toISOString(),
                bid,
                ask,
              });
            }
          }
          const timestamp = rawTimestamp;
          if (this.receiveTickNormalizationSamples.length < 20) {
            this.receiveTickNormalizationSamples.push({
              provider_symbol: providerSymbol,
              mapped_symbol: symbol || null,
              timestamp: timestamp ?? null,
              parsed_timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : null,
              current_time_ms: Date.now(),
              timestamp_age_ms: Number.isFinite(timestampMs) ? Date.now() - timestampMs : null,
              trusted_baseline: symbol ? this.safeAfterTimestamp.get(symbol) ?? null : null,
              trusted_symbol: symbol ? this.trustedSymbols.has(symbol) : false,
              bid: argument?.bid ?? argument?.Bid ?? null,
              ask: argument?.ask ?? argument?.Ask ?? null,
              connection_is_active: this.activeConnection === connection,
            });
          }
        }
        if (this.receiveTickPayloadSamples.length < 5) {
          this.receiveTickPayloadSamples.push(args.map((argument) => ({
            type: Array.isArray(argument) ? "array" : typeof argument,
            keys: argument && typeof argument === "object" && !Array.isArray(argument)
              ? Object.keys(argument)
              : undefined,
            sample: JSON.stringify(argument)?.slice(0, 500),
          })));
        }
      }
      if (!connection.handshakeComplete && !frame.error) {
        this.handshakeSuccesses += 1;
      }
      if (frame.type === 3 && frame.invocationId === connection.subscriptionInvocationId &&
        !frame.error) {
        this.subscribeSuccesses += 1;
      }
    }
    await super.handleSocketMessage(connection, data);
  }

  async acceptTick(tick) {
    const candidates = [...this.positionsById.values()].filter((position) =>
      position.symbol === tick.symbol && triggeredProtection(position, tick)
    );
    const queryCountBeforeTick = this.d1Metrics.executed_statements;
    const scanCountBeforeTick = this.d1Metrics.full_open_position_scans;
    const result = await super.acceptTick(tick);
    if (result.accepted && candidates.length === 0) {
      this.nonTriggerRealTickCount += 1;
      this.nonTriggerD1StatementCount +=
        this.d1Metrics.executed_statements - queryCountBeforeTick;
      this.nonTriggerFullPositionScanCount +=
        this.d1Metrics.full_open_position_scans - scanCountBeforeTick;
    }
    if (!result.accepted) return result;

    const count = (this.acceptedTicksBySymbol.get(tick.symbol) || 0) + 1;
    this.acceptedTicksBySymbol.set(tick.symbol, count);
    const minute = Math.floor(Date.now() / 60_000);
    const minuteCounts = this.acceptedTicksByMinute.get(minute) || new Map();
    minuteCounts.set(tick.symbol, (minuteCounts.get(tick.symbol) || 0) + 1);
    this.acceptedTicksByMinute.set(minute, minuteCounts);

    const sample = {
      provider_timestamp: new Date(tick.timestamp_ms).toISOString(),
      bid: tick.bid,
      ask: tick.ask,
    };
    if (!this.firstAcceptedTick) {
      this.firstAcceptedTick = { symbol: tick.symbol, ...sample };
    }
    this.lastAcceptedTickBySymbol.set(tick.symbol, sample);

    for (const candidate of candidates) {
      const position = await this.env.daily_funded_trading_db.prepare(`
        SELECT * FROM positions WHERE id = ?
      `).bind(candidate.id).first();
      if (position?.status !== "closed") continue;
      const events = await readTestEvents(this.env, candidate.account_id);
      const closeEvents = events.events.filter((event) =>
        event.event?.type === "POSITION_CLOSED" &&
        event.event?.position_id === candidate.id
      );
      const triggerPrice = protectionPrice(candidate, tick);
      const writtenRowsBeforeDuplicate = this.metrics.d1SettlementRowsWritten;
      const duplicateResult = await super.acceptTick(tick);
      const positionAfterDuplicate = await this.env.daily_funded_trading_db.prepare(`
        SELECT status, close_price, realized_pnl FROM positions WHERE id = ?
      `).bind(candidate.id).first();
      const tradeCount = await this.env.daily_funded_trading_db.prepare(`
        SELECT COUNT(*) AS count FROM trades WHERE order_id = ?
      `).bind(candidate.order_id).first();
      const eventsAfterDuplicate = await readTestEvents(this.env, candidate.account_id);
      this.triggerProofs.push({
        position_id: candidate.id,
        side: candidate.side,
        protection_triggered: true,
        trigger_reason: candidate.side === "BUY" ? "STOP_LOSS" : "STOP_LOSS",
        trigger_tick: {
          provider_timestamp: new Date(tick.timestamp_ms).toISOString(),
          bid: tick.bid,
          ask: tick.ask,
        },
        close_price: position.close_price,
        close_price_matches_protection_price: Number(position.close_price) === triggerPrice,
        realized_pnl: Number(position.realized_pnl),
        expected_realized_pnl: (candidate.side === "BUY" ? 1 : -1) *
          (triggerPrice - Number(candidate.open_price)) * Number(candidate.volume),
        d1_status: position.status,
        position_closed_event_count: closeEvents.length,
        event_emitted: closeEvents.length === 1,
        duplicate_tick_result: duplicateResult,
        duplicate_blocked: !duplicateResult.accepted &&
          duplicateResult.reason === "duplicate_or_out_of_order",
        status_after_duplicate: positionAfterDuplicate?.status || null,
        close_price_after_duplicate: positionAfterDuplicate?.close_price ?? null,
        trade_count_after_duplicate: Number(tradeCount?.count || 0),
        position_closed_events_after_duplicate: eventsAfterDuplicate.events.filter(
          (event) => event.event?.type === "POSITION_CLOSED" &&
            event.event?.position_id === candidate.id
        ).length,
        settlement_rows_unchanged_on_duplicate:
          this.metrics.d1SettlementRowsWritten === writtenRowsBeforeDuplicate,
      });
    }
    return result;
  }

  metricsSnapshot() {
    const current = this.acceptedTicksByMinute.get(Math.floor(Date.now() / 60_000)) || new Map();
    const acceptedTickTotal = [...this.acceptedTicksBySymbol.values()]
      .reduce((total, count) => total + count, 0);
    return {
      ...super.metricsSnapshot(),
      test_only: true,
      received_tick_events: this.receivedTickEvents,
      accepted_real_ticks_total: acceptedTickTotal,
      accepted_real_ticks_by_symbol: Object.fromEntries(this.acceptedTicksBySymbol),
      accepted_real_ticks_current_minute: Object.fromEntries(current),
      normalized_real_ticks_total: [...this.normalizedRealTicksBySymbol.values()]
        .reduce((total, count) => total + count, 0),
      normalized_real_ticks_by_symbol: Object.fromEntries(this.normalizedRealTicksBySymbol),
      normalized_real_ticks_current_minute: Object.fromEntries(
        this.normalizedRealTicksByMinute.get(Math.floor(Date.now() / 60_000)) || new Map()
      ),
      normalized_symbols_with_ticks: [...this.normalizedRealTicksBySymbol.keys()].sort(),
      normalized_symbols_without_ticks: PROVIDER_SYMBOLS.filter(
        (symbol) => !this.normalizedRealTicksBySymbol.has(symbol)
      ),
      normalized_real_tick_samples: this.normalizedRealTickSamples,
      symbols_with_real_ticks: [...this.acceptedTicksBySymbol.keys()].sort(),
      symbols_without_real_ticks: PROVIDER_SYMBOLS.filter(
        (symbol) => !this.acceptedTicksBySymbol.has(symbol)
      ),
      first_accepted_real_tick: this.firstAcceptedTick,
      last_accepted_real_tick_by_symbol: Object.fromEntries(this.lastAcceptedTickBySymbol),
      negotiate_http_statuses: this.negotiateStatuses,
      websocket_upgrade_http_statuses: this.webSocketUpgradeStatuses,
      signalr_handshake_successes: this.handshakeSuccesses,
      subscribe_successes: this.subscribeSuccesses,
      successful_connections: this.successfulConnections,
      receive_tick_count_by_symbol: Object.fromEntries(this.receiveTickCountBySymbol),
      first_receive_tick_by_symbol: Object.fromEntries(this.firstReceiveTickBySymbol),
      last_receive_tick_by_symbol: Object.fromEntries(this.lastReceiveTickBySymbol),
      connection_errors: this.connectionErrors,
      receive_tick_payload_samples: this.receiveTickPayloadSamples,
      receive_tick_normalization_samples: this.receiveTickNormalizationSamples,
      websocket_close_events: this.closeEvents,
      trigger_proofs: this.triggerProofs,
      non_trigger_real_tick_count: this.nonTriggerRealTickCount,
      non_trigger_tick_d1_statements: this.nonTriggerD1StatementCount,
      non_trigger_tick_full_position_scans: this.nonTriggerFullPositionScanCount,
      d1_executed_statements: this.d1Metrics.executed_statements,
      d1_full_open_position_scans: this.d1Metrics.full_open_position_scans,
      d1_market_tick_cursor_writes: this.d1Metrics.market_tick_cursor_writes,
      production_settlement_enabled: false,
      test_only_d1_binding: true,
    };
  }

  async forceReconnectForTest() {
    const current = this.activeConnection;
    if (current) {
      current.intentionalClose = true;
      this.activeConnection = null;
      current.socket.close(4001, "Isolated test reconnect");
    }
    return this.ensureConnection();
  }

  async forceAlarmRefreshForTest() {
    if (this.activeConnection) {
      this.activeConnection.connectedAt = Date.now() - 11 * 60 * 1000;
    }
    await this.alarm();
    return { connected: Boolean(this.activeConnection) };
  }

  async stopForTest() {
    const current = this.activeConnection;
    this.activeConnection = null;
    if (current) {
      current.intentionalClose = true;
      current.socket.close(1000, "Isolated test complete");
    }
    await this.state.storage.deleteAlarm();
    return this.metricsSnapshot();
  }

  async fetch(request) {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/ensure") {
      await this.scheduleNextAlarm();
      const result = await this.ensureConnection();
      return json({
        success: result.connected,
        connected: result.connected,
        symbols: PROVIDER_SYMBOLS.length,
        error: result.error,
        metrics: this.metricsSnapshot(),
      }, result.connected ? 200 : 503);
    }
    if (request.method === "POST" && path === "/test-force-reconnect") {
      const previousConnections = this.successfulConnections;
      const result = await this.forceReconnectForTest();
      return json({
        ...result,
        prior_successful_connections: previousConnections,
        metrics: this.metricsSnapshot(),
      }, result.connected ? 200 : 503);
    }
    if (request.method === "POST" && path === "/test-alarm-refresh") {
      const result = await this.forceAlarmRefreshForTest();
      return json({ ...result, metrics: this.metricsSnapshot() }, result.connected ? 200 : 503);
    }
    if (request.method === "POST" && path === "/test-stop") {
      return json({ stopped: true, metrics: await this.stopForTest() });
    }
    if (request.method === "POST" && path === "/test-refresh-account") {
      const body = await request.json();
      const positions = await this.refreshAccountPositions(body.account_id);
      return json({
        refreshed_positions: positions.length,
        metrics: this.metricsSnapshot(),
      });
    }
    return super.fetch(request);
  }
}

export class TestPositionEventsDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      const body = await request.json();
      if (body.event?.type !== "POSITION_CLOSED" ||
        typeof body.account_id !== "string" ||
        typeof body.event.position_id !== "string") {
        return json({ success: false, error: "Invalid isolated position event" }, 400);
      }
      const events = await this.state.storage.get("events") || [];
      events.push({
        account_id: body.account_id,
        event: body.event,
        emitted_at: new Date().toISOString(),
      });
      await this.state.storage.put("events", events);
      return json({ success: true });
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const accountId = url.searchParams.get("account_id");
      const events = await this.state.storage.get("events") || [];
      return json({
        events: events.filter((item) => !accountId || item.account_id === accountId),
      });
    }
    return json({ success: false, error: "Not found" }, 404);
  }
}

export { IsolatedMarketFeedDO as TestMarketFeedDO };

async function getFeedStub(env, runId) {
  const stub = env.TEST_MARKET_FEED.get(
    env.TEST_MARKET_FEED.idFromName(`real-sltp-ustec-${runId}`)
  );
  return stub;
}

async function readFeedMetrics(stub) {
  const response = await stub.fetch("https://test-feed/metrics");
  if (!response.ok) throw new Error(`Isolated feed metrics failed (${response.status})`);
  return response.json();
}

async function runPositionSummaries(env, database, runId) {
  const { results = [] } = await database.prepare(`
    SELECT position_id, side
    FROM isolated_sltp_positions
    WHERE run_id = ?
    ORDER BY rowid
  `).bind(runId).all();
  const run = await readLatestRun(database);
  const stub = await getFeedStub(env, runId);
  const feedMetrics = await readFeedMetrics(stub);
  const positions = await Promise.all(results.map(async ({ position_id }) => {
    const [position, trade, events] = await Promise.all([
      readPositionResult(database, position_id),
      database.prepare(`
        SELECT * FROM trades
        WHERE order_id = (SELECT order_id FROM positions WHERE id = ?)
      `).bind(position_id).first(),
      readTestEvents(env, run.account_id),
    ]);
    return {
      ...position,
      trade,
      events: events.events.filter((item) =>
        item.event?.type === "POSITION_CLOSED" &&
        item.event?.position_id === position_id
      ),
      trigger_proof: feedMetrics.trigger_proofs.find(
        (proof) => proof.position_id === position_id
      ) || null,
    };
  }));
  return { run, positions, feed_metrics: feedMetrics };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.TEST_CONTROL_PATH || url.pathname !== env.TEST_CONTROL_PATH) {
      return json({ success: false, error: "Not found" }, 404);
    }
    const expectedToken = env.TEST_CONTROL_TOKEN;
    if (!expectedToken || request.headers.get("Authorization") !== `Bearer ${expectedToken}`) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    const action = url.searchParams.get("action");
    const database = env.daily_funded_trading_db;

    if (request.method === "POST" && action === "start-buy") {
      const open = await database.prepare(`
        SELECT COUNT(*) AS count FROM positions WHERE status = 'open'
      `).first();
      if (Number(open?.count || 0) !== 0) {
        return json({ success: false, error: "An isolated test position is already open" }, 409);
      }
      const runId = crypto.randomUUID();
      const accountId = `TEST_ACC_${runId}`;
      const position = await seedPosition(env, runId, accountId, "BUY");
      const stub = await getFeedStub(env, runId);
      const feedResponse = await stub.fetch("https://test-feed/ensure", { method: "POST" });
      const feed = await feedResponse.json();
      return json({
        success: feedResponse.ok,
        run_id: runId,
        account_id: accountId,
        position,
        feed,
      }, feedResponse.ok ? 200 : 503);
    }

    if (request.method === "POST" && action === "start-sell") {
      const run = await readLatestRun(database);
      if (!run || run.phase !== "BUY_RUNNING") {
        return json({ success: false, error: "No BUY test is ready for SELL" }, 409);
      }
      const { results = [] } = await database.prepare(`
        SELECT position_id FROM isolated_sltp_positions
        WHERE run_id = ? AND side = 'BUY'
      `).bind(run.run_id).all();
      if (results.length !== 1) {
        return json({ success: false, error: "Expected exactly one isolated BUY position" }, 409);
      }
      const buyPosition = await readPositionResult(database, results[0].position_id);
      const stub = await getFeedStub(env, run.run_id);
      const metrics = await readFeedMetrics(stub);
      const buyProof = metrics.trigger_proofs.find(
        (proof) => proof.position_id === buyPosition.position_id
      );
      if (buyPosition.status !== "closed" || !buyProof?.protection_triggered ||
        !buyProof?.close_price_matches_protection_price || !buyProof?.event_emitted ||
        !buyProof?.duplicate_blocked) {
        return json({
          success: false,
          error: "BUY protection, D1 settlement, event, or duplicate proof is incomplete",
          buy_position: buyPosition,
          buy_proof: buyProof || null,
        }, 409);
      }
      const open = await database.prepare(`
        SELECT COUNT(*) AS count FROM positions WHERE status = 'open'
      `).first();
      if (Number(open?.count || 0) !== 0) {
        return json({ success: false, error: "BUY position is not the only open test position" }, 409);
      }
      const position = await seedPosition(env, run.run_id, run.account_id, "SELL");
      await database.prepare(`
        UPDATE isolated_sltp_runs SET phase = 'SELL_RUNNING' WHERE run_id = ?
      `).bind(run.run_id).run();
      const refreshResponse = await stub.fetch("https://test-feed/test-refresh-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: run.account_id }),
      });
      const refreshed = await refreshResponse.json();
      return json({
        success: refreshResponse.ok,
        run_id: run.run_id,
        account_id: run.account_id,
        position,
        refreshed,
      }, refreshResponse.ok ? 200 : 503);
    }

    if (request.method === "GET" && action === "status") {
      const run = await readLatestRun(database);
      if (!run) return json({ success: true, run: null, positions: [] });
      return json({
        success: true,
        ...(await runPositionSummaries(env, database, run.run_id)),
      });
    }

    if (request.method === "POST" && action === "resume-feed") {
      const run = await readLatestRun(database);
      if (!run) return json({ success: false, error: "Isolated run not found" }, 404);
      const stub = await getFeedStub(env, run.run_id);
      const response = await stub.fetch("https://test-feed/ensure", { method: "POST" });
      const result = await response.json();
      return json(result, response.status);
    }

    if (request.method === "POST" && action === "arm-near-stop") {
      const run = await readLatestRun(database);
      const side = url.searchParams.get("side");
      if (!run || !["BUY", "SELL"].includes(side)) {
        return json({ success: false, error: "A run and BUY/SELL side are required" }, 400);
      }
      const position = await database.prepare(`
        SELECT audit.position_id, audit.side, position.status, position.open_price,
               position.account_id
        FROM isolated_sltp_positions audit
        INNER JOIN positions position ON position.id = audit.position_id
        WHERE audit.run_id = ? AND audit.side = ?
      `).bind(run.run_id, side).first();
      if (!position || position.status !== "open") {
        return json({ success: false, error: "Open isolated test position not found" }, 409);
      }
      const quote = await latestUstecQuote();
      const stopLoss = Number((
        side === "BUY" ? quote.bid + 2.5 : quote.ask + 0.01
      ).toFixed(2));
      if (stopLoss <= 0 || (side === "SELL" && stopLoss <= quote.ask)) {
        return json({
          success: false,
          error: "Current live quote cannot place a reachable protective stop",
          quote,
        }, 409);
      }
      await database.batch([
        database.prepare(`
          UPDATE positions SET stop_loss = ?
          WHERE id = ? AND account_id = ? AND status = 'open'
        `).bind(stopLoss, position.position_id, position.account_id),
        database.prepare(`
          UPDATE isolated_sltp_positions SET stop_loss = ?
          WHERE position_id = ? AND run_id = ?
        `).bind(stopLoss, position.position_id, run.run_id),
      ]);
      const stub = await getFeedStub(env, run.run_id);
      const refreshResponse = await stub.fetch("https://test-feed/test-refresh-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: position.account_id }),
      });
      const refreshed = await refreshResponse.json();
      const ensureResponse = await stub.fetch("https://test-feed/ensure", { method: "POST" });
      const feed = await ensureResponse.json();
      return json({
        success: refreshResponse.ok && ensureResponse.ok,
        side,
        position_id: position.position_id,
        stop_loss: stopLoss,
        current_quote: quote,
        refreshed,
        feed,
      }, refreshResponse.ok && ensureResponse.ok ? 200 : 503);
    }

    if (request.method === "POST" && action === "stop") {
      const run = await readLatestRun(database);
      if (!run) return json({ success: true, stopped: false });
      const stub = await getFeedStub(env, run.run_id);
      const response = await stub.fetch("https://test-feed/test-stop", { method: "POST" });
      return response;
    }

    return json({ success: false, error: "Unsupported test action" }, 400);
  },
};
