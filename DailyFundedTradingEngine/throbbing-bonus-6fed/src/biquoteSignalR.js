export const BIQUOTE_HUB_URL = "https://biquote.io/hubs/tick";

export function signalRRecord(message) {
  return `${JSON.stringify(message)}\x1e`;
}

export function parseSignalRFrames(buffer, chunk) {
  const next = buffer + (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  if (next.length > 1_000_000) throw new Error("SignalR receive buffer exceeded its limit");
  const frames = [];
  let remaining = next;
  let separator = remaining.indexOf("\x1e");
  while (separator !== -1) {
    const frame = remaining.slice(0, separator);
    if (frame) frames.push(JSON.parse(frame));
    remaining = remaining.slice(separator + 1);
    separator = remaining.indexOf("\x1e");
  }
  return { buffer: remaining, frames };
}

export async function negotiateBiquoteSignalR(fetcher = fetch, hubUrl = BIQUOTE_HUB_URL) {
  const hub = new URL(hubUrl);
  const negotiateUrl = new URL(hub);
  negotiateUrl.pathname = `${negotiateUrl.pathname.replace(/\/+$/, "")}/negotiate`;
  negotiateUrl.searchParams.set("negotiateVersion", "1");

  const response = await fetcher(negotiateUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: "",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Biquote SignalR negotiate failed (${response.status})`);
  const negotiation = await response.json();
  if (negotiation.error || negotiation.url) {
    throw new Error("Biquote SignalR redirects are not supported by this feed client");
  }
  if (!negotiation.availableTransports?.some((item) => item.transport === "WebSockets")) {
    throw new Error("Biquote SignalR does not offer WebSockets");
  }
  const connectionId = negotiation.connectionToken || negotiation.connectionId;
  if (typeof connectionId !== "string" || !connectionId) {
    throw new Error("Biquote SignalR negotiation returned no connection token");
  }

  const socketUrl = new URL(hub);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("id", connectionId);
  return { socketUrl: socketUrl.toString() };
}
