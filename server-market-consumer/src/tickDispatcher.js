import { providerTimestampMilliseconds } from "./marketTick.js";

export function createLatestTickDispatcher(
  deliver,
  onDeliveryError = (error, tick) => console.error(
    `Unable to process Biquote tick ${tick.timestamp}; dropping it:`,
    error
  )
) {
  const lastQueuedTimestamp = new Map();
  const pendingBySymbol = new Map();
  const drains = new Map();

  async function drain(symbol) {
    while (pendingBySymbol.has(symbol)) {
      const tick = pendingBySymbol.get(symbol);
      pendingBySymbol.delete(symbol);
      try {
        await deliver(tick);
      } catch (error) {
        try {
          onDeliveryError(error, tick);
        } catch (reportingError) {
          console.error("Unable to report Biquote tick delivery failure:", reportingError);
        }
      }
    }
  }

  function startDrain(symbol) {
    const running = drain(symbol).finally(() => {
      drains.delete(symbol);
      if (pendingBySymbol.has(symbol)) startDrain(symbol);
    });
    drains.set(symbol, running);
    return running;
  }

  function submit(tick) {
    if (!tick || typeof tick.symbol !== "string") return Promise.resolve(false);
    const timestamp = providerTimestampMilliseconds(tick.timestamp);
    if (timestamp === null || timestamp <= (lastQueuedTimestamp.get(tick.symbol) ?? -Infinity)) {
      return Promise.resolve(false);
    }

    lastQueuedTimestamp.set(tick.symbol, timestamp);
    pendingBySymbol.set(tick.symbol, tick);
    if (!drains.has(tick.symbol)) {
      return startDrain(tick.symbol);
    }
    return drains.get(tick.symbol);
  }

  return { submit };
}
