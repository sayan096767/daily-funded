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

export async function loadCandleHistory({ symbol, interval, signal, fetchPage, onPage }) {
  const candlesByTime = new Map();
  let cursor = null;
  let pageCount = 0;
  let oldestLoaded = null;

  while (true) {
    throwIfAborted(signal);
    const rows = await fetchPage({
      symbol,
      interval,
      limit: CANDLE_HISTORY_PAGE_SIZE,
      to: cursor,
      signal,
    });
    throwIfAborted(signal);
    pageCount += 1;

    const page = normalizeCandleBars(rows);
    if (!page.length) break;

    let oldestNewTime = null;
    for (const candle of page) {
      if (candlesByTime.has(candle.time)) continue;
      candlesByTime.set(candle.time, candle);
      if (oldestLoaded === null || candle.time < oldestLoaded) {
        oldestNewTime = oldestNewTime === null ? candle.time : Math.min(oldestNewTime, candle.time);
      }
    }

    if (pageCount === 1 || pageCount % 10 === 0) {
      onPage?.([...candlesByTime.values()].sort((left, right) => left.time - right.time), {
        pageCount,
        complete: false,
      });
    }

    if (oldestLoaded !== null && oldestNewTime === null) break;
    const pageOldest = page[0];
    oldestLoaded = oldestLoaded === null
      ? pageOldest.time
      : Math.min(oldestLoaded, oldestNewTime);
    cursor = new Date(pageOldest.timestampMs - 1).toISOString();
    await yieldToBrowser(signal);
  }

  throwIfAborted(signal);
  return [...candlesByTime.values()].sort((left, right) => left.time - right.time);
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
