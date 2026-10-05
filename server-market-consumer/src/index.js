import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import { normalizeProviderTick, providerSymbolMap } from "./marketTick.js";
import { createLatestTickDispatcher } from "./tickDispatcher.js";

const workerUrl = requiredEnvironment("CLOUDFLARE_TRADING_WORKER_URL").replace(/\/+$/, "");
const ingestToken = requiredEnvironment("MARKET_TICK_INGEST_TOKEN");
const hubUrl = process.env.BIQUOTE_HUB_URL || "https://biquote.io/hubs/tick";
const reconnectDelayMs = 5000;
let stopped = false;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

async function loadSubscriptions() {
  const response = await fetch(`${workerUrl}/market/symbols`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Symbol catalog request failed (${response.status})`);
  const payload = await response.json();
  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  const canonicalByProvider = providerSymbolMap(symbols);
  if (!canonicalByProvider.size) throw new Error("No Biquote symbols are configured");
  return { canonicalByProvider, providerSymbols: [...canonicalByProvider.keys()] };
}

async function runConsumer() {
  const { canonicalByProvider, providerSymbols } = await loadSubscriptions();
  const connection = new HubConnectionBuilder()
    .withUrl(hubUrl)
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Error)
    .build();
  const tickDispatcher = createLatestTickDispatcher(async (tick) => {
    if (stopped) return;
    const response = await fetch(`${workerUrl}/internal/market-tick`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(tick),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`Tick processing failed (${response.status}): ${payload.error || "worker error"}`);
    }
  });

  const subscribe = async () => {
    await connection.invoke("Subscribe", providerSymbols);
    console.info(`Subscribed server protection consumer to ${providerSymbols.length} Biquote symbols`);
  };

  connection.on("ReceiveTick", (tick) => {
    const normalizedTick = normalizeProviderTick(tick, canonicalByProvider);
    if (normalizedTick) void tickDispatcher.submit(normalizedTick);
  });

  connection.onreconnected(async () => {
    try {
      await subscribe();
    } catch (error) {
      console.error("Unable to resubscribe after Biquote reconnect:", error);
      await connection.stop();
    }
  });

  while (!stopped) {
    try {
      if (connection.state === "Disconnected") await connection.start();
      await subscribe();
      await new Promise((resolve) => {
        const stop = () => resolve();
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        connection.onclose(stop);
      });
    } catch (error) {
      console.error("Biquote protection connection failed:", error);
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
  }

  await connection.stop();
}

process.once("SIGTERM", () => { stopped = true; });
process.once("SIGINT", () => { stopped = true; });

runConsumer().catch((error) => {
  console.error("Biquote protection consumer stopped:", error);
  process.exitCode = 1;
});
