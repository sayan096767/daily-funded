import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProviderTick,
  providerSymbolMap,
  providerTimestampMilliseconds,
} from "../src/marketTick.js";
import { createLatestTickDispatcher } from "../src/tickDispatcher.js";

test("subscribes only to the worker's Biquote symbol mappings", () => {
  const mapping = providerSymbolMap([
    { symbol: "EURUSD", provider: "biquote", provider_symbol: "EURUSD" },
    { symbol: "XAUUSD", provider: "other", provider_symbol: "XAU/USD" },
    { symbol: "GBPUSD", provider: "biquote", provider_symbol: "GBP/USD" },
  ]);

  assert.deepEqual([...mapping], [["EURUSD", "EURUSD"], ["GBP/USD", "GBPUSD"]]);
});

test("forwards raw provider timestamp and Bid/Ask without generating prices", () => {
  const mapping = providerSymbolMap([
    { symbol: "EURUSD", provider: "biquote", provider_symbol: "EURUSD" },
  ]);
  const tick = normalizeProviderTick({
    symbol: "EURUSD",
    timestamp: "2026-10-05T00:00:00.000Z",
    bid: 1.1234,
    ask: 1.1236,
  }, mapping);

  assert.deepEqual(tick, {
    symbol: "EURUSD",
    provider_symbol: "EURUSD",
    timestamp: "2026-10-05T00:00:00.000Z",
    bid: 1.1234,
    ask: 1.1236,
  });
  assert.equal(normalizeProviderTick({ symbol: "EURUSD", bid: 1, ask: 2 }, mapping), null);
  assert.equal(normalizeProviderTick({ symbol: "UNKNOWN", timestamp: "now", bid: 1, ask: 2 }, mapping), null);
});

test("parses provider timestamps without substituting local arrival time", () => {
  assert.equal(providerTimestampMilliseconds("2026-10-05T00:00:00.123Z"), Date.parse("2026-10-05T00:00:00.123Z"));
  assert.equal(providerTimestampMilliseconds(1_791_190_000), 1_791_190_000_000);
  assert.equal(providerTimestampMilliseconds("not-a-provider-time"), null);
});

test("drops failed ticks, coalesces backlog to the newest tick, then continues after recovery", async () => {
  const delivered = [];
  const errors = [];
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const firstResponse = new Promise((_, reject) => { releaseFirst = reject; });
  const dispatcher = createLatestTickDispatcher(async (tick) => {
    delivered.push(tick.timestamp);
    if (delivered.length === 1) {
      firstStarted();
      await firstResponse;
    }
  }, (error, tick) => errors.push({ error: error.message, timestamp: tick.timestamp }));

  const firstDrain = dispatcher.submit({ symbol: "XAUUSD", timestamp: "2026-10-05T00:00:00.001Z" });
  await firstStartedPromise;
  dispatcher.submit({ symbol: "XAUUSD", timestamp: "2026-10-05T00:00:00.002Z" });
  dispatcher.submit({ symbol: "XAUUSD", timestamp: "2026-10-05T00:00:00.003Z" });
  releaseFirst(new Error("temporary Worker 503"));
  await firstDrain;

  assert.deepEqual(delivered, [
    "2026-10-05T00:00:00.001Z",
    "2026-10-05T00:00:00.003Z",
  ]);
  assert.deepEqual(errors, [{
    error: "temporary Worker 503",
    timestamp: "2026-10-05T00:00:00.001Z",
  }]);
  assert.equal(await dispatcher.submit({
    symbol: "XAUUSD",
    timestamp: "2026-10-05T00:00:00.001Z",
  }), false);

  await dispatcher.submit({ symbol: "XAUUSD", timestamp: "2026-10-05T00:00:00.004Z" });
  assert.equal(delivered.at(-1), "2026-10-05T00:00:00.004Z");
});

test("does not let an unresolved symbol delivery block another symbol", async () => {
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const delivered = [];
  const dispatcher = createLatestTickDispatcher(async (tick) => {
    delivered.push(tick.symbol);
    if (tick.symbol === "XAUUSD") await firstResponse;
  }, () => {});

  const goldDrain = dispatcher.submit({ symbol: "XAUUSD", timestamp: "2026-10-05T00:00:00.001Z" });
  await dispatcher.submit({ symbol: "EURUSD", timestamp: "2026-10-05T00:00:00.001Z" });
  assert.deepEqual(delivered, ["XAUUSD", "EURUSD"]);
  releaseFirst();
  await goldDrain;
});

test("ignores duplicate and out-of-order ticks per provider symbol", async () => {
  const delivered = [];
  const dispatcher = createLatestTickDispatcher(async (tick) => delivered.push(tick.timestamp), () => {});
  await dispatcher.submit({ symbol: "XAUUSD", timestamp: "2026-10-05T00:00:00.002Z" });
  assert.equal(await dispatcher.submit({
    symbol: "XAUUSD",
    timestamp: "2026-10-05T00:00:00.002Z",
  }), false);
  assert.equal(await dispatcher.submit({
    symbol: "XAUUSD",
    timestamp: "2026-10-05T00:00:00.001Z",
  }), false);
  assert.deepEqual(delivered, ["2026-10-05T00:00:00.002Z"]);
});
