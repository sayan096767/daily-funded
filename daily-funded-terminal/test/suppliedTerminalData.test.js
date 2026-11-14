import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePositionPnl,
  normalizeMarketCandles,
  normalizeMarketQuote,
  normalizeMarketSymbols,
  normalizeTerminalPosition,
} from "../src/suppliedTerminalData.js";

test("market symbols retain provider mappings and omit disabled or malformed rows", () => {
  const symbols = normalizeMarketSymbols([
    { symbol: " eurusd ", display_name: "Euro / US Dollar", provider: "biquote", provider_symbol: " EURUSD " },
    { symbol: "OFF", enabled: false },
    { display_name: "Missing symbol" },
  ], () => 5);

  assert.deepEqual(symbols, [{
    symbol: "EURUSD",
    name: "Euro / US Dollar",
    category: "Other",
    provider: "biquote",
    providerSymbol: "EURUSD",
    digits: 5,
  }]);
});

test("candle normalization rejects invalid data and never creates missing bars", () => {
  const candles = normalizeMarketCandles([
    { open_time: "2026-01-01T00:00:00Z", open: 10, high: 12, low: 9, close: 11 },
    { open_time: "not a date", open: 10, high: 12, low: 9, close: 11 },
    { open_time: "2026-01-01T00:01:00Z", open: 10, high: 9, low: 8, close: 11 },
  ]);

  assert.deepEqual(candles, [{ t: 1767225600, o: 10, h: 12, l: 9, c: 11, v: 0 }]);
  assert.deepEqual(normalizeMarketCandles([]), []);
});

test("market quotes require valid bid/ask and mark unavailable, closed, and old data stale", () => {
  const now = Date.parse("2026-01-01T00:01:00Z");
  const fresh = normalizeMarketQuote({
    symbol: "EURUSD",
    bid: 1.1,
    ask: 1.1002,
    timestamp: "2026-01-01T00:00:59Z",
  }, { streamReady: true, now });

  assert.equal(fresh.mid, 1.1001);
  assert.equal(fresh.stale, false);
  assert.equal(normalizeMarketQuote({
    symbol: "EURUSD",
    bid: 1.1,
    ask: 1.1002,
    mid: 1.10015,
    timestamp: now,
  }, { streamReady: true, now }).mid, 1.10015);
  assert.equal(normalizeMarketQuote({
    symbol: "EURUSD",
    bid: 1.1,
    ask: 1.1002,
    mid: 1.2,
    timestamp: now,
  }, { streamReady: true, now }).mid, 1.1001);
  assert.equal(normalizeMarketQuote({ symbol: "EURUSD", bid: 1.1, ask: 1.09, timestamp: now }, { streamReady: true, now }), null);
  assert.equal(normalizeMarketQuote({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: now }, { streamReady: false, now }).stale, true);
  assert.equal(normalizeMarketQuote({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: now - 301_000 }, { streamReady: true, now }).stale, true);
  assert.equal(normalizeMarketQuote({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: now + 61_000 }, { streamReady: true, now }).stale, true);
  assert.equal(normalizeMarketQuote({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: now, market_state: "closed" }, { streamReady: true, now }).stale, true);
  assert.equal(normalizeMarketQuote({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: now, stale: true }, { streamReady: true, now }).provider_stale, true);
});

test("server positions map to the supplied terminal model and use authoritative symbol metadata for PnL", () => {
  const position = normalizeTerminalPosition({
    id: "POS_1",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    open_price: 1.1,
    floating_pnl: null,
    pnl_metadata: { base_currency: "EUR", quote_currency: "USD", contract_size: 100000 },
  });
  assert.equal(position.sym, "EURUSD");
  assert.equal(position.side, "buy");
  assert.equal(position.lots, 0.1);
  assert.equal(position.pnl, null);
  assert.ok(Math.abs(calculatePositionPnl(position, { bid: 1.101, ask: 1.1012 }) - 10) < 1e-9);
  assert.equal(normalizeTerminalPosition({ ...position, side: "unknown" }), null);
});
