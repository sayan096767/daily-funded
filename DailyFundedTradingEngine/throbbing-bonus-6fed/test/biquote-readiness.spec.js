import { afterEach, describe, expect, it, vi } from "vitest";
import { negotiateBiquoteSignalR } from "../src/biquoteSignalR.js";
import { MarketFeedDO } from "../src/index.flexible.js";

const symbolRecord = {
	symbol: "XAUUSD",
	display_name: "Gold / US Dollar",
	category: "metals",
	provider: "biquote",
	provider_symbol: "XAUUSD",
};

function createFeed() {
	let writes = 0;
	const database = {
		prepare(query) {
			return {
				all: async () => ({
					results: query.includes("FROM trading_symbols") ? [symbolRecord] : [],
				}),
				run: async () => {
					writes += 1;
					throw new Error("Unexpected D1 write in feed readiness test");
				},
			};
		},
	};
	const state = {
		storage: {
			get: async () => null,
			setAlarm: async () => {},
		},
		blockConcurrencyWhile(callback) {
			return callback();
		},
	};
	const feed = new MarketFeedDO(state, { daily_funded_trading_db: database });
	feed.ensureConnection = async () => ({ connected: true });
	return { feed, getWrites: () => writes };
}

function stubFreshProviderQuote() {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
		XAUUSD: {
			bid: 100,
			ask: 101,
			timestamp: new Date(Date.now() - 1000).toISOString(),
			stale: false,
		},
	}))));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Biquote feed readiness", () => {
	it("preserves HTTPS for Cloudflare's outbound WebSocket upgrade fetch", async () => {
		const { socketUrl } = await negotiateBiquoteSignalR(async () => new Response(JSON.stringify({
			connectionToken: "test-connection-token",
			availableTransports: [{ transport: "WebSockets" }],
		})));
		const parsed = new URL(socketUrl);

		expect(parsed.protocol).toBe("https:");
		expect(parsed.pathname).toBe("/hubs/tick");
		expect(parsed.searchParams.get("id")).toBe("test-connection-token");
	});

	it("waits for the first fresh post-baseline tick after reconnect", async () => {
		stubFreshProviderQuote();
		const { feed, getWrites } = createFeed();
		await feed.initialized;
		await feed.refreshProviderBaselines();

		let responseResolved = false;
		const responsePromise = feed.fetch(new Request(
			"https://market-feed/ensure?symbol=XAUUSD",
			{ method: "POST" }
		)).then((response) => {
			responseResolved = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(responseResolved).toBe(false);

		await feed.acceptTick({
			symbol: "XAUUSD",
			provider_symbol: "XAUUSD",
			timestamp_ms: Date.now(),
			bid: 100,
			ask: 101,
		});
		const response = await responsePromise;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			connected: true,
			symbols: 1,
		});
		expect(getWrites()).toBe(0);
	});

	it("fails closed without a fresh tick and performs no D1 writes", async () => {
		stubFreshProviderQuote();
		const { feed, getWrites } = createFeed();
		await feed.initialized;
		await feed.refreshProviderBaselines();
		feed.waitForFreshSymbolTick = (symbol) =>
			MarketFeedDO.prototype.waitForFreshSymbolTick.call(feed, symbol, 1);

		const response = await feed.fetch(new Request(
			"https://market-feed/ensure?symbol=XAUUSD",
			{ method: "POST" }
		));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			connected: false,
			reason: "feed_not_connected",
		});
		expect(getWrites()).toBe(0);
	});
});
