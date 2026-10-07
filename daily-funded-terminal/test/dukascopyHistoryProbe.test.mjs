import assert from "node:assert/strict";
import test from "node:test";
import {
  SYMBOLS,
  TIMEFRAMES_SECONDS,
  createHistoricalDataAdapter,
  formatProbeReport,
  parseNormalizedCsv,
  probeExports,
} from "../scripts/probe-dukascopy-history.mjs";

test("normalized export CSV becomes real OHLC candles without synthesized rows", () => {
  assert.deepEqual(parseNormalizedCsv(
    "time,open,high,low,close,volume\r\n" +
    "2026-10-02T09:00:00Z,1.1,1.2,1.0,1.15,25\r\n" +
    "2026-10-02T09:01:00Z,1.15,1.2,1.1,1.18,\r\n"
  ), [
    { time: 1790931600, open: 1.1, high: 1.2, low: 1, close: 1.15, volume: 25 },
    { time: 1790931660, open: 1.15, high: 1.2, low: 1.1, close: 1.18, volume: null },
  ]);
});

test("provider-agnostic adapter normalizes, filters, sorts, and deduplicates candles", async () => {
  const adapter = createHistoricalDataAdapter({
    async getHistoricalCandles(params) {
      assert.deepEqual(params, {
        symbol: "EUR/USD",
        timeframe: "1m",
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-01T00:02:00Z",
        limit: 2,
      });
      return [
        { time: "2026-10-01T00:02:00Z", open: 3, high: 4, low: 2, close: 3.5 },
        { time: "2026-10-01T00:01:00Z", open: 2, high: 3, low: 1, close: 2.5, volume: 12 },
        { time: "2026-10-01T00:01:00Z", open: 2, high: 3, low: 1, close: 2.4, volume: 12 },
        { time: "2026-09-30T23:59:00Z", open: 1, high: 2, low: 0.5, close: 1.5 },
      ];
    },
  });

  assert.deepEqual(await adapter.getHistoricalCandles({
    symbol: "EURUSD",
    timeframe: "1m",
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-01T00:02:00Z",
    limit: 2,
  }), [
    { time: 1790812860, open: 2, high: 3, low: 1, close: 2.5, volume: 12 },
    { time: 1790812920, open: 3, high: 4, low: 2, close: 3.5, volume: null },
  ]);
});

test("adapter rejects unsupported inputs and malformed provider candles", async () => {
  const adapter = createHistoricalDataAdapter({
    async getHistoricalCandles() {
      return [{ time: "not-a-date", open: 1, high: 1, low: 1, close: 1 }];
    },
  });
  await assert.rejects(
    adapter.getHistoricalCandles({ symbol: "UNKNOWN", timeframe: "1m", limit: 1 }),
    /Unsupported canonical symbol/
  );
  await assert.rejects(
    adapter.getHistoricalCandles({ symbol: "EURUSD", timeframe: "2m", limit: 1 }),
    /Unsupported timeframe/
  );
  await assert.rejects(
    adapter.getHistoricalCandles({ symbol: "EURUSD", timeframe: "1m", limit: 1 }),
    /invalid candle/
  );
});

test("probe covers all requested symbol/timeframe combinations and reports missing exports", async () => {
  const results = await probeExports("C:\\this-path-does-not-contain-dukascopy-exports");
  assert.equal(Object.keys(SYMBOLS).length, 17);
  assert.equal(Object.keys(TIMEFRAMES_SECONDS).length, 6);
  assert.equal(results.length, 102);
  assert.ok(results.every((result) => result.status === "EXPORT MISSING"));
  assert.match(formatProbeReport(results), /SYMBOL \| TIMEFRAME \| EARLIEST \| LATEST \| CANDLE COUNT/);
});
