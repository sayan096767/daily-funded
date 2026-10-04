import assert from "node:assert/strict";
import test from "node:test";
import {
  candleFromLiveTick,
  createCandleHistoryPager,
  fitInitialHistoryOnce,
  mergeHistoryWithLive,
  normalizeCandleBars,
  setSeriesDataPreservingVisibleRange,
  shouldLoadOlderHistory,
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

test("loads one initial page then older pages, deduplicates boundaries, and preserves gaps", async () => {
  const baseTime = Date.UTC(2026, 0, 1);
  const firstPage = Array.from({ length: 1000 }, (_, index) => bar(baseTime + (999 - index) * 60_000));
  const requests = [];
  const pager = createCandleHistoryPager({
    symbol: "EURUSD",
    interval: "1m",
    fetchPage: async (request) => {
      requests.push(request);
      if (requests.length === 1) return firstPage;
      if (requests.length === 2) return [
        bar(baseTime - 2 * 60_000),
        bar(baseTime - 60_000),
        firstPage[firstPage.length - 1],
      ];
      if (requests.length === 3) return [bar(baseTime - 3 * 60_000), bar(baseTime - 2 * 60_000)];
      return [];
    },
  });

  const initial = await pager.loadInitial();
  assert.equal(initial.candles.length, 1000);
  assert.equal(initial.hasMore, true);
  assert.equal(requests.length, 1);
  const older = await pager.loadOlder();
  assert.equal(older.candles.length, 1002);
  const oldest = await pager.loadOlder();
  const history = oldest.candles;
  assert.equal(history.length, 1003);
  assert.equal(oldest.hasMore, true);
  const exhausted = await pager.loadOlder();
  assert.equal(exhausted.hasMore, false);
  assert.equal(requests[0].limit, 1000);
  assert.equal(requests[0].symbol, "EURUSD");
  assert.equal(requests[0].interval, "1m");
  assert.equal(requests[0].to, null);
  assert.equal(requests[1].to, new Date(baseTime - 1).toISOString());
  assert.equal(requests[2].to, new Date(baseTime - 2 * 60_000 - 1).toISOString());
  assert.equal(requests[3].to, new Date(baseTime - 3 * 60_000 - 1).toISOString());
  assert.deepEqual(history.map((candle) => candle.time), [...new Set(history.map((candle) => candle.time))]);
  assert.equal(history[0].timestampMs, baseTime - 3 * 60_000);
  assert.equal(history[history.length - 1].timestampMs, baseTime + 999 * 60_000);
});

test("fits the initial page once and does not refit while older pages or live ticks arrive", async () => {
  const baseTime = Date.UTC(2026, 5, 1);
  const olderPage = Array.from({ length: 1000 }, (_, index) => bar(baseTime + index * 60_000));
  const newestPage = Array.from({ length: 1000 }, (_, index) =>
    bar(baseTime + (1000 + index) * 60_000));
  const requests = [];
  let currentSeriesData = [];
  const timeScale = {
    fitCount: 0,
    visibleRange: null,
    logicalRange: null,
    fitContent() {
      this.fitCount += 1;
      this.visibleRange = {
        from: currentSeriesData[0]?.time ?? null,
        to: currentSeriesData.at(-1)?.time ?? null,
      };
    },
    setVisibleLogicalRange(range) {
      this.logicalRange = range;
      this.visibleRange = {
        from: currentSeriesData[Math.floor(range.from)]?.time ?? null,
        to: currentSeriesData[Math.min(currentSeriesData.length - 1, Math.ceil(range.to) - 1)]?.time ?? null,
      };
    },
  };
  const fittedDataKeyRef = { current: "" };
  const pager = createCandleHistoryPager({
    symbol: "XAUUSD",
    interval: "1m",
    fetchPage: async (request) => {
      requests.push(request);
      if (requests.length === 1) return [...newestPage, newestPage[0]];
      if (requests.length === 2) return [...olderPage, newestPage[0]];
      return [];
    },
  });

  const initial = await pager.loadInitial();
  currentSeriesData = initial.candles;
  assert.equal(currentSeriesData.length, 1000);
  assert.equal(fitInitialHistoryOnce(
    timeScale,
    "XAUUSD|1m",
    pager.isLoading,
    fittedDataKeyRef,
    initial.candles.length,
  ), true);
  assert.equal(timeScale.fitCount, 1);
  assert.deepEqual(timeScale.logicalRange, { from: 850, to: 1005 });

  const expanded = await pager.loadOlder();
  currentSeriesData = expanded.candles;
  assert.equal(expanded.candles.length, 2000);
  assert.equal(currentSeriesData.length, 2000);
  assert.equal(expanded.candles[0].timestampMs, baseTime);
  assert.equal(expanded.candles.at(-1).timestampMs, baseTime + 1999 * 60_000);
  assert.equal(new Set(expanded.candles.map((candle) => candle.timestampMs)).size, 2000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].to, new Date(baseTime + (1000 * 60_000) - 1).toISOString());
  assert.equal(fitInitialHistoryOnce(timeScale, "XAUUSD|1m", pager.isLoading, fittedDataKeyRef), false);
  assert.equal(timeScale.fitCount, 1);

  const exhausted = await pager.loadOlder();
  assert.equal(exhausted.hasMore, false);
  assert.equal(requests.length, 3);

  currentSeriesData = expanded.candles;
  assert.equal(fitInitialHistoryOnce(timeScale, "XAUUSD|1m", false, fittedDataKeyRef), false);
  assert.deepEqual(timeScale.visibleRange, {
    from: (baseTime + (1000 + 850) * 60_000) / 1000,
    to: (baseTime + 1999 * 60_000) / 1000,
  });

  const liveUpdate = candleFromLiveTick(expanded.candles.at(-1), {
    timestampMs: expanded.candles.at(-1).timestampMs + 10_000,
    mid: 15,
  }, 60);
  assert.ok(liveUpdate);
  assert.equal(fitInitialHistoryOnce(timeScale, "XAUUSD|1m", false, fittedDataKeyRef), false);
  assert.equal(timeScale.fitCount, 1);
});

test("does not synthesize candles across gaps in provider history", async () => {
  const baseTime = Date.UTC(2026, 5, 1);
  const pager = createCandleHistoryPager({
    symbol: "EURUSD",
    interval: "1h",
    fetchPage: async () => [bar(baseTime + 2 * 60 * 60_000), bar(baseTime)],
  });
  const { candles: history } = await pager.loadInitial();

  assert.deepEqual(history.map((candle) => candle.timestampMs), [
    baseTime,
    baseTime + 2 * 60 * 60_000,
  ]);
  assert.equal(history.length, 2);
});

test("detects the left preload threshold and preserves visible timestamps after prepending", () => {
  assert.equal(shouldLoadOlderHistory({ from: 49 }), true);
  assert.equal(shouldLoadOlderHistory({ from: 50 }), true);
  assert.equal(shouldLoadOlderHistory({ from: 51 }), false);
  assert.equal(shouldLoadOlderHistory(null), false);

  const range = { from: 1_800_000_000, to: 1_800_000_200 };
  const calls = [];
  const timeScale = {
    getVisibleRange() { calls.push("read"); return range; },
    setVisibleRange(nextRange) { calls.push(["restore", nextRange]); },
  };
  const series = { setData(data) { calls.push(["setData", data.length]); } };
  const restored = setSeriesDataPreservingVisibleRange(
    series,
    timeScale,
    Array.from({ length: 200 }, (_, index) => ({ time: index })),
    true,
  );

  assert.deepEqual(restored, range);
  assert.deepEqual(calls, [
    "read",
    ["setData", 200],
    ["restore", range],
  ]);
});

test("coalesces repeated left-edge triggers into one older-page request", async () => {
  const baseTime = Date.UTC(2026, 6, 1);
  let resolvePage;
  let requestCount = 0;
  const pager = createCandleHistoryPager({
    symbol: "BTCUSD",
    interval: "5m",
    fetchPage: () => {
      requestCount += 1;
      if (requestCount === 1) return [bar(baseTime)];
      return new Promise((resolve) => {
        resolvePage = resolve;
      });
    },
  });

  await pager.loadInitial();
  const firstRequest = pager.loadOlder();
  const repeatedRequest = pager.loadOlder();
  assert.strictEqual(repeatedRequest, firstRequest);
  assert.equal(requestCount, 2);
  resolvePage([bar(baseTime - 5 * 60_000)]);
  const result = await firstRequest;
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[0].timestampMs, baseTime - 5 * 60_000);
});

test("live ticks continue while an older page is pending and remain authoritative", async () => {
  const latestTime = 1_800_000_000;
  let resolveOlderPage;
  let requestCount = 0;
  const pager = createCandleHistoryPager({
    symbol: "BTCUSD",
    interval: "1m",
    fetchPage: () => {
      requestCount += 1;
      if (requestCount === 1) return [bar(latestTime * 1000, 100)];
      return new Promise((resolve) => {
        resolveOlderPage = resolve;
      });
    },
  });
  const initial = await pager.loadInitial();
  const olderRequest = pager.loadOlder();
  const liveCandles = new Map();
  const tickCandle = candleFromLiveTick(initial.candles.at(-1), {
    timestampMs: (latestTime + 10) * 1000,
    mid: 110,
  }, 60);
  liveCandles.set(tickCandle.time, tickCandle);
  assert.equal(tickCandle.close, 110);
  resolveOlderPage([
    bar((latestTime - 60) * 1000, 90),
    bar(latestTime * 1000, 95),
  ]);
  const older = await olderRequest;
  const merged = mergeHistoryWithLive(older.candles, liveCandles);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].timestampMs, (latestTime - 60) * 1000);
  assert.equal(merged.at(-1).close, 110);
  assert.equal(merged.at(-1).high, 110);
});

test("a symbol or timeframe change waits for its own complete history before fitting", () => {
  const timeScale = { fitCount: 0, fitContent() { this.fitCount += 1; } };
  const fittedDataKeyRef = { current: "" };

  assert.equal(fitInitialHistoryOnce(timeScale, "XAUUSD|1m", true, fittedDataKeyRef), false);
  assert.equal(fitInitialHistoryOnce(timeScale, "XAUUSD|1m", false, fittedDataKeyRef), true);
  assert.equal(fitInitialHistoryOnce(timeScale, "GER40|1m", true, fittedDataKeyRef), false);
  assert.equal(fitInitialHistoryOnce(timeScale, "GER40|1m", false, fittedDataKeyRef), true);
  assert.equal(fitInitialHistoryOnce(timeScale, "GER40|4h", true, fittedDataKeyRef), false);
  assert.equal(fitInitialHistoryOnce(timeScale, "GER40|4h", false, fittedDataKeyRef), true);
  assert.equal(timeScale.fitCount, 3);
});

test("uses the requested canonical symbol and timeframe and stops at no older unique bars", async () => {
  const requested = [];
  const baseTime = Date.UTC(2026, 1, 1);
  const pager = createCandleHistoryPager({
    symbol: "GER40",
    interval: "4h",
    fetchPage: async (request) => {
      requested.push(request);
      if (requested.length === 1) return [bar(baseTime + 4 * 60 * 60_000), bar(baseTime)];
      return [bar(baseTime + 4 * 60 * 60_000), bar(baseTime)];
    },
  });

  const initial = await pager.loadInitial();
  assert.equal(initial.candles.length, 2);
  const exhausted = await pager.loadOlder();
  assert.equal(exhausted.candles.length, 2);
  assert.equal(exhausted.hasMore, false);
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

test("cancels pending symbol and timeframe requests before stale history can publish", async () => {
  const controller = new AbortController();
  let resolvePage;
  const oldPager = createCandleHistoryPager({
    symbol: "XAUUSD",
    interval: "1m",
    signal: controller.signal,
    fetchPage: () => new Promise((resolve) => {
      resolvePage = resolve;
    }),
  });
  const loading = oldPager.loadInitial();

  controller.abort();
  resolvePage([bar(Date.UTC(2026, 3, 1))]);
  await assert.rejects(loading, { name: "AbortError" });
  assert.deepEqual(oldPager.candles, []);

  const replacementRequests = [];
  const replacementPager = createCandleHistoryPager({
    symbol: "GER40",
    interval: "4h",
    fetchPage: async (request) => {
      replacementRequests.push(request);
      return replacementRequests.length === 1 ? [bar(Date.UTC(2026, 3, 2))] : [];
    },
  });
  const replacement = await replacementPager.loadInitial();
  assert.equal(replacementRequests[0].symbol, "GER40");
  assert.equal(replacementRequests[0].interval, "4h");
  assert.equal(replacement.candles.length, 1);

  const timeframeController = new AbortController();
  let resolveTimeframePage;
  const timeframePager = createCandleHistoryPager({
    symbol: "GER40",
    interval: "1m",
    signal: timeframeController.signal,
    fetchPage: () => new Promise((resolve) => {
      resolveTimeframePage = resolve;
    }),
  });
  const timeframeRequest = timeframePager.loadInitial();
  timeframeController.abort();
  resolveTimeframePage([bar(Date.UTC(2026, 3, 3))]);
  await assert.rejects(timeframeRequest, { name: "AbortError" });
  assert.deepEqual(timeframePager.candles, []);
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
  const pager = createCandleHistoryPager({
    symbol: "XNGUSD",
    interval: "1d",
    fetchPage: async () => [],
  });
  const result = await pager.loadInitial();
  assert.deepEqual(result.candles, []);
  assert.equal(result.hasMore, false);
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
