import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.flexible.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const provisioningToken = "test-provisioning-token";
const tradingToken = "test-trading-api-token";

function makeCatalog({ inactivePlan = null, omitPhase = null } = {}) {
	const planDefinitions = [
		{ key: "1step", code: "1_STEP", id: "MODEL_1", phaseNumbers: [1] },
		{ key: "2step", code: "2_STEP", id: "MODEL_2", phaseNumbers: [1, 2] },
		{ key: "instant", code: "INSTANT", id: "MODEL_INSTANT", phaseNumbers: [1] },
	];
	const models = [
		...planDefinitions.map(({ code, id }) => ({
			id,
			code,
			name: `${code} model`,
			currency: "USD",
			leverage: 100,
			profit_split_percent: 80,
			minimum_payout: null,
			maximum_payout: null,
			payout_frequency: null,
			payout_waiting_period_days: null,
			status: inactivePlan === code ? "disabled" : "active",
			custom_rules_json: "{}",
		})),
		{
			id: "MODEL_UNKNOWN",
			code: "UNKNOWN_PLAN",
			name: "Unknown Plan",
			status: "active",
		},
	];
	const phases = planDefinitions.flatMap(({ code, id, phaseNumbers }) =>
		phaseNumbers
			.map((phaseNumber) => ({
				id: `${id}_PHASE_${phaseNumber}`,
				model_id: id,
				phase_number: phaseNumber,
				phase_name: `${code} phase ${phaseNumber}`,
				profit_target_percent: 10,
				daily_drawdown_percent: 5,
				max_drawdown_percent: 10,
				max_drawdown_type: "STATIC",
				daily_drawdown_type: "START_OF_DAY_EQUITY",
				minimum_trading_days: 0,
				maximum_trading_days: 30,
				minimum_profitable_days: 0,
				max_lot_size: null,
				max_open_positions: null,
				max_trades_per_day: null,
				max_risk_per_trade_percent: null,
				max_daily_risk_percent: null,
				max_exposure_percent: null,
				stop_loss_required: 0,
				take_profit_required: 0,
				weekend_holding_allowed: 1,
				overnight_holding_allowed: 1,
				news_trading_allowed: 1,
				ea_allowed: 1,
				allowed_symbols_json: "[]",
				allowed_categories_json: "[]",
				pass_rule: null,
				fail_rule: null,
				next_phase_number: code === "2_STEP" && phaseNumber === 1 ? 2 : null,
				custom_rules_json: "{}",
				status: "active",
			}))
			.filter(
				(phase) =>
					!(phase.model_id === omitPhase?.modelId && phase.phase_number === omitPhase?.phaseNumber)
			)
	);
	const sizes = planDefinitions.map(({ id }) => ({
		id: `${id}_SIZE_100`,
		model_id: id,
		size: 100,
		status: "active",
		custom_rules_json: "{}",
	}));

	return { models, phases, sizes };
}

function mockDb({
	catalog = makeCatalog(),
	existingAccounts = [],
	existingSnapshots = [],
	existingPositions = [],
	existingOrders = [],
	existingTrades = [],
	existingPositionSnapshots = [],
	tradingSymbols = [],
} = {}) {
	const state = {
		accounts: [...existingAccounts],
		snapshots: [...existingSnapshots],
		symbols: [...tradingSymbols],
		positions: existingPositions.map((position) => ({ status: "open", ...position })),
		positionSnapshots: [...existingPositionSnapshots],
		orders: [...existingOrders],
		trades: [...existingTrades],
		candles: [],
		snapshotBindingCounts: [],
	};

	const db = {
		prepare(sql) {
			const statement = {
				sql,
				values: [],
				bind(...values) {
					this.values = values;
					if (this.sql.toLowerCase().includes("insert into account_rule_snapshots")) {
						const match = this.sql.match(
							/INSERT INTO account_rule_snapshots\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i
						);
						const counts = {
							columns: match ? match[1].split(",").filter((column) => column.trim()).length : 0,
							placeholders: match ? (match[2].match(/\?/g) || []).length : 0,
							boundValues: values.length,
						};
						state.snapshotBindingCounts.push(counts);
						if (counts.columns !== counts.placeholders || counts.placeholders !== counts.boundValues) {
							throw new Error("Rule snapshot SQL binding counts do not match");
						}
					}
					return this;
				},
				async first() {
					const lower = this.sql.toLowerCase();
					if (lower.includes("from trading_symbols")) {
						return state.symbols.find(
							(row) => row.symbol === this.values[0] && Number(row.trading_enabled) === 1
						) ?? null;
					}
					if (lower.includes("from trading_accounts")) {
						if (lower.includes("where purchase_id")) {
							return state.accounts.find((row) => row.purchase_id === this.values[0]) ?? null;
						}
						if (lower.includes("where id = ?")) {
							return state.accounts.find((row) =>
								row.id === this.values[0] &&
								(!lower.includes("user_id = ?") || row.user_id === this.values[1])
							) ?? null;
						}
					}
					if (lower.includes("from positions")) {
						const position = state.positions.find((row) => row.id === this.values[0]);
						if (!position) return null;
						if (lower.includes("join trading_accounts")) {
							const account = state.accounts.find((row) => row.id === position.account_id);
							if (!account || account.user_id !== this.values[1]) return null;
						}
						return position;
					}
					if (lower.includes("from position_calculation_snapshots")) {
						return state.positionSnapshots.find((row) => row.position_id === this.values[0]) ?? null;
					}
					if (lower.includes("from challenge_models")) {
						return catalog.models.find(
							(row) => row.code === this.values[0] && row.status === "active"
						) ?? null;
					}
					if (lower.includes("from challenge_model_phases")) {
						return catalog.phases.find(
							(row) => row.model_id === this.values[0] && row.phase_number === this.values[1] && row.status === "active"
						) ?? null;
					}
					if (lower.includes("from challenge_model_sizes")) {
						return catalog.sizes.find(
							(row) => row.model_id === this.values[0] && row.size === this.values[1] && row.status === "active"
						) ?? null;
					}
					if (lower.includes("from account_rule_snapshots")) {
						return state.snapshots.find((row) => row.account_id === this.values[0]) ?? null;
					}
					return null;
				},
				async all() {
					const lower = this.sql.toLowerCase();
					if (lower.includes("from trading_symbols")) {
						return {
							results: state.symbols.filter((row) => Number(row.market_data_enabled) === 1),
						};
					}
					if (lower.includes("from market_candles")) {
						const [symbol, interval, limit] = this.values;
						return {
							results: state.candles
								.filter((row) => row.symbol === symbol && row.interval === interval)
								.sort((left, right) => right.open_time.localeCompare(left.open_time))
								.slice(0, limit),
						};
					}
					if (lower.includes("from challenge_model_phases")) {
						return {
							results: catalog.phases.filter(
								(row) => row.model_id === this.values[0] && row.status === "active"
							),
						};
					}
					if (lower.includes("from positions")) {
						let positions = state.positions.filter((row) => row.account_id === this.values[0]);
						if (lower.includes("p.id != ?")) {
							positions = positions.filter((row) => row.id !== this.values.at(-1));
						}
						if (lower.includes("p.status = 'open'")) {
							positions = positions.filter((row) => row.status === "open");
						}
						return { results: positions };
					}
					if (lower.includes("from trades")) {
						return { results: state.trades.filter((row) => row.account_id === this.values[0]) };
					}
					return { results: [] };
				},
				async run() {
					const lower = this.sql.toLowerCase();
					if (lower.includes("insert into orders")) {
						const [id, accountId, symbol, side, volume, requestedPrice, orderType, status] = this.values;
						state.orders.push({ id, account_id: accountId, symbol, side, volume, requested_price: requestedPrice, order_type: orderType, status });
					}
					if (lower.includes("insert into positions")) {
						const [id, accountId, orderId, symbol, side, volume, openPrice, currentPrice, floatingPnl, takeProfit, stopLoss, status] = this.values;
						state.positions.push({ id, account_id: accountId, order_id: orderId, symbol, side, volume, open_price: openPrice, current_price: currentPrice, floating_pnl: floatingPnl, take_profit: takeProfit, stop_loss: stopLoss, status });
					}
					if (lower.includes("insert into position_calculation_snapshots")) {
						const [positionId, metadataJson] = this.values;
						state.positionSnapshots.push({ position_id: positionId, metadata_json: metadataJson });
					}
					if (lower.includes("insert into market_candles")) {
						const [symbol, interval, openTime, open, high, low, close] = this.values;
						state.candles.push({ symbol, interval, open_time: openTime, open, high, low, close, volume: null, source: "worker_generated" });
					}
					if (lower.includes("update positions")) {
						const [currentPrice, floatingPnl, positionId, accountId] = this.values;
						const position = state.positions.find((row) =>
							row.id === positionId && (!accountId || row.account_id === accountId)
						);
						if (position) Object.assign(position, {
							current_price: currentPrice,
							floating_pnl: floatingPnl,
						});
					}
					if (lower.includes("update trading_accounts")) {
						const accountId = lower.includes("user_id = ?")
							? this.values.at(-2)
							: this.values.at(-1);
						const account = state.accounts.find((row) => row.id === accountId);
						if (lower.includes("balance = ?")) {
							[account.balance, account.equity] = this.values;
						} else {
							account.equity = this.values[0];
						}
					}
					if (lower.includes("insert into trades")) {
						const [id, accountId, orderId, symbol, side, volume, openPrice, closePrice, realizedPnl, openedAt] = this.values;
						state.trades.push({ id, account_id: accountId, order_id: orderId, symbol, side, volume, open_price: openPrice, close_price: closePrice, realized_pnl: realizedPnl, opened_at: openedAt });
					}
					if (lower.includes("update orders")) {
						const order = state.orders.find((row) =>
							row.id === this.values[0] &&
							(!this.values[1] || row.account_id === this.values[1])
						);
						if (order) order.status = "closed";
					}
					if (lower.includes("delete from positions")) {
						state.positions = state.positions.filter((row) => row.id !== this.values[0]);
						state.positionSnapshots = state.positionSnapshots.filter((row) => row.position_id !== this.values[0]);
					}
					return { meta: { changes: 1 } };
				},
			};
			return statement;
		},
		async batch(statements) {
			const accounts = [];
			const snapshots = [];
			const results = [];
			for (const statement of statements) {
				const lower = statement.sql.toLowerCase();
				let changes = 0;
				if (
					lower.includes("insert into orders") ||
					lower.includes("insert into positions") ||
					lower.includes("insert into position_calculation_snapshots")
				) {
					const result = await statement.run();
					changes = Number(result?.meta?.changes || 1);
				} else if (lower.includes("update positions") && lower.includes("set status = 'closing'")) {
					const [positionId, accountId] = statement.values;
					const position = state.positions.find((row) =>
						row.id === positionId && row.account_id === accountId && row.status === "open"
					);
					if (position) {
						position.status = "closing";
						changes = 1;
					}
				} else if (lower.includes("insert into trades") && lower.includes("select")) {
					const values = statement.values;
					const positionId = values.at(-2);
					const accountId = values.at(-1);
					if (state.positions.some((row) => row.id === positionId && row.account_id === accountId && row.status === "closing")) {
						const [id, tradeAccountId, orderId, symbol, side, volume, openPrice, closePrice, realizedPnl, openedAt] = values;
						state.trades.push({ id, account_id: tradeAccountId, order_id: orderId, symbol, side, volume, open_price: openPrice, close_price: closePrice, realized_pnl: realizedPnl, opened_at: openedAt, closed_at: new Date().toISOString() });
						changes = 1;
					}
				} else if (lower.includes("update trading_accounts") && lower.includes("balance = ?")) {
					const [balance, equity, accountId] = statement.values;
					const closingId = statement.values.at(-2);
					const account = state.accounts.find((row) => row.id === accountId);
					if (account && state.positions.some((row) => row.id === closingId && row.status === "closing")) {
						account.balance = balance;
						account.equity = equity;
						changes = 1;
					}
				} else if (lower.includes("update orders") && lower.includes("status = 'closed'")) {
					const [orderId, accountId, positionId] = statement.values;
					const order = state.orders.find((row) => row.id === orderId && row.account_id === accountId);
					if (order && state.positions.some((row) => row.id === positionId && row.status === "closing")) {
						order.status = "closed";
						changes = 1;
					}
				} else if (lower.includes("delete from positions") && lower.includes("status = 'closing'")) {
					const [positionId, accountId] = statement.values;
					const position = state.positions.find((row) => row.id === positionId && row.account_id === accountId && row.status === "closing");
					if (position) {
						state.positions = state.positions.filter((row) => row.id !== positionId);
						state.positionSnapshots = state.positionSnapshots.filter((row) => row.position_id !== positionId);
						changes = 1;
					}
				} else if (lower.includes("update positions") || lower.includes("update trading_accounts")) {
					const result = await statement.run();
					changes = Number(result?.meta?.changes || 1);
				}
				if (lower.includes("insert into trading_accounts")) {
					const [id, userId, purchaseId, modelCode, phaseNumber, size, startingBalance, balance, equity] = statement.values;
					accounts.push({
						id,
						user_id: userId,
						purchase_id: purchaseId,
						challenge_model: modelCode,
						phase_number: phaseNumber,
						challenge_size: size,
						starting_balance: startingBalance,
						balance,
						equity,
						status: "active",
					});
				}
				if (lower.includes("insert into account_rule_snapshots")) {
					const match = statement.sql.match(
						/INSERT INTO account_rule_snapshots\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i
					);
					const columns = match[1].split(",").map((column) => column.trim());
					snapshots.push(Object.fromEntries(columns.map((column, index) => [column, statement.values[index]])));
				}
				results.push({ meta: { changes } });
			}
			state.accounts.push(...accounts);
			state.snapshots.push(...snapshots);
			return results;
		},
	};

	return { db, state, catalog };
}

function requestProvisioning(body, token = provisioningToken) {
	const headers = { "Content-Type": "application/json" };
	if (token !== null) {
		headers["x-provisioning-token"] = token;
	}
	return new Request("http://example.com/accounts/from-model", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function payloadFor(planKey, extra = {}) {
	return {
		user_id: "user-123",
		purchase_id: `purchase-${planKey}`,
		plan_key: planKey,
		account_size: 100,
		...extra,
	};
}

async function provision(db, body, token = provisioningToken) {
	return worker.fetch(requestProvisioning(body, token), {
		PROVISIONING_TOKEN: provisioningToken,
		daily_funded_trading_db: db,
	});
}

function tradingRequest(path, {
	method = "GET",
	body,
	token = tradingToken,
	userId = "user-123",
	configuredToken = tradingToken,
} = {}) {
	const headers = {};
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	if (userId !== null) headers["X-Authenticated-User-Uid"] = userId;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const env = { daily_funded_trading_db: null };
	if (configuredToken !== null) env.CLOUDFLARE_TRADING_API_TOKEN = configuredToken;
	return { request, env };
}

async function callTrading(db, path, options = {}) {
	const { request, env } = tradingRequest(path, options);
	env.daily_funded_trading_db = db;
	return worker.fetch(request, env);
}

function positionSymbol(symbol, overrides = {}) {
	const currencies = {
		EURUSD: ["EUR", "USD"],
		GBPUSD: ["GBP", "USD"],
		USDJPY: ["USD", "JPY"],
		USDCHF: ["USD", "CHF"],
		USDCAD: ["USD", "CAD"],
		AUDUSD: ["AUD", "USD"],
		NZDUSD: ["NZD", "USD"],
	};
	const [base_currency, quote_currency] = currencies[symbol] ?? ["NEW", "USD"];
	return {
		symbol,
		display_name: symbol,
		category: "FOREX",
		base_currency,
		quote_currency,
		volume_unit: "lot",
		contract_size: 100000,
		price_decimals: 5,
		pip_size: 0.0001,
		lot_step: 0.01,
		minimum_lot: 0.01,
		maximum_lot: null,
		trading_enabled: 1,
		...overrides,
	};
}

function positionHarness({ symbols, allowedSymbols, accountPhase = 1, rulesPhase = accountPhase, maxLotSize = null }) {
	return mockDb({
		existingAccounts: [{
			id: "ACC_TRADE",
			user_id: "user-123",
			challenge_model: "1_STEP",
			phase_number: accountPhase,
			balance: 10000,
			equity: 10000,
			status: "active",
		}],
		existingSnapshots: [{
			id: "RULE_TRADE",
			account_id: "ACC_TRADE",
			model_id: "MODEL_1",
			profit_target_percent: 10,
			daily_drawdown_percent: 5,
			max_drawdown_percent: 10,
			max_drawdown_type: "STATIC",
			daily_drawdown_type: "START_OF_DAY_EQUITY",
			phase_number: rulesPhase,
			minimum_trading_days: 3,
			max_lot_size: maxLotSize,
			leverage: 100,
			profit_split_percent: 80,
			allowed_symbols_json: JSON.stringify(allowedSymbols),
		}],
		tradingSymbols: symbols.map((symbol) => ({
			...positionSymbol(symbol.symbol),
			provider: "biquote",
			provider_symbol: symbol.symbol,
			market_data_enabled: 1,
			...symbol,
		})),
	});
}

function stubTradingQuotes(defaultPrice, overrides = {}) {
	vi.stubGlobal("caches", {
		default: {
			match: vi.fn(async () => undefined),
			put: vi.fn(async () => undefined),
		},
	});
	vi.stubGlobal("fetch", vi.fn(async (input) => {
		const url = new URL(input);
		const symbols = url.searchParams.getAll("symbols");
		const payload = Object.fromEntries(symbols.map((symbol) => {
			const quote = overrides[symbol] || {};
			const price = quote.price ?? defaultPrice;
			return [symbol, {
				bid: quote.bid ?? price,
				ask: quote.ask ?? price,
				timestamp: quote.timestamp || new Date().toISOString(),
				stale: quote.stale ?? false,
			}];
		}));
		return new Response(JSON.stringify(payload));
	}));
}

async function openPosition(db, symbol, { side = "BUY", volume = 0.1, price = 1.25 } = {}) {
	stubTradingQuotes(price);
	return callTrading(db, "/positions", {
		method: "POST",
		body: {
			account_id: "ACC_TRADE",
			symbol,
			side,
			volume,
			order_type: "MARKET",
		},
	});
}

async function markPosition(db, positionId, currentPrice) {
	stubTradingQuotes(currentPrice);
	return callTrading(db, "/positions/price", {
		method: "POST",
		body: { position_id: positionId, current_price: 999999 },
	});
}

async function closePosition(db, positionId, closePrice) {
	stubTradingQuotes(closePrice);
	return callTrading(db, "/positions/close", {
		method: "POST",
		body: { position_id: positionId, close_price: 999999 },
	});
}

async function getAccount(db, accountId) {
	return callTrading(db, `/accounts?account_id=${accountId}`);
}

function marketRecord(symbol, overrides = {}) {
	return {
		symbol,
		display_name: symbol,
		category: "FOREX",
		provider: symbol === "XAUUSD" ? "gold_api" : "biquote",
		provider_symbol: symbol === "XAUUSD" ? "XAU/USD" : symbol,
		market_data_enabled: 1,
		trading_enabled: symbol === "XAUUSD" ? 1 : 0,
		...overrides,
	};
}

function callMarket(db, path, envOverrides = {}) {
	return worker.fetch(new Request(`http://example.com${path}`), {
		daily_funded_trading_db: db,
		...envOverrides,
	});
}

function otherOwnerHarness() {
	const { db, state } = positionHarness({
		symbols: [positionSymbol("EURUSD")],
		allowedSymbols: ["EURUSD"],
	});
	state.accounts[0].user_id = "owner-user";
	state.orders.push({
		id: "ORD_OTHER",
		account_id: "ACC_TRADE",
		status: "filled",
	});
	state.positions.push({
		id: "POS_OTHER",
		account_id: "ACC_TRADE",
		order_id: "ORD_OTHER",
		symbol: "EURUSD",
		side: "BUY",
		volume: 0.1,
		open_price: 1.25,
		current_price: 1.25,
		floating_pnl: 0,
		opened_at: "2026-01-01T00:00:00Z",
	});
	state.positionSnapshots.push({
		position_id: "POS_OTHER",
		metadata_json: JSON.stringify(positionSymbol("EURUSD")),
	});
	state.trades.push({
		id: "TRD_OTHER",
		account_id: "ACC_TRADE",
		order_id: "ORD_OTHER",
		symbol: "EURUSD",
		side: "BUY",
		volume: 0.1,
		open_price: 1.25,
		close_price: 1.26,
		realized_pnl: 100,
	});
	return { db, state };
}

function tradingStateSnapshot(state) {
	return JSON.stringify({
		accounts: state.accounts,
		positions: state.positions,
		positionSnapshots: state.positionSnapshots,
		orders: state.orders,
		trades: state.trades,
	});
}

describe("Market data foundation", () => {
	it("lists only provider-mapped, market-data-enabled symbols", async () => {
		const { db } = mockDb({
			tradingSymbols: [
				marketRecord("XAUUSD"),
				marketRecord("EURUSD"),
				marketRecord("GBPUSD", { market_data_enabled: 0 }),
			],
		});
		const response = await callMarket(db, "/market/symbols");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.symbols).toHaveLength(2);
		expect(payload.symbols.find((symbol) => symbol.symbol === "XAUUSD")).toMatchObject({
			provider: "biquote",
			provider_symbol: "XAUUSD",
		});
	});

	it("routes legacy GoldAPI XAUUSD metadata through Biquote without a GoldAPI token", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
		const fetchMock = vi.fn(async (input) => {
			const providerUrl = new URL(input);
			expect(providerUrl.origin).toBe("https://biquote.io");
			expect(providerUrl.pathname).toBe("/api/latest");
			expect(providerUrl.searchParams.getAll("symbols")).toEqual(["XAUUSD"]);
			return new Response(JSON.stringify({
				XAUUSD: {
					bid: 2000,
					ask: 2002,
					timestamp: Date.now() / 1000,
					stale: false,
				},
			}));
		});
		vi.stubGlobal("fetch", fetchMock);
		const { db } = mockDb({ tradingSymbols: [marketRecord("XAUUSD")] });
		const response = await callMarket(db, "/market/quotes?symbols=XAUUSD");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(payload.quotes[0]).toMatchObject({
			symbol: "XAUUSD",
			provider: "biquote",
			bid: 2000,
			ask: 2002,
			mid: 2001,
			stale: false,
		});
		expect(payload.quotes[0].received_at).toBe("2026-10-02T12:00:00.000Z");
	});

	it("marks an old provider timestamp stale", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			EURUSD: {
				symbol: "EURUSD",
				bid: 1.1,
				ask: 1.2,
				mid: 1.15,
				timestamp: "2026-10-02T11:50:00.000Z",
				stale: false,
			},
		}))));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(db, "/market/quotes?symbols=EURUSD");

		expect((await response.json()).quotes[0].stale).toBe(true);
	});

	it("normalizes Biquote bid, ask, mid, and provider timestamp", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			EURUSD: {
				bid: 1.1,
				ask: 1.2,
				mid: 1.15,
				timestamp: "2026-10-02T11:59:59.000Z",
				stale: false,
			},
		}))));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(db, "/market/quotes?symbols=EURUSD");
		const quote = (await response.json()).quotes[0];

		expect(quote).toMatchObject({
			symbol: "EURUSD",
			provider: "biquote",
			bid: 1.1,
			ask: 1.2,
			mid: 1.15,
			timestamp: "2026-10-02T11:59:59.000Z",
			stale: false,
		});
	});

	it("does not synthesize missing Biquote bid or ask values", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			EURUSD: { mid: 1.15, timestamp: new Date().toISOString() },
		}))));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(db, "/market/quotes?symbols=EURUSD");
		const quote = (await response.json()).quotes[0];

		expect(quote).toMatchObject({ bid: null, ask: null, mid: 1.15 });
	});

	it("rejects zero or negative provider prices", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			EURUSD: { mid: 0, timestamp: new Date().toISOString() },
		}))));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(db, "/market/quotes?symbols=EURUSD");
		const payload = await response.json();

		expect(response.status).toBe(502);
		expect(payload.quotes).toEqual([]);
		expect(payload.errors).toMatchObject([{ code: "provider_invalid_quote" }]);
	});

	it("rejects malformed provider JSON without returning a price", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{")));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(db, "/market/quotes?symbols=EURUSD");
		const payload = await response.json();

		expect(response.status).toBe(502);
		expect(payload.quotes).toEqual([]);
		expect(payload.errors).toMatchObject([{ code: "provider_invalid_json" }]);
	});

	it("deduplicates requested symbols before the Biquote batch request", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input) => {
			const providerUrl = new URL(input);
			expect(providerUrl.searchParams.getAll("symbols")).toEqual(["EURUSD", "GBPUSD"]);
			const timestamp = new Date().toISOString();
			return new Response(JSON.stringify({
				EURUSD: { bid: 1.1, ask: 1.2, timestamp },
				GBPUSD: { bid: 1.3, ask: 1.4, timestamp },
			}));
		}));
		const { db } = mockDb({
			tradingSymbols: [marketRecord("EURUSD"), marketRecord("GBPUSD")],
		});
		const response = await callMarket(db, "/market/quotes?symbols=EURUSD,EURUSD,GBPUSD");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.requested_symbols).toEqual(["EURUSD", "GBPUSD"]);
		expect(payload.quotes).toHaveLength(2);
	});

	it("returns structured errors for unknown symbols and provider failures", async () => {
		const fetchMock = vi.fn(async () => { throw new Error("network details must not leak"); });
		vi.stubGlobal("fetch", fetchMock);
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const unknown = await callMarket(db, "/market/quotes?symbols=NOPE");
		expect(unknown.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();

		const failed = await callMarket(db, "/market/quotes?symbols=EURUSD");
		const payload = await failed.json();
		expect(failed.status).toBe(502);
		expect(payload.errors).toMatchObject([{ code: "provider_unreachable" }]);
		expect(JSON.stringify(payload)).not.toContain("network details");
	});

	it("does not fabricate data when Biquote has no quote for a configured symbol", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}))));
		const { db } = mockDb({ tradingSymbols: [marketRecord("GER40")] });
		const response = await callMarket(db, "/market/quotes?symbols=GER40");
		const payload = await response.json();

		expect(response.status).toBe(502);
		expect(payload.quotes).toEqual([]);
		expect(payload.errors).toMatchObject([{ code: "provider_quote_unavailable" }]);
	});

	it("labels Biquote OHLC as provider historical data", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input) => {
			const providerUrl = new URL(input);
			expect(providerUrl.pathname).toBe("/api/EURUSD/ohlc");
			expect(providerUrl.searchParams.get("interval")).toBe("1m");
			return new Response(JSON.stringify({
				bars: [{
					openTime: "2026-10-02T11:59:00Z",
					open: 1.1,
					high: 1.2,
					low: 1.05,
					close: 1.15,
					volume: 0,
					isOpen: false,
				}],
			}));
		}));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(db, "/market/candles?symbol=EURUSD&interval=1m");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.source).toBe("provider_historical");
		expect(payload.bars[0]).toMatchObject({ symbol: "EURUSD", close: 1.15, volume: null });
	});

	it("routes XAUUSD candle requests to Biquote with the canonical symbol", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input) => {
			const providerUrl = new URL(input);
			expect(providerUrl.origin).toBe("https://biquote.io");
			expect(providerUrl.pathname).toBe("/api/XAUUSD/ohlc");
			return new Response(JSON.stringify({
				bars: [{
					openTime: "2026-10-02T11:59:00Z",
					open: 2000,
					high: 2002,
					low: 1999,
					close: 2001,
					isOpen: false,
				}],
			}));
		}));
		const { db } = mockDb({ tradingSymbols: [marketRecord("XAUUSD")] });
		const response = await callMarket(db, "/market/candles?symbol=XAUUSD&interval=1m");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.provider).toBe("biquote");
		expect(payload.source).toBe("provider_historical");
		expect(payload.bars[0]).toMatchObject({ symbol: "XAUUSD", close: 2001 });
	});

	it("routes every current web symbol through its configured Biquote OHLC mapping", async () => {
		const mappings = [
			["EURUSD", "EURUSD"], ["GBPUSD", "GBPUSD"], ["USDJPY", "USDJPY"],
			["XAUUSD", "XAUUSD"], ["XAGUSD", "XAGUSD"], ["BTCUSD", "BTCUSD"],
			["ETHUSD", "ETHUSD"], ["USOIL", "USOIL"], ["XCUUSD", "XCUUSD"],
			["UKOIL", "UKOIL"], ["XNGUSD", "XNGUSD"],
			["USTEC", "USTEC"], ["US30", "US30"], ["US500", "US500"],
			["GER40", "GER40"], ["UK100", "UK100"], ["AUS200", "AUS200"],
		];
		const requestedProviderSymbols = [];
		vi.stubGlobal("fetch", vi.fn(async (input) => {
			const providerUrl = new URL(input);
			requestedProviderSymbols.push(providerUrl.pathname.split("/").at(-2));
			return new Response(JSON.stringify({
				bars: [{
					openTime: "2026-10-02T11:59:00Z",
					open: 100,
					high: 101,
					low: 99,
					close: 100,
					isOpen: false,
				}],
			}));
		}));
		const { db } = mockDb({ tradingSymbols: mappings.map(([symbol]) => marketRecord(symbol)) });
		const catalogResponse = await callMarket(db, "/market/symbols");
		const catalog = await catalogResponse.json();

		expect(catalogResponse.status).toBe(200);
		expect(catalog.symbols.map(({ symbol }) => symbol).sort()).toEqual(mappings.map(([symbol]) => symbol).sort());
		expect(Object.fromEntries(catalog.symbols.map(({ symbol, provider_symbol: providerSymbol }) => [symbol, providerSymbol])))
			.toEqual(Object.fromEntries(mappings));
		for (const [webSymbol, providerSymbol] of mappings) {
			const response = await callMarket(db, `/market/candles?symbol=${webSymbol}&interval=15m&limit=1000`);
			const payload = await response.json();
			expect(response.status).toBe(200);
			expect(payload.bars[0]).toMatchObject({ symbol: webSymbol, source: "provider_historical" });
			expect(requestedProviderSymbols.at(-1)).toBe(providerSymbol);
		}
		expect(requestedProviderSymbols).toEqual(mappings.map(([, providerSymbol]) => providerSymbol));
	});

	it("forwards validated Biquote date ranges and preserves its in-progress extra bar", async () => {
		let requestedUrl;
		vi.stubGlobal("fetch", vi.fn(async (input) => {
			requestedUrl = new URL(input);
			const bars = Array.from({ length: 1001 }, (_, index) => ({
				openTime: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
				open: 100,
				high: 101,
				low: 99,
				close: 100,
				isOpen: index === 1000,
			}));
			return new Response(JSON.stringify({ bars }));
		}));
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		const response = await callMarket(
			db,
			"/market/candles?symbol=EURUSD&interval=1m&limit=1000&from=2026-01-01T02%3A00%3A00%2B02%3A00&to=2026-01-02T00%3A00%3A00Z",
		);
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(requestedUrl.origin).toBe("https://biquote.io");
		expect(requestedUrl.searchParams.get("limit")).toBe("1000");
		expect(requestedUrl.searchParams.get("from")).toBe("2026-01-01T00:00:00.000Z");
		expect(requestedUrl.searchParams.get("to")).toBe("2026-01-02T00:00:00.000Z");
		expect(payload.bars).toHaveLength(1001);
		expect(payload.bars.at(-1).is_open).toBe(true);
		expect(payload.bars[0].open_time).toBe("2026-01-01T00:00:00.000Z");

		await callMarket(db, "/market/candles?symbol=EURUSD&interval=1m&limit=1000&to=2025-12-31T23%3A59%3A59.999Z");
		expect(requestedUrl.searchParams.has("from")).toBe(false);
		expect(requestedUrl.searchParams.get("to")).toBe("2025-12-31T23:59:59.999Z");
	});

	it("rejects invalid candle limits and date ranges before contacting Biquote", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { db } = mockDb({ tradingSymbols: [marketRecord("EURUSD")] });
		for (const query of [
			"limit=1001",
			"from=2026-02-30T00%3A00%3A00Z",
		]) {
			const response = await callMarket(db, `/market/candles?symbol=EURUSD&interval=1m&${query}`);
			expect(response.status).toBe(400);
		}
		const reversed = await callMarket(
			db,
			"/market/candles?symbol=EURUSD&interval=1m&from=2026-01-02T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z",
		);
		expect(reversed.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("builds OHLC from normalized quotes and persists after the candle interval rolls", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2030-01-01T00:00:10.000Z"));
		let price = 100;
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			CANDLETEST: {
				bid: price,
				ask: price,
				timestamp: Date.now() / 1000,
			},
		}))));
		const { db, state } = mockDb({
			tradingSymbols: [marketRecord("CANDLETEST")],
		});

		await callMarket(db, "/market/quotes?symbols=CANDLETEST");
		price = 110;
		vi.setSystemTime(new Date("2030-01-01T00:00:40.000Z"));
		await callMarket(db, "/market/quotes?symbols=CANDLETEST");
		expect(state.candles).toHaveLength(0);

		price = 105;
		vi.setSystemTime(new Date("2030-01-01T00:01:10.000Z"));
		await callMarket(db, "/market/quotes?symbols=CANDLETEST");

		expect(state.candles).toMatchObject([{
			symbol: "CANDLETEST",
			interval: "1m",
			open: 100,
			high: 110,
			low: 100,
			close: 110,
			source: "worker_generated",
		}]);
		expect(state.candles.filter((candle) => candle.interval === "5m")).toHaveLength(0);
	});
});

describe("Trusted trading API authentication", () => {
	it("rejects a missing trading token", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await callTrading(db, "/accounts?account_id=ACC_TRADE", { token: null });
		expect(response.status).toBe(401);
	});

	it("rejects a missing Worker trading-token configuration", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await callTrading(db, "/accounts?account_id=ACC_TRADE", { configuredToken: null });
		expect(response.status).toBe(503);
	});

	it("rejects an invalid trading token", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await callTrading(db, "/accounts?account_id=ACC_TRADE", { token: "invalid-token" });
		expect(response.status).toBe(401);
	});

	it("rejects a missing trusted UID header", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await callTrading(db, "/accounts?account_id=ACC_TRADE", { userId: null });
		expect(response.status).toBe(401);
	});

	it("accepts a valid token and UID from the trusted request headers", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await callTrading(db, "/accounts?account_id=ACC_TRADE");
		const payload = await response.json();
		expect(response.status).toBe(200);
		expect(payload.account.user_id).toBe("user-123");
		expect(JSON.stringify(payload)).not.toContain(tradingToken);
	});

	it("does not let a body UID override the trusted UID", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
		});
		stubTradingQuotes(1.25, { EURUSD: { bid: 1.24, ask: 1.26 } });
		const response = await callTrading(db, "/positions", {
			method: "POST",
			body: {
				user_id: "other-user",
				account_id: "ACC_TRADE",
				symbol: "EURUSD",
				side: "BUY",
				volume: 0.1,
				open_price: 9999,
				order_type: "MARKET",
			},
		});

		expect(response.status).toBe(201);
		expect(state.accounts[0].user_id).toBe("user-123");
		expect(state.positions[0].account_id).toBe("ACC_TRADE");
		expect(state.positions[0].open_price).toBe(1.26);
	});
});

describe("Trading account ownership", () => {
	it("returns the authenticated user's trade history", async () => {
		const { db, state } = positionHarness({ symbols: [], allowedSymbols: [] });
		state.trades.push({
			id: "TRD_OWN",
			account_id: "ACC_TRADE",
			symbol: "EURUSD",
			realized_pnl: 25,
		});
		const response = await callTrading(db, "/trades?account_id=ACC_TRADE");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.account_id).toBe("ACC_TRADE");
		expect(payload.trades).toMatchObject([{ id: "TRD_OWN", account_id: "ACC_TRADE" }]);
	});

	it("returns the authenticated user's account rules", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await callTrading(db, "/account-rules?account_id=ACC_TRADE");
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.rules).toMatchObject({
			account_id: "ACC_TRADE",
			profit_target_percent: 10,
			daily_drawdown_percent: 5,
		});
	});

	it("returns not found for a nonexistent account", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await getAccount(db, "ACC_MISSING");
		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("Trading account not found");
	});

	it("does not read another user's account", async () => {
		const { db } = otherOwnerHarness();
		const response = await callTrading(db, "/accounts?account_id=ACC_TRADE", { userId: "requester-user" });
		expect(response.status, JSON.stringify(await response.clone().json())).toBe(404);
	});

	it("does not open a position on another user's account", async () => {
		const { db, state } = otherOwnerHarness();
		const before = tradingStateSnapshot(state);
		const response = await callTrading(db, "/positions", {
			method: "POST",
			userId: "requester-user",
			body: {
				account_id: "ACC_TRADE",
				symbol: "EURUSD",
				side: "BUY",
				volume: 0.1,
				open_price: 1.25,
			},
		});
		expect(response.status).toBe(404);
		expect(tradingStateSnapshot(state)).toBe(before);
	});

	it("does not mark another user's position or mutate account state", async () => {
		const { db, state } = otherOwnerHarness();
		const before = tradingStateSnapshot(state);
		const response = await callTrading(db, "/positions/price", {
			method: "POST",
			userId: "requester-user",
			body: { position_id: "POS_OTHER", current_price: 1.26 },
		});
		expect(response.status).toBe(404);
		expect(tradingStateSnapshot(state)).toBe(before);
	});

	it("does not close another user's position or mutate account state", async () => {
		const { db, state } = otherOwnerHarness();
		const before = tradingStateSnapshot(state);
		const response = await callTrading(db, "/positions/close", {
			method: "POST",
			userId: "requester-user",
			body: { position_id: "POS_OTHER", close_price: 1.26 },
		});
		expect(response.status).toBe(404);
		expect(tradingStateSnapshot(state)).toBe(before);
	});

	it("does not read another user's trade history", async () => {
		const { db } = otherOwnerHarness();
		const response = await callTrading(db, "/trades?account_id=ACC_TRADE", { userId: "requester-user" });
		expect(response.status).toBe(404);
	});

	it("does not read another user's account rules", async () => {
		const { db } = otherOwnerHarness();
		const response = await callTrading(db, "/account-rules?account_id=ACC_TRADE", { userId: "requester-user" });
		expect(response.status).toBe(404);
	});
});

describe("Production configuration route protection", () => {
	it.each([
		["POST", "/models"],
		["GET", "/models"],
		["GET", "/models/detail?model_id=MODEL_1"],
		["PUT", "/models"],
		["PATCH", "/models/status"],
		["POST", "/model-phases"],
		["PUT", "/model-phases"],
		["POST", "/model-sizes"],
		["PUT", "/model-sizes"],
		["POST", "/symbols"],
		["GET", "/symbols"],
	])("does not expose configuration route %s %s", async (method, path) => {
		const db = {
			prepare() {
				throw new Error("configuration route reached D1");
			},
		};
		const response = await callTrading(db, path, {
			method,
			body: method === "GET" ? undefined : {},
			token: null,
			userId: null,
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			success: false,
			error: "Route not found",
		});
	});
});

describe("Worker error and CORS safety", () => {
	it("does not expose D1 exception details", async () => {
		const db = {
			prepare() {
				throw new Error("private D1 connection detail");
			},
		};
		const response = await getAccount(db, "ACC_TRADE");
		const payload = await response.json();

		expect(response.status).toBe(500);
		expect(payload.error).toBe("Internal server error");
		expect(JSON.stringify(payload)).not.toContain("private D1 connection detail");
	});

	it("does not emit wildcard CORS headers for the server-to-server API", async () => {
		const { db } = positionHarness({ symbols: [], allowedSymbols: [] });
		const response = await getAccount(db, "ACC_TRADE");

		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

describe("Flexible provisioning worker", () => {
	it("rejects a missing provisioning token with 401", async () => {
		const { db } = mockDb();
		const response = await provision(db, payloadFor("1step"), null);
		expect(response.status).toBe(401);
	});

	it("rejects a wrong provisioning token with 401", async () => {
		const { db } = mockDb();
		const response = await provision(db, payloadFor("1step"), "wrong-token");
		expect(response.status).toBe(401);
	});

	it.each([
		["1step", "1_STEP", 1],
		["2step", "2_STEP", 1],
		["instant", "INSTANT", 1],
	])("maps %s to model %s phase %i", async (planKey, modelCode, phaseNumber) => {
		const { db, state } = mockDb();
		const response = await provision(db, payloadFor(planKey, {
			model_id: "CALLER_MODEL",
			phase_id: "CALLER_PHASE",
			size_id: "CALLER_SIZE",
		}));

		expect(response.status).toBe(201);
		const payload = await response.json();
		expect(payload.account.model_code).toBe(modelCode);
		expect(payload.account.phase_number).toBe(phaseNumber);
		expect(payload.account.challenge_size).toBe(100);
		expect(payload.account).toMatchObject({
			user_id: "user-123",
			purchase_id: `purchase-${planKey}`,
			starting_balance: 100,
			balance: 100,
			equity: 100,
		});
		expect(state.accounts[0].challenge_model).toBe(modelCode);
		expect(state.accounts[0].user_id).toBe("user-123");
		expect(state.accounts[0].purchase_id).toBe(`purchase-${planKey}`);
		expect(state.accounts[0].starting_balance).toBe(100);
		expect(state.accounts[0].balance).toBe(100);
		expect(state.accounts[0].equity).toBe(100);
		expect(state.snapshots).toHaveLength(1);
	});

	it.each(["random-value", "UNKNOWN_PLAN"])("rejects unknown plan key %s without model fallback", async (planKey) => {
		const { db, state } = mockDb();
		const response = await provision(db, payloadFor(planKey));
		expect(response.status).toBe(404);
		expect(state.accounts).toHaveLength(0);
		expect(state.snapshots).toHaveLength(0);
	});

	it.each(["user_id", "purchase_id", "plan_key"])("rejects a missing %s with 400", async (field) => {
		const body = payloadFor("1step");
		delete body[field];
		const { db, state } = mockDb();
		const response = await provision(db, body);

		expect(response.status).toBe(400);
		expect(state.accounts).toHaveLength(0);
		expect(state.snapshots).toHaveLength(0);
	});

	it("normalizes a known product key safely", async () => {
		const { db } = mockDb();
		const response = await provision(db, payloadFor(" 1STEP "));
		expect(response.status).toBe(201);
		expect((await response.json()).account.model_code).toBe("1_STEP");
	});

	it("rejects an inactive mapped model", async () => {
		const { db, state } = mockDb({ catalog: makeCatalog({ inactivePlan: "2_STEP" }) });
		const response = await provision(db, payloadFor("2step"));
		expect(response.status).toBe(404);
		expect(state.accounts).toHaveLength(0);
	});

	it.each([
		["not-a-number", 400],
		[0, 400],
		[-100, 400],
		[200, 404],
	])("rejects account_size %s with HTTP %i", async (accountSize, status) => {
		const { db } = mockDb();
		const response = await provision(db, payloadFor("1step", { account_size: accountSize }));
		expect(response.status).toBe(status);
	});

	it("requires active phase 2 for 2step but still provisions phase 1", async () => {
		const { db, state } = mockDb();
		const response = await provision(db, payloadFor("2step"));
		expect(response.status).toBe(201);
		expect((await response.json()).account.phase_number).toBe(1);
		expect(state.accounts[0].phase_number).toBe(1);
		expect(JSON.parse(state.snapshots[0].custom_rules_json).phases).toHaveLength(2);
	});

	it.each(["1step", "instant"])("captures the configured single phase for %s", async (planKey) => {
		const { db, state } = mockDb();
		const response = await provision(db, payloadFor(planKey));
		expect(response.status).toBe(201);
		expect(JSON.parse(state.snapshots[0].custom_rules_json).phases).toHaveLength(1);
	});

	it("rejects 2step when active phase 2 is missing", async () => {
		const { db, state } = mockDb({
			catalog: makeCatalog({ omitPhase: { modelId: "MODEL_2", phaseNumber: 2 } }),
		});
		const response = await provision(db, payloadFor("2step"));
		expect(response.status).toBe(400);
		expect(state.accounts).toHaveLength(0);
	});

	it("rejects provisioning when required phase rules are missing instead of applying account defaults", async () => {
		const catalog = makeCatalog();
		const phase = catalog.phases.find((row) => row.model_id === "MODEL_1" && row.phase_number === 1);
		phase.daily_drawdown_percent = null;
		const { db, state } = mockDb({ catalog });
		const response = await provision(db, payloadFor("1step"));
		expect(response.status).toBe(400);
		expect(state.accounts).toHaveLength(0);
		expect(state.snapshots).toHaveLength(0);
	});

	it("asserts snapshot columns, placeholders, and bound values match", async () => {
		const { db, state } = mockDb();
		const response = await provision(db, payloadFor("1step"));
		expect(response.status).toBe(201);
		expect(state.snapshotBindingCounts).toEqual([
			{ columns: 45, placeholders: 45, boundValues: 45 },
		]);
	});

	it("does not create another account or snapshot for a duplicate purchase", async () => {
		const { db, state } = mockDb();
		const body = payloadFor("1step", { purchase_id: "purchase-duplicate" });
		const firstResponse = await provision(db, body);
		const secondResponse = await provision(db, body);

		expect(firstResponse.status).toBe(201);
		expect(secondResponse.status).toBe(200);
		expect((await secondResponse.json()).idempotent).toBe(true);
		expect(state.accounts).toHaveLength(1);
		expect(state.snapshots).toHaveLength(1);
	});

	it.each([
		["user_id", { user_id: "different-user" }],
		["plan_key", { plan_key: "2step" }],
		["account_size", { account_size: 200 }],
	])("rejects a duplicate purchase_id with a different %s", async (_field, changedFields) => {
		const body = payloadFor("1step", { ...changedFields, purchase_id: "purchase-conflict" });
		const { db, state } = mockDb({
			existingAccounts: [{
				id: "ACC_EXISTING",
				user_id: "user-123",
				purchase_id: "purchase-conflict",
				challenge_model: "1_STEP",
				phase_number: 1,
				challenge_size: 100,
				starting_balance: 100,
				balance: 100,
				equity: 100,
				status: "active",
			}],
		});
		const response = await provision(db, body);

		expect(response.status).toBe(409);
		expect((await response.json()).success).toBe(false);
		expect(state.accounts).toHaveLength(1);
		expect(state.snapshots).toHaveLength(0);
	});

	it("keeps an existing account at 6% when a new account receives the updated 8% rule", async () => {
		const catalog = makeCatalog();
		const model = catalog.models.find((row) => row.code === "1_STEP");
		const phase = catalog.phases.find((row) => row.model_id === model.id && row.phase_number === 1);
		Object.assign(phase, {
			profit_target_percent: 6,
			daily_drawdown_percent: 5,
			max_drawdown_percent: 10,
			minimum_trading_days: 3,
			allowed_symbols_json: JSON.stringify(["EURUSD"]),
		});
		model.profit_split_percent = 80;
		const { db, state } = mockDb({ catalog });
		const firstResponse = await provision(db, payloadFor("1step", { purchase_id: "purchase-version-a" }));
		const firstPayload = await firstResponse.json();
		const originalSnapshotJson = state.snapshots[0].custom_rules_json;

		phase.profit_target_percent = 8;
		phase.daily_drawdown_percent = 4;
		phase.max_drawdown_percent = 9;
		phase.minimum_trading_days = 4;
		phase.allowed_symbols_json = JSON.stringify(["GBPUSD"]);
		model.profit_split_percent = 70;

		const existingResponse = await getAccount(db, firstPayload.account.id);
		const existingRules = (await existingResponse.json()).rules;
		const secondResponse = await provision(db, payloadFor("1step", { purchase_id: "purchase-version-b" }));
		const secondPayload = await secondResponse.json();
		const newResponse = await getAccount(db, secondPayload.account.id);
		const newRules = (await newResponse.json()).rules;

		expect(firstResponse.status).toBe(201);
		expect(existingResponse.status).toBe(200);
		expect(existingRules).toMatchObject({
			profit_target_percent: 6,
			daily_drawdown_percent: 5,
			max_drawdown_percent: 10,
			minimum_trading_days: 3,
			profit_split_percent: 80,
			allowed_symbols_json: '["EURUSD"]',
		});
		expect(secondResponse.status).toBe(201);
		expect(newRules).toMatchObject({
			profit_target_percent: 8,
			daily_drawdown_percent: 4,
			max_drawdown_percent: 9,
			minimum_trading_days: 4,
			profit_split_percent: 70,
			allowed_symbols_json: '["GBPUSD"]',
		});
		expect(state.snapshots).toHaveLength(2);
		expect(state.snapshots[0].custom_rules_json).toBe(originalSnapshotJson);
		expect(state.snapshots[0].custom_rules_json).not.toBe(state.snapshots[1].custom_rules_json);
	});

	it("keeps phase-specific rules independent inside one immutable account snapshot", async () => {
		const catalog = makeCatalog();
		const phaseOne = catalog.phases.find((row) => row.model_id === "MODEL_2" && row.phase_number === 1);
		const phaseTwo = catalog.phases.find((row) => row.model_id === "MODEL_2" && row.phase_number === 2);
		phaseOne.profit_target_percent = 6;
		phaseTwo.profit_target_percent = 7;
		const { db, state } = mockDb({ catalog });
		const response = await provision(db, payloadFor("2step"));
		const payload = await response.json();
		const snapshotJson = state.snapshots[0].custom_rules_json;

		const phaseOneResponse = await getAccount(db, payload.account.id);
		state.accounts[0].phase_number = 2;
		const phaseTwoResponse = await getAccount(db, payload.account.id);

		expect((await phaseOneResponse.json()).rules.profit_target_percent).toBe(6);
		expect((await phaseTwoResponse.json()).rules.profit_target_percent).toBe(7);
		expect(state.snapshots[0].custom_rules_json).toBe(snapshotJson);
	});

	it("resolves independent phase snapshots from the provision-time phase set", async () => {
		const catalog = makeCatalog();
		const phaseTwo = catalog.phases.find((row) => row.model_id === "MODEL_2" && row.phase_number === 2);
		phaseTwo.profit_target_percent = 9;
		const { db, state } = mockDb({ catalog });
		const response = await provision(db, payloadFor("2step"));
		const payload = await response.json();
		const savedSnapshot = state.snapshots[0];

		const phaseOneResponse = await getAccount(db, payload.account.id);
		state.accounts[0].phase_number = 2;
		const phaseTwoResponse = await getAccount(db, payload.account.id);

		expect((await phaseOneResponse.json()).rules.profit_target_percent).toBe(10);
		expect((await phaseTwoResponse.json()).rules).toMatchObject({
			phase_number: 2,
			profit_target_percent: 9,
		});
		expect(savedSnapshot.phase_number).toBe(1);
		expect(state.snapshots).toHaveLength(1);
	});

	it("fails safely when an account has no rule snapshot", async () => {
		const { db, state } = mockDb({
			existingAccounts: [{
				id: "ACC_NO_RULES",
				user_id: "user-123",
				purchase_id: "purchase-no-rules",
				challenge_model: "1_STEP",
				phase_number: 1,
				challenge_size: 100,
				status: "active",
			}],
		});
		const response = await getAccount(db, "ACC_NO_RULES");
		expect(response.status).toBe(400);
		expect(state.accounts).toHaveLength(1);
	});

	it("does not use duplicated trading_accounts rule columns when snapshot rules are missing", async () => {
		const { db } = mockDb({
			existingAccounts: [{
				id: "ACC_NO_RULES",
				user_id: "user-123",
				purchase_id: "purchase-no-rules",
				challenge_model: "1_STEP",
				phase_number: 1,
				challenge_size: 100,
				profit_target_percent: 10,
				daily_drawdown_percent: 5,
				max_drawdown_percent: 10,
				minimum_trading_days: 3,
				status: "active",
			}],
		});
		const response = await getAccount(db, "ACC_NO_RULES");
		expect(response.status).toBe(400);
		expect((await response.json()).success).toBe(false);
	});

	it("opens a position only for an enabled catalog symbol allowed by the account phase snapshot", async () => {
		const { db, state } = positionHarness({
			symbols: [{ symbol: "EURUSD", trading_enabled: 1 }],
			allowedSymbols: ["EURUSD"],
		});
		const response = await openPosition(db, "EURUSD");
		expect(response.status).toBe(201);
		expect(state.positions).toHaveLength(1);
	});

	it.each([
		["BUY", 1.26],
		["SELL", 1.24],
	])("uses the Biquote %s execution side and ignores a client price", async (side, expectedPrice) => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
		});
		stubTradingQuotes(1.25, { EURUSD: { bid: 1.24, ask: 1.26 } });
		const response = await callTrading(db, "/positions", {
			method: "POST",
			body: {
				account_id: "ACC_TRADE",
				symbol: "EURUSD",
				side,
				volume: 0.1,
				order_type: "MARKET",
				open_price: 9999,
			},
		});

		expect(response.status).toBe(201);
		expect(state.positions[0].open_price).toBe(expectedPrice);
		expect(state.orders[0].requested_price).toBe(expectedPrice);
	});

	it.each([
		["invalid_tp", { take_profit: 1.25 }],
		["invalid_sl", { stop_loss: 1.26 }],
	])("rejects an invalid BUY TP/SL (%s) server-side", async (expectedCode, levels) => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
		});
		stubTradingQuotes(1.25, { EURUSD: { bid: 1.24, ask: 1.26 } });
		const response = await callTrading(db, "/positions", {
			method: "POST",
			body: {
				account_id: "ACC_TRADE",
				symbol: "EURUSD",
				side: "BUY",
				volume: 0.1,
				order_type: "MARKET",
				...levels,
			},
		});

		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe(expectedCode);
		expect(state.orders).toHaveLength(0);
		expect(state.positions).toHaveLength(0);
	});

	it("persists server-validated take profit and stop loss on a position", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
		});
		stubTradingQuotes(1.25, { EURUSD: { bid: 1.24, ask: 1.26 } });
		const response = await callTrading(db, "/positions", {
			method: "POST",
			body: {
				account_id: "ACC_TRADE",
				symbol: "EURUSD",
				side: "BUY",
				volume: 0.1,
				order_type: "MARKET",
				take_profit: 1.28,
				stop_loss: 1.23,
			},
		});

		expect(response.status).toBe(201);
		expect(state.positions[0]).toMatchObject({ take_profit: 1.28, stop_loss: 1.23 });
	});

	it("rejects an order when server-calculated required margin exceeds balance", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
		});
		state.accounts[0].balance = 1;
		stubTradingQuotes(1.25);
		const response = await callTrading(db, "/positions", {
			method: "POST",
			body: {
				account_id: "ACC_TRADE",
				symbol: "EURUSD",
				side: "BUY",
				volume: 0.1,
				order_type: "MARKET",
			},
		});

		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("insufficient_margin");
		expect(state.orders).toHaveLength(0);
		expect(state.positions).toHaveLength(0);
	});

	it("rejects symbols missing from the catalog", async () => {
		const { db, state } = positionHarness({
			symbols: [],
			allowedSymbols: ["EURUSD"],
		});
		const response = await openPosition(db, "EURUSD");
		expect(response.status).toBe(400);
		expect(state.positions).toHaveLength(0);
	});

	it("rejects disabled catalog symbols", async () => {
		const { db, state } = positionHarness({
			symbols: [{ symbol: "EURUSD", trading_enabled: 0 }],
			allowedSymbols: ["EURUSD"],
		});
		const response = await openPosition(db, "EURUSD");
		expect(response.status).toBe(400);
		expect(state.positions).toHaveLength(0);
	});

	it("rejects catalog symbols excluded from the account phase allowlist", async () => {
		const { db, state } = positionHarness({
			symbols: [{ symbol: "EURUSD", trading_enabled: 1 }],
			allowedSymbols: ["GBPUSD"],
		});
		const response = await openPosition(db, "EURUSD");
		expect(response.status).toBe(400);
		expect(state.positions).toHaveLength(0);
	});

	it("fails closed when the account phase has an empty symbol allowlist", async () => {
		const { db, state } = positionHarness({
			symbols: [{ symbol: "EURUSD", trading_enabled: 1 }],
			allowedSymbols: [],
		});
		const response = await openPosition(db, "EURUSD");
		expect(response.status).toBe(400);
		expect(state.positions).toHaveLength(0);
	});

	it("rejects rules that do not match the account's current phase", async () => {
		const { db, state } = positionHarness({
			symbols: [{ symbol: "EURUSD", trading_enabled: 1 }],
			allowedSymbols: ["EURUSD"],
			accountPhase: 2,
			rulesPhase: 1,
		});
		const response = await openPosition(db, "EURUSD");
		expect(response.status).toBe(400);
		expect(state.positions).toHaveLength(0);
	});

	it("supports a future symbol when it is cataloged and explicitly allowlisted", async () => {
		const { db, state } = positionHarness({
			symbols: [{ symbol: "NEWFX", trading_enabled: 1 }],
			allowedSymbols: ["NEWFX"],
		});
		const response = await openPosition(db, "NEWFX");
		expect(response.status).toBe(201);
		expect(state.positions[0].symbol).toBe("NEWFX");
	});

	it("does not automatically allow a newly cataloged symbol for existing snapshots", async () => {
		const { db, state } = positionHarness({
			symbols: [
				{ symbol: "EURUSD", trading_enabled: 1 },
				{ symbol: "NEWFX", trading_enabled: 1 },
			],
			allowedSymbols: ["EURUSD"],
		});
		const response = await openPosition(db, "NEWFX");
		expect(response.status).toBe(400);
		expect(state.positions).toHaveLength(0);
	});

	it.each([
		["BUY", 1.26, 100],
		["BUY", 1.24, -100],
		["SELL", 1.24, 100],
		["SELL", 1.26, -100],
	])("calculates EURUSD %s P&L direction at %s", async (side, currentPrice, expectedPnl) => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
		});
		const opened = await openPosition(db, "EURUSD", { side });
		const marked = await markPosition(db, state.positions[0].id, currentPrice);
		const payload = await marked.json();

		expect(opened.status).toBe(201);
		expect(marked.status).toBe(200);
		expect(payload.position.floating_pnl).toBeCloseTo(expectedPnl, 8);
		expect(payload.account.equity).toBeCloseTo(10000 + expectedPnl, 8);
	});

	it("calculates GBPUSD P&L in USD", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("GBPUSD")],
			allowedSymbols: ["GBPUSD"],
		});
		const opened = await openPosition(db, "GBPUSD", { price: 1.25 });
		const marked = await markPosition(db, state.positions[0].id, 1.26);

		expect(opened.status).toBe(201);
		expect((await marked.json()).position.floating_pnl).toBeCloseTo(100, 8);
	});

	it.each([
		["USDJPY", 150, 151, 10000 / 151],
		["USDCHF", 0.9, 0.91, 100 / 0.91],
		["USDCAD", 1.35, 1.36, 100 / 1.36],
	])("converts %s quote P&L to USD using the current pair price", async (symbol, openPrice, currentPrice, expectedUsdPnl) => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol(symbol)],
			allowedSymbols: [symbol],
		});
		const opened = await openPosition(db, symbol, { price: openPrice });
		const marked = await markPosition(db, state.positions[0].id, currentPrice);
		const payload = await marked.json();

		expect(opened.status).toBe(201);
		expect(marked.status).toBe(200);
		expect(payload.position.floating_pnl).toBeCloseTo(expectedUsdPnl, 8);
		expect(payload.account.equity).toBeCloseTo(10000 + expectedUsdPnl, 8);
	});

	it("rejects missing symbol calculation metadata without creating a trade", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD", { contract_size: null })],
			allowedSymbols: ["EURUSD"],
		});
		const response = await openPosition(db, "EURUSD");

		expect(response.status).toBe(400);
		expect(state.orders).toHaveLength(0);
		expect(state.positions).toHaveLength(0);
		expect(state.accounts[0]).toMatchObject({ balance: 10000, equity: 10000 });
	});

	it("rejects a missing live market quote without changing position or account state", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("USDJPY")],
			allowedSymbols: ["USDJPY"],
		});
		const opened = await openPosition(db, "USDJPY", { price: 150 });
		const originalPosition = { ...state.positions[0] };
		const response = await markPosition(db, originalPosition.id, 0);

		expect(opened.status).toBe(201);
		expect(response.status).toBe(503);
		expect(state.positions[0]).toEqual(originalPosition);
		expect(state.accounts[0]).toMatchObject({ balance: 10000, equity: 10000 });
	});

	it.each([
		["below minimum", 0.001, { minimum_lot: 0.01, lot_step: 0.01 }],
		["invalid step", 0.015, { minimum_lot: 0.01, lot_step: 0.01 }],
		["symbol maximum", 0.1, { minimum_lot: 0.01, lot_step: 0.01, maximum_lot: 0.05 }],
	])("rejects volume violating the %s lot rule", async (_label, volume, lotRules) => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD", lotRules)],
			allowedSymbols: ["EURUSD"],
		});
		const response = await openPosition(db, "EURUSD", { volume });

		expect(response.status).toBe(400);
		expect(state.orders).toHaveLength(0);
		expect(state.positions).toHaveLength(0);
	});

	it("enforces the account phase maximum lot size", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD")],
			allowedSymbols: ["EURUSD"],
			maxLotSize: 0.05,
		});
		const response = await openPosition(db, "EURUSD", { volume: 0.1 });

		expect(response.status).toBe(400);
		expect(state.orders).toHaveLength(0);
		expect(state.positions).toHaveLength(0);
	});

	it("aggregates floating P&L across multiple open positions", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD"), positionSymbol("GBPUSD")],
			allowedSymbols: ["EURUSD", "GBPUSD"],
		});
		await openPosition(db, "EURUSD");
		await openPosition(db, "GBPUSD", { side: "SELL" });
		await markPosition(db, state.positions[0].id, 1.26);
		const marked = await markPosition(db, state.positions[1].id, 1.24);
		const payload = await marked.json();

		expect(payload.account.equity).toBeCloseTo(10200, 8);
		expect(state.positions.reduce((sum, position) => sum + position.floating_pnl, 0)).toBeCloseTo(200, 8);
	});

	it("keeps other positions' floating P&L when one position is remarked", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD"), positionSymbol("GBPUSD")],
			allowedSymbols: ["EURUSD", "GBPUSD"],
		});
		await openPosition(db, "EURUSD");
		await openPosition(db, "GBPUSD", { side: "SELL" });
		await markPosition(db, state.positions[0].id, 1.26);
		await markPosition(db, state.positions[1].id, 1.24);
		const marked = await markPosition(db, state.positions[0].id, 1.255);
		const payload = await marked.json();

		expect(state.positions[1].floating_pnl).toBeCloseTo(100, 8);
		expect(payload.account.equity).toBeCloseTo(10150, 8);
	});

	it("preserves remaining floating P&L and balance/equity after closing a position", async () => {
		const { db, state } = positionHarness({
			symbols: [positionSymbol("EURUSD"), positionSymbol("GBPUSD")],
			allowedSymbols: ["EURUSD", "GBPUSD"],
		});
		await openPosition(db, "EURUSD");
		await openPosition(db, "GBPUSD");
		await markPosition(db, state.positions[0].id, 1.26);
		await markPosition(db, state.positions[1].id, 1.26);
		const closed = await closePosition(db, state.positions[0].id, 1.26);
		const payload = await closed.json();

		expect(closed.status).toBe(200);
		expect(payload.trade.realized_pnl).toBeCloseTo(100, 8);
		expect(payload.account).toMatchObject({ balance: 10100, equity: 10200 });
		expect(state.positions).toHaveLength(1);
		expect(state.positions[0].floating_pnl).toBeCloseTo(100, 8);
		expect(state.accounts[0]).toMatchObject({ balance: 10100, equity: 10200 });
	});

	it("uses the position metadata snapshot after the symbol catalog changes", async () => {
		const catalogSymbol = positionSymbol("EURUSD");
		const { db, state } = positionHarness({
			symbols: [catalogSymbol],
			allowedSymbols: ["EURUSD"],
		});
		const opened = await openPosition(db, "EURUSD");
		Object.assign(state.symbols[0], {
			base_currency: "USD",
			quote_currency: "JPY",
			volume_unit: "units",
			contract_size: 500000,
			price_decimals: 2,
			pip_size: 0.01,
			lot_step: 0.1,
			minimum_lot: 0.1,
			maximum_lot: 10,
		});
		const marked = await markPosition(db, state.positions[0].id, 1.26);
		const snapshot = JSON.parse(state.positionSnapshots[0].metadata_json);

		expect(opened.status).toBe(201);
		expect(snapshot).toMatchObject({
			base_currency: "EUR",
			quote_currency: "USD",
			volume_unit: "lot",
			contract_size: 100000,
			price_decimals: 5,
			pip_size: 0.0001,
			lot_step: 0.01,
			minimum_lot: 0.01,
			maximum_lot: null,
		});
		expect((await marked.json()).position.floating_pnl).toBeCloseTo(100, 8);
	});

	it("loads all approved symbol metadata without adding Futures symbols", () => {
		const database = new DatabaseSync(":memory:");
		try {
			for (const file of ["../schema.sql", "../migration_002.sql", "../seed_forex.sql", "../migration_005.sql"]) {
				database.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
			}

			const expectedSymbols = [
				"EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD",
				"NZDUSD", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD", "USOIL",
				"XCUUSD", "UKOIL", "XNGUSD", "USTEC", "US30", "US500", "GER40", "UK100", "AUS200",
			];
			const originalTradingAllowlist = [
				"EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD",
				"NZDUSD", "XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD", "USOIL",
			];
			expect(database.prepare("SELECT code FROM challenge_models ORDER BY code").all().map((row) => row.code)).toEqual([
				"1_STEP", "2_STEP", "INSTANT",
			]);
			const models = database.prepare("SELECT code, profit_split_percent, payout_frequency, custom_rules_json FROM challenge_models ORDER BY code").all();
			expect(models.map((row) => [row.code, row.profit_split_percent, row.payout_frequency, JSON.parse(row.custom_rules_json).reward_cycle_days])).toEqual([
				["1_STEP", 80, "every_5_days", 5],
				["2_STEP", 90, "every_7_days", 7],
				["INSTANT", 80, "daily", 1],
			]);
			expect(database.prepare("SELECT COUNT(*) AS count FROM challenge_model_phases").get().count).toBe(4);
			expect(database.prepare("SELECT COUNT(*) AS count FROM challenge_model_sizes").get().count).toBe(19);
			const sizes = database.prepare("SELECT m.code, s.size, s.price, s.currency, s.status FROM challenge_model_sizes s JOIN challenge_models m ON m.id = s.model_id ORDER BY m.code, s.size").all();
			expect(sizes.map((row) => [row.code, row.size, row.price])).toEqual([
				["1_STEP", 5000, 32], ["1_STEP", 10000, 64], ["1_STEP", 25000, 160],
				["1_STEP", 50000, 320], ["1_STEP", 100000, 640], ["1_STEP", 200000, 1280],
				["2_STEP", 5000, 27], ["2_STEP", 10000, 52], ["2_STEP", 25000, 130],
				["2_STEP", 50000, 260], ["2_STEP", 100000, 520], ["2_STEP", 200000, 1040],
				["INSTANT", 2500, 25], ["INSTANT", 5000, 49], ["INSTANT", 10000, 98],
				["INSTANT", 25000, 245], ["INSTANT", 50000, 490], ["INSTANT", 100000, 980],
				["INSTANT", 200000, 1960],
			]);
			expect(sizes.every((row) => row.currency === "USD" && row.status === "active")).toBe(true);
			const phases = database.prepare("SELECT m.code, p.phase_number, p.profit_target_percent, p.daily_drawdown_percent, p.max_drawdown_percent, p.max_drawdown_type, p.daily_drawdown_type, p.minimum_trading_days, p.next_phase_number FROM challenge_model_phases p JOIN challenge_models m ON m.id = p.model_id ORDER BY m.code, p.phase_number").all();
			expect(phases.map((row) => [row.code, row.phase_number, row.profit_target_percent, row.daily_drawdown_percent, row.max_drawdown_percent, row.max_drawdown_type, row.daily_drawdown_type, row.minimum_trading_days, row.next_phase_number])).toEqual([
				["1_STEP", 1, 10, 5, 10, "STATIC", "START_OF_DAY_EQUITY", 3, null],
				["2_STEP", 1, 6, 5, 10, "STATIC", "START_OF_DAY_EQUITY", 5, 2],
				["2_STEP", 2, 6, 5, 10, "STATIC", "START_OF_DAY_EQUITY", 5, null],
				["INSTANT", 1, null, 5, 10, "STATIC", "START_OF_DAY_EQUITY", 0, null],
			]);

			const symbolRows = database.prepare("SELECT symbol, category, base_currency, quote_currency, volume_unit, contract_size, price_decimals, pip_size, minimum_lot, lot_step, maximum_lot, trading_enabled FROM trading_symbols ORDER BY rowid").all();
			expect(symbolRows).toHaveLength(21);
			expect(symbolRows.map((row) => row.symbol)).toEqual(expectedSymbols);
			expect(symbolRows.slice(0, 12).map((row) => [
				row.symbol, row.category, row.base_currency, row.quote_currency,
				row.volume_unit, row.contract_size, row.price_decimals, row.pip_size,
				row.minimum_lot, row.lot_step, row.maximum_lot, row.trading_enabled,
			])).toEqual([
				["EURUSD", "FOREX", "EUR", "USD", "lot", 100000, 5, 0.0001, 0.01, 0.01, null, 1],
				["GBPUSD", "FOREX", "GBP", "USD", "lot", 100000, 5, 0.0001, 0.01, 0.01, null, 1],
				["USDJPY", "FOREX", "USD", "JPY", "lot", 100000, 3, 0.01, 0.01, 0.01, null, 1],
				["USDCHF", "FOREX", "USD", "CHF", "lot", 100000, 5, 0.0001, 0.01, 0.01, null, 1],
				["USDCAD", "FOREX", "USD", "CAD", "lot", 100000, 5, 0.0001, 0.01, 0.01, null, 1],
				["AUDUSD", "FOREX", "AUD", "USD", "lot", 100000, 5, 0.0001, 0.01, 0.01, null, 1],
				["NZDUSD", "FOREX", "NZD", "USD", "lot", 100000, 5, 0.0001, 0.01, 0.01, null, 1],
				["XAUUSD", "METALS", "XAU", "USD", "lot", 100, 2, 0.01, 0.01, 0.01, null, 1],
				["XAGUSD", "METALS", "XAG", "USD", "lot", 5000, 3, 0.01, 0.01, 0.01, null, 1],
				["BTCUSD", "CRYPTO", "BTC", "USD", "lot", 1, 1, 0.1, 0.01, 0.01, null, 1],
				["ETHUSD", "CRYPTO", "ETH", "USD", "lot", 1, 2, 0.1, 0.1, 0.1, null, 1],
				["USOIL", "ENERGY", "OIL", "USD", "lot", 1000, 2, 0.01, 0.01, 0.01, null, 1],
			]);
			const providerMappings = [
				["XAUUSD", "gold_api", "XAU/USD"],
				["EURUSD", "biquote", "EURUSD"], ["GBPUSD", "biquote", "GBPUSD"],
				["USDJPY", "biquote", "USDJPY"], ["BTCUSD", "biquote", "BTCUSD"],
				["ETHUSD", "biquote", "ETHUSD"], ["XAGUSD", "biquote", "XAGUSD"],
				["XCUUSD", "biquote", "XCUUSD"], ["UKOIL", "biquote", "UKOIL"],
				["USOIL", "biquote", "USOIL"], ["XNGUSD", "biquote", "XNGUSD"],
				["USTEC", "biquote", "USTEC"], ["US30", "biquote", "US30"],
				["US500", "biquote", "US500"], ["GER40", "biquote", "GER40"],
				["UK100", "biquote", "UK100"], ["AUS200", "biquote", "AUS200"],
			];
			for (const [symbol, provider, providerSymbol] of providerMappings) {
				const row = database.prepare("SELECT provider, provider_symbol, market_data_enabled, trading_enabled FROM trading_symbols WHERE symbol = ?").get(symbol);
				expect(row).toMatchObject({ provider, provider_symbol: providerSymbol, market_data_enabled: 1 });
				if (!originalTradingAllowlist.includes(symbol)) expect(row.trading_enabled).toBe(0);
			}
			expect(database.prepare("SELECT COUNT(*) AS count FROM trading_symbols WHERE category = 'FUTURES'").get().count).toBe(0);
			expect(database.prepare("SELECT COUNT(*) AS count FROM position_calculation_snapshots").get().count).toBe(0);

			const phaseAllowlists = database.prepare("SELECT allowed_symbols_json FROM challenge_model_phases").all();
			expect(phaseAllowlists).toHaveLength(4);
			expect(phaseAllowlists.every((row) => JSON.parse(row.allowed_symbols_json).join(",") === originalTradingAllowlist.join(","))).toBe(true);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			database.close();
		}
	});

	it("applies the trading execution migration to an existing trading schema", () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec(`
				CREATE TABLE orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
				CREATE TABLE positions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
			`);
			database.exec(readFileSync(new URL("../migration_007_trading_execution.sql", import.meta.url), "utf8"));

			const orderColumns = database.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
			const positionColumns = database.prepare("PRAGMA table_info(positions)").all().map((column) => column.name);
			const indexes = database.prepare("PRAGMA index_list(positions)").all().map((index) => index.name);
			expect(orderColumns).toContain("order_type");
			expect(positionColumns).toEqual(expect.arrayContaining(["take_profit", "stop_loss", "status"]));
			expect(indexes).toContain("idx_positions_account_status");
		} finally {
			database.close();
		}
	});
});
