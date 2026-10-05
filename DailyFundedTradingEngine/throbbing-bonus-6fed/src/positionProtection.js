export function protectionPrice(position, tick) {
  const price = position?.side === "BUY"
    ? Number(tick?.bid)
    : position?.side === "SELL"
      ? Number(tick?.ask)
      : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function tickIsAfterPositionOpen(position, tick) {
  const timestampMs = Number(tick?.timestamp_ms);
  const openedAtMs = Date.parse(position?.opened_at);
  return Number.isFinite(timestampMs) && timestampMs > 0 &&
    Number.isFinite(openedAtMs) && timestampMs > openedAtMs;
}

export function triggeredProtection(position, tick) {
  if (!tickIsAfterPositionOpen(position, tick)) return null;
  const price = protectionPrice(position, tick);
  if (price === null) return null;
  const stopLoss = Number(position.stop_loss);
  const takeProfit = Number(position.take_profit);

  if (Number.isFinite(stopLoss) && stopLoss > 0 &&
    (position.side === "BUY" ? price <= stopLoss : price >= stopLoss)) {
    return { reason: "STOP_LOSS", price };
  }
  if (Number.isFinite(takeProfit) && takeProfit > 0 &&
    (position.side === "BUY" ? price >= takeProfit : price <= takeProfit)) {
    return { reason: "TAKE_PROFIT", price };
  }
  return null;
}
