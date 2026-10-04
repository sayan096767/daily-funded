export const CANDLE_HISTORY_PAGE_SIZE = 1000;

function abortError() {
  const error = new Error("Historical candle loading was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function yieldToBrowser(signal) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer !== null) globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = globalThis.setTimeout(finish, 0);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function normalizeCandleBars(rows) {
  const candlesByTime = new Map();
  for (const row of rows) {
    const timestampMs = Date.parse(row?.open_time ?? row?.openTime);
    const [open, high, low, close] = [row?.open, row?.high, row?.low, row?.close].map(Number);
    if (
      !Number.isFinite(timestampMs) ||
      ![open, high, low, close].every((price) => Number.isFinite(price) && price > 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close)
    ) continue;

    const time = timestampMs / 1000;
    if (!candlesByTime.has(timestampMs)) {
      candlesByTime.set(timestampMs, { time, timestampMs, open, high, low, close });
    }
  }
  return [...candlesByTime.values()].sort((left, right) => left.time - right.time);
}

export function createCandleHistoryPager({ symbol, interval, signal, fetchPage }) {
  const candlesByTime = new Map();
  let cursor = null;
  let pageCount = 0;
  let initialized = false;
  let hasMore = true;
  let request = null;
  let oldestLoaded = null;

  const snapshot = () => [...candlesByTime.values()].sort((left, right) => left.time - right.time);

  const result = (added = 0) => ({
    candles: snapshot(),
    added,
    hasMore,
    pageCount,
  });

  const loadPage = () => {
    if (request) return request;
    if (!hasMore) return Promise.resolve(result());

    request = (async () => {
      throwIfAborted(signal);
      const rows = await fetchPage({
        symbol,
        interval,
        limit: CANDLE_HISTORY_PAGE_SIZE,
        to: initialized ? cursor : null,
        signal,
      });
      throwIfAborted(signal);
      pageCount += 1;

      const page = normalizeCandleBars(rows);
      if (!page.length) {
        hasMore = false;
        initialized = true;
        return result();
      }

      let added = 0;
      const previousOldestLoaded = oldestLoaded;
      let foundOlder = !initialized;
      for (const candle of page) {
        if (candlesByTime.has(candle.time)) continue;
        candlesByTime.set(candle.time, candle);
        oldestLoaded = oldestLoaded === null ? candle.time : Math.min(oldestLoaded, candle.time);
        if (previousOldestLoaded === null || candle.time < previousOldestLoaded) foundOlder = true;
        added += 1;
      }

      if (initialized && !foundOlder) {
        hasMore = false;
      } else {
        cursor = new Date(oldestLoaded * 1000 - 1).toISOString();
      }
      initialized = true;
      await yieldToBrowser(signal);
      throwIfAborted(signal);
      return result(added);
    })().finally(() => {
      request = null;
    });

    return request;
  };

  return {
    loadInitial: loadPage,
    loadOlder: loadPage,
    get hasMore() {
      return hasMore;
    },
    get isLoading() {
      return request !== null;
    },
    get candles() {
      return snapshot();
    },
    get pageCount() {
      return pageCount;
    },
  };
}

export function candleFromLiveTick(lastCandle, tick, intervalSeconds) {
  if (
    !Number.isFinite(tick?.timestampMs) ||
    !Number.isFinite(Number(tick?.mid)) ||
    Number(tick.mid) <= 0 ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds <= 0
  ) return null;

  const time = Math.floor(tick.timestampMs / (intervalSeconds * 1000)) * intervalSeconds;
  if (lastCandle && time < lastCandle.time) return null;
  const mid = Number(tick.mid);
  return lastCandle && time === lastCandle.time
    ? {
      ...lastCandle,
      high: Math.max(lastCandle.high, mid),
      low: Math.min(lastCandle.low, mid),
      close: mid,
    }
    : { time, timestampMs: time * 1000, open: mid, high: mid, low: mid, close: mid };
}

export function mergeHistoryWithLive(history, liveCandles) {
  const candlesByTime = new Map(history.map((candle) => [candle.time, candle]));
  const latestHistoryTime = history.length ? history[history.length - 1].time : -Infinity;
  for (const liveCandle of liveCandles.values()) {
    const historical = candlesByTime.get(liveCandle.time);
    if (historical) {
      candlesByTime.set(liveCandle.time, {
        ...historical,
        high: Math.max(historical.high, liveCandle.high),
        low: Math.min(historical.low, liveCandle.low),
        close: liveCandle.close,
      });
    } else if (liveCandle.time >= latestHistoryTime) {
      candlesByTime.set(liveCandle.time, liveCandle);
    }
  }
  return [...candlesByTime.values()].sort((left, right) => left.time - right.time);
}

export function fitInitialHistoryOnce(timeScale, dataKey, loadingMore, fittedDataKeyRef, candleCount) {
  if (loadingMore || !dataKey || fittedDataKeyRef.current === dataKey || !timeScale) return false;
  timeScale.fitContent();
  if (Number.isFinite(candleCount) && candleCount > 150) {
    timeScale.setVisibleLogicalRange({
      from: candleCount - 150,
      to: candleCount + 5,
    });
  }
  fittedDataKeyRef.current = dataKey;
  return true;
}

export function shouldLoadOlderHistory(logicalRange, preloadBars = 50) {
  return Number.isFinite(logicalRange?.from) && logicalRange.from <= preloadBars;
}

export function setSeriesDataPreservingVisibleRange(series, timeScale, data, preserveRange) {
  const visibleRange = preserveRange ? timeScale?.getVisibleRange?.() : null;
  series.setData(data);
  if (visibleRange) timeScale.setVisibleRange(visibleRange);
  return visibleRange;
}
