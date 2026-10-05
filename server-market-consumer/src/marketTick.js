export function providerSymbolMap(symbols) {
  const canonicalByProvider = new Map();
  for (const item of symbols) {
    if (item?.provider !== "biquote" || typeof item.provider_symbol !== "string" ||
      typeof item.symbol !== "string") continue;
    const providerSymbol = item.provider_symbol.trim().toUpperCase();
    const symbol = item.symbol.trim().toUpperCase();
    if (providerSymbol && symbol) canonicalByProvider.set(providerSymbol, symbol);
  }
  return canonicalByProvider;
}

export function providerTimestampMilliseconds(timestamp) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  }
  if (typeof timestamp !== "string" || !timestamp.trim()) return null;
  const value = timestamp.trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    return number < 1_000_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeProviderTick(tick, canonicalByProvider) {
  if (!tick || typeof tick !== "object" || typeof tick.symbol !== "string") return null;
  const providerSymbol = tick.symbol.trim().toUpperCase();
  const symbol = canonicalByProvider.get(providerSymbol);
  if (!symbol || providerTimestampMilliseconds(tick.timestamp) === null) return null;
  return {
    symbol,
    provider_symbol: providerSymbol,
    timestamp: tick.timestamp,
    bid: tick.bid,
    ask: tick.ask,
  };
}
