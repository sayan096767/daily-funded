import assert from "node:assert/strict";
import test from "node:test";
import {
  candleFromLiveTick,
  loadCandleHistory,
  mergeHistoryWithLive,
  normalizeCandleBars,
} from "../src/candleHistory.js";

function bar(time, price = 10) {
  return {
    openTime: new Date(time).toISOString(),
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
  };
}

test("loads bounded pages backward, keeps provider bars unique, and preserves gaps", async () => {
  const baseTime = Date.UTC(2026, 0, 1);
  const firstPage = Array.from({ length: 1000 }, (_, index) => bar(baseTime + (999 - index) * 60_000));
  const requests = [];
  const history = await loadCandleHistory({
    symbol: "EURUSD",
    interval: "1m",
    fetchPage: async (request) => {
      requests.push(request);
      if (requests.length === 1) return firstPage;
      if (requests.length === 2) return [
        bar(baseTime - 60_000),
        firstPage[firstPage.length - 1],
      ];
      return [];
    },
  });

  assert.equal(history.length, 1001);
  assert.equal(requests[0].limit, 1000);
  assert.equal(requests[0].symbol, "EURUSD");
  assert.equal(requests[0].interval, "1m");
  assert.equal(requests[0].to, null);
  assert.equal(requests[1].to, new Date(baseTime - 1).toISOString());
  assert.equal(requests[2].to, new Date(baseTime - 60_001).toISOString());
  assert.deepEqual(history.map((candle) => candle.time), [...new Set(history.map((candle) => candle.time))]);
  assert.equal(history[0].timestampMs, baseTime - 60_000);
  assert.equal(history[history.length - 1].timestampMs, baseTime + 999 * 60_000);
});

test("uses the requested canonical symbol and timeframe and stops at no older unique bars", async () => {
  const requested = [];
  const baseTime = Date.UTC(2026, 1, 1);
  const history = await loadCandleHistory({
    symbol: "GER40",
    interval: "4h",
    fetchPage: async (request) => {
      requested.push(request);
      if (requested.length === 1) return [bar(baseTime + 4 * 60 * 60_000), bar(baseTime)];
      return [bar(baseTime + 4 * 60 * 60_000), bar(baseTime)];
    },
  });

  assert.equal(history.length, 2);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].symbol, "GER40");
  assert.equal(requested[0].interval, "4h");
  assert.equal(requested[1].to, new Date(baseTime - 1).toISOString());
});

test("normalizes only valid provider OHLC and preserves their exact UTC open times", () => {
  const valid = bar(Date.UTC(2026, 2, 1, 12, 34, 56), 100);
  const normalized = normalizeCandleBars([
    valid,
    valid,
    { ...valid, openTime: "not-a-provider-time" },
    { ...valid, high: 99 },
    { ...valid, close: 0 },
    bar(Date.UTC(2026, 2, 1, 12, 35, 56), 100),
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].timestampMs, Date.UTC(2026, 2, 1, 12, 34, 56));
  assert.equal(normalized[0].time, Date.UTC(2026, 2, 1, 12, 34, 56) / 1000);
  assert.equal(normalized[1].time - normalized[0].time, 60);
});

test("deduplicates exact timestamps without rounding distinct provider open times", () => {
  const baseTime = Date.UTC(2026, 2, 1, 12, 34, 56);
  const normalized = normalizeCandleBars([
    bar(baseTime + 750, 100),
    bar(baseTime + 250, 101),
    bar(baseTime + 750, 100),
  ]);

  assert.deepEqual(normalized.map((candle) => candle.timestampMs), [baseTime + 250, baseTime + 750]);
  assert.deepEqual(normalized.map((candle) => candle.time), [(baseTime + 250) / 1000, (baseTime + 750) / 1000]);
});

test("cancels an in-flight history chain before publishing an old symbol", async () => {
  const controller = new AbortController();
  let resolvePage;
  const published = [];
  const loading = loadCandleHistory({
    symbol: "XAUUSD",
    interval: "1m",
    signal: controller.signal,
    fetchPage: () => new Promise((resolve) => {
      resolvePage = resolve;
    }),
    onPage: (page) => published.push(page),
  });

  controller.abort();
  resolvePage([bar(Date.UTC(2026, 3, 1))]);
  await assert.rejects(loading, { name: "AbortError" });
  assert.deepEqual(published, []);

  const replacementRequests = [];
  const replacement = await loadCandleHistory({
    symbol: "GER40",
    interval: "4h",
    fetchPage: async (request) => {
      replacementRequests.push(request);
      return replacementRequests.length === 1 ? [bar(Date.UTC(2026, 3, 2))] : [];
    },
  });
  assert.equal(replacementRequests[0].symbol, "GER40");
  assert.equal(replacementRequests[0].interval, "4h");
  assert.equal(replacement.length, 1);
});

test("replays pending real ticks into the latest candle and rejects older buckets", () => {
  const intervalSeconds = 60;
  const time = 1_800_000_000;
  const baseline = {
    time,
    timestampMs: time * 1000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  };
  const pendingTicks = [
    { timestampMs: (time + 10) * 1000, mid: 102 },
    { timestampMs: (time + 30) * 1000, mid: 98 },
  ];
  const updated = pendingTicks.reduce(
    (candle, tick) => candleFromLiveTick(candle, tick, intervalSeconds),
    baseline,
  );
  assert.deepEqual(updated, { ...baseline, high: 102, low: 98, close: 98 });
  assert.equal(candleFromLiveTick(updated, { timestampMs: (time - 60) * 1000, mid: 98 }, intervalSeconds), null);

  const next = candleFromLiveTick(updated, { timestampMs: (time + 60) * 1000, mid: 103 }, intervalSeconds);
  assert.deepEqual(next, {
    time: time + 60,
    timestampMs: (time + 60) * 1000,
    open: 103,
    high: 103,
    low: 103,
    close: 103,
  });
});

test("keeps the chart empty when Biquote returns no real history", async () => {
  const history = await loadCandleHistory({
    symbol: "XNGUSD",
    interval: "1d",
    fetchPage: async () => [],
  });
  assert.deepEqual(history, []);
});

test("older history pages cannot overwrite live candle values", () => {
  const latestTime = 1_800_000_000;
  const history = normalizeCandleBars([
    bar((latestTime - 60) * 1000, 90),
    bar(latestTime * 1000, 100),
  ]);
  const live = new Map([[latestTime, {
    time: latestTime,
    timestampMs: latestTime * 1000,
    open: 100,
    high: 105,
    low: 98,
    close: 104,
  }], [latestTime + 60, {
    time: latestTime + 60,
    timestampMs: (latestTime + 60) * 1000,
    open: 106,
    high: 106,
    low: 106,
    close: 106,
  }]]);
  const merged = mergeHistoryWithLive(history, live);

  assert.equal(merged.length, 3);
  assert.equal(merged[0], history[0]);
  assert.deepEqual(merged[1], { ...history[1], high: 105, low: 98, close: 104 });
  assert.equal(merged[2].close, 106);
});
