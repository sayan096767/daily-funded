export function normalizeMarketSymbols(rows, priceDigits) {
  if (!Array.isArray(rows)) throw new Error("The market service returned an invalid symbol catalog.");
  return rows.flatMap((row) => {
    const symbol = typeof row?.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    if (!symbol || row.enabled === false || row.is_enabled === false) return [];
    return [{
      symbol,
      name: typeof row.display_name === "string" && row.display_name.trim()
        ? row.display_name.trim()
        : symbol,
      category: typeof row.category === "string" ? row.category : "Other",
      provider: row.provider,
      providerSymbol: typeof row.provider_symbol === "string"
        ? row.provider_symbol.trim().toUpperCase()
        : "",
      digits: priceDigits(symbol),
    }];
  });
}

export function normalizeMarketCandles(rows) {
  if (!Array.isArray(rows)) throw new Error("The market service returned malformed candle data.");
  const candles = new Map();
  for (const row of rows) {
    const timestamp = Date.parse(row?.open_time ?? row?.openTime);
    const [open, high, low, close] = [row?.open, row?.high, row?.low, row?.close].map(Number);
    if (
      !Number.isFinite(timestamp) ||
      ![open, high, low, close].every((price) => Number.isFinite(price) && price > 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close)
    ) continue;
    const time = Math.floor(timestamp / 1000);
    if (!candles.has(time)) {
      const volume = Number(row.volume ?? row.tick_volume);
      candles.set(time, {
        t: time,
        o: open,
        h: high,
        l: low,
        c: close,
        v: Number.isFinite(volume) && volume >= 0 ? volume : 0,
      });
    }
  }
  return [...candles.values()].sort((left, right) => left.t - right.t);
}

export function normalizeMarketQuote(raw, { streamReady, now = Date.now(), symbol = raw?.symbol } = {}) {
  const timestampValue = raw?.timestamp;
  const timestamp = typeof timestampValue === "number" ||
    (typeof timestampValue === "string" && /^\d+(\.\d+)?$/.test(timestampValue))
    ? Number(timestampValue)
    : typeof timestampValue === "string"
      ? Date.parse(timestampValue)
      : NaN;
  const timestampMs = Number.isFinite(timestamp)
    ? (timestamp < 1e12 ? timestamp * 1000 : timestamp)
    : NaN;
  const bid = raw?.bid === null || raw?.bid === undefined || raw?.bid === ""
    ? NaN
    : Number(raw.bid);
  const ask = raw?.ask === null || raw?.ask === undefined || raw?.ask === ""
    ? NaN
    : Number(raw.ask);
  const providerMid = raw?.mid === null || raw?.mid === undefined || raw?.mid === ""
    ? NaN
    : Number(raw.mid);
  if (
    typeof symbol !== "string" ||
    !symbol.trim() ||
    !Number.isFinite(timestampMs) ||
    !Number.isFinite(bid) || bid <= 0 ||
    !Number.isFinite(ask) || ask < bid
  ) return null;
  const marketState = raw.market_state ?? raw.marketState ?? null;
  return {
    symbol: symbol.trim().toUpperCase(),
    bid,
    ask,
    mid: Number.isFinite(providerMid) && providerMid >= bid && providerMid <= ask
      ? providerMid
      : (bid + ask) / 2,
    timestamp: timestampValue,
    timestampMs,
    market_state: marketState,
    provider_stale: raw.stale === true,
    stale: raw.stale === true ||
      !streamReady ||
      String(marketState).toLowerCase() === "closed" ||
      timestampMs > now + 60_000 ||
      now - timestampMs > 5 * 60 * 1000,
  };
}

export function normalizeTerminalPosition(position) {
  if (
    !position ||
    typeof position.id !== "string" ||
    typeof position.symbol !== "string" ||
    !["BUY", "SELL"].includes(position.side) ||
    position.volume === null || position.volume === undefined || position.volume === "" ||
    !Number.isFinite(Number(position.volume)) || Number(position.volume) <= 0 ||
    position.open_price === null || position.open_price === undefined || position.open_price === "" ||
    !Number.isFinite(Number(position.open_price)) || Number(position.open_price) <= 0
  ) return null;
  return {
    ...position,
    sym: position.symbol.toUpperCase(),
    side: position.side.toLowerCase(),
    lots: Number(position.volume),
    open: Number(position.open_price),
    tp: Number(position.take_profit) || 0,
    sl: Number(position.stop_loss) || 0,
    t: Date.parse(position.opened_at) || 0,
    pnl: position.floating_pnl !== null &&
      position.floating_pnl !== undefined &&
      position.floating_pnl !== "" &&
      Number.isFinite(Number(position.floating_pnl))
      ? Number(position.floating_pnl)
      : null,
  };
}

export function normalizeTerminalTrade(trade) {
  if (
    !trade ||
    typeof trade.id !== "string" ||
    typeof trade.symbol !== "string" ||
    !["BUY", "SELL"].includes(trade.side) ||
    trade.volume === null || trade.volume === undefined || !Number.isFinite(Number(trade.volume)) ||
    Number(trade.volume) <= 0 ||
    trade.open_price === null || trade.open_price === undefined || !Number.isFinite(Number(trade.open_price)) ||
    Number(trade.open_price) <= 0 ||
    trade.close_price === null || trade.close_price === undefined || !Number.isFinite(Number(trade.close_price)) ||
    Number(trade.close_price) <= 0
  ) return null;
  const pnl = trade.realized_pnl === null || trade.realized_pnl === undefined
    ? null
    : Number.isFinite(Number(trade.realized_pnl)) ? Number(trade.realized_pnl) : null;
  const closedAt = Date.parse(trade.closed_at);
  return {
    sym: trade.symbol.toUpperCase(),
    side: trade.side.toLowerCase(),
    lots: Number(trade.volume),
    open: Number(trade.open_price),
    close: Number(trade.close_price),
    pl: pnl,
    why: "Closed",
    t: Number.isFinite(closedAt) ? new Date(closedAt) : null,
  };
}

export function calculatePositionPnl(position, quote) {
  const metadata = position?.pnl_metadata;
  const price = position?.side === "buy" ? Number(quote?.bid) : Number(quote?.ask);
  const open = Number(position?.open);
  const volume = Number(position?.lots);
  const contractSize = Number(metadata?.contract_size);
  const base = typeof metadata?.base_currency === "string" ? metadata.base_currency.toUpperCase() : "";
  const quoteCurrency = typeof metadata?.quote_currency === "string" ? metadata.quote_currency.toUpperCase() : "";
  if (
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(open) || open <= 0 ||
    !Number.isFinite(volume) || volume <= 0 ||
    !Number.isFinite(contractSize) || contractSize <= 0 ||
    !base || !quoteCurrency
  ) return null;
  const amount = (position.side === "buy" ? 1 : -1) * (price - open) * volume * contractSize;
  if (quoteCurrency === "USD") return amount;
  if (base === "USD" && ["JPY", "CHF", "CAD"].includes(quoteCurrency)) return amount / price;
  return null;
}
