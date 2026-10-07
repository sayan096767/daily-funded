import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  XAUUSD: "XAU/USD",
  XAGUSD: "XAG/USD",
  XCUUSD: "COPPER.CMD/USD",
  BTCUSD: "BTC/USD",
  ETHUSD: "ETH/USD",
  USOIL: "LIGHT.CMD/USD",
  UKOIL: "BRENT.CMD/USD",
  XNGUSD: "GAS.CMD/USD",
  USTEC: "USATECH.IDX/USD",
  US30: "USA30.IDX/USD",
  US500: "USA500.IDX/USD",
  GER40: "DEU.IDX/EUR",
  UK100: "GBR.IDX/GBP",
  AUS200: "AUS.IDX/AUD",
};

export const TIMEFRAMES_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    return numeric > 1e12 ? numeric / 1000 : numeric;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : NaN;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  cells.push(cell.trim());
  return cells;
}

export function parseNormalizedCsv(contents) {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((name) => name.trim().toLowerCase());
  const required = ["time", "open", "high", "low", "close"];
  const columns = Object.fromEntries(header.map((name, index) => [name, index]));
  const missing = required.filter((name) => columns[name] === undefined);
  if (missing.length) {
    throw new Error(`CSV requires normalized columns: ${required.join(", ")}; missing ${missing.join(", ")}`);
  }

  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line);
    const time = parseTime(cells[columns.time]);
    const prices = ["open", "high", "low", "close"].map((name) => Number(cells[columns[name]]));
    const volumeCell = columns.volume === undefined ? "" : cells[columns.volume];
    const volume = volumeCell === "" || volumeCell === undefined ? null : Number(volumeCell);
    if (
      !Number.isFinite(time) ||
      prices.some((price) => !Number.isFinite(price) || price <= 0) ||
      prices[1] < Math.max(prices[0], prices[3]) ||
      prices[2] > Math.min(prices[0], prices[3]) ||
      (volume !== null && (!Number.isFinite(volume) || volume < 0))
    ) {
      throw new Error(`CSV row ${rowIndex + 2} contains an invalid candle`);
    }
    return {
      time,
      open: prices[0],
      high: prices[1],
      low: prices[2],
      close: prices[3],
      volume,
    };
  });
}

export function createHistoricalDataAdapter(provider) {
  if (typeof provider?.getHistoricalCandles !== "function") {
    throw new TypeError("A historical provider with getHistoricalCandles(params) is required");
  }

  return {
    async getHistoricalCandles({ symbol, timeframe, from, to, limit }) {
      const providerSymbol = SYMBOLS[symbol];
      if (!providerSymbol) throw new RangeError(`Unsupported canonical symbol: ${symbol}`);
      if (!Object.hasOwn(TIMEFRAMES_SECONDS, timeframe)) {
        throw new RangeError(`Unsupported timeframe: ${timeframe}`);
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("limit must be a positive integer");
      }

      const rows = await provider.getHistoricalCandles({
        symbol: providerSymbol,
        timeframe,
        from,
        to,
        limit,
      });
      if (!Array.isArray(rows)) throw new TypeError("Historical provider must return an array of candles");

      const lowerBound = from === undefined || from === null ? -Infinity : parseTime(from);
      const upperBound = to === undefined || to === null ? Infinity : parseTime(to);
      if (!Number.isFinite(lowerBound) && lowerBound !== -Infinity) throw new RangeError("from is not a valid timestamp");
      if (!Number.isFinite(upperBound) && upperBound !== Infinity) throw new RangeError("to is not a valid timestamp");
      if (lowerBound > upperBound) throw new RangeError("from must not be later than to");

      const normalized = rows.map((row, index) => {
        const time = parseTime(row?.time);
        const prices = [row?.open, row?.high, row?.low, row?.close].map(Number);
        const volume = row?.volume === null || row?.volume === undefined || row?.volume === ""
          ? null
          : Number(row.volume);
        if (
          !Number.isFinite(time) ||
          prices.some((price) => !Number.isFinite(price) || price <= 0) ||
          prices[1] < Math.max(prices[0], prices[3]) ||
          prices[2] > Math.min(prices[0], prices[3]) ||
          (volume !== null && (!Number.isFinite(volume) || volume < 0))
        ) {
          throw new Error(`Historical provider returned an invalid candle at row ${index}`);
        }
        return { time, open: prices[0], high: prices[1], low: prices[2], close: prices[3], volume };
      });

      const unique = new Map();
      for (const candle of normalized) {
        if (candle.time >= lowerBound && candle.time <= upperBound && !unique.has(candle.time)) {
          unique.set(candle.time, candle);
        }
      }
      return [...unique.values()].sort((left, right) => left.time - right.time).slice(0, limit);
    },
  };
}

export function createDukascopyCsvProvider(exportDirectory) {
  return {
    async getHistoricalCandles({ symbol, timeframe }) {
      const canonicalSymbol = Object.entries(SYMBOLS).find(([, instrument]) => instrument === symbol)?.[0];
      if (!canonicalSymbol) throw new RangeError(`No Dukascopy instrument mapping for ${symbol}`);
      const filename = `${canonicalSymbol}_${timeframe}.csv`;
      const contents = await readFile(path.join(exportDirectory, filename), "utf8");
      return parseNormalizedCsv(contents);
    },
  };
}

export async function probeExports(exportDirectory) {
  const adapter = createHistoricalDataAdapter(createDukascopyCsvProvider(exportDirectory));
  const results = [];
  for (const [symbol, dukascopyInstrument] of Object.entries(SYMBOLS)) {
    for (const timeframe of Object.keys(TIMEFRAMES_SECONDS)) {
      try {
        const candles = await adapter.getHistoricalCandles({
          symbol,
          timeframe,
          limit: Number.MAX_SAFE_INTEGER,
        });
        const interval = TIMEFRAMES_SECONDS[timeframe];
        const gaps = candles.slice(1).filter((candle, index) =>
          candle.time - candles[index].time > interval
        ).length;
        results.push({
          symbol,
          timeframe,
          earliest: candles.length ? new Date(candles[0].time * 1000).toISOString() : "—",
          latest: candles.length ? new Date(candles.at(-1).time * 1000).toISOString() : "—",
          count: candles.length,
          status: candles.length ? "SAMPLE LOADED" : "EMPTY EXPORT",
          notes: `Dukascopy ${dukascopyInstrument}; gaps>${timeframe}: ${gaps}; gap cause/session continuity unknown; archive redistribution rights not established`,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        results.push({
          symbol,
          timeframe,
          earliest: "—",
          latest: "—",
          count: "—",
          status: "EXPORT MISSING",
          notes: `Dukascopy lists ${dukascopyInstrument}; no manually exported normalized CSV; bounds/count/gaps unverified`,
        });
      }
    }
  }
  return results;
}

export function formatProbeReport(results) {
  const heading = "SYMBOL | TIMEFRAME | EARLIEST | LATEST | CANDLE COUNT | STATUS | NOTES";
  const rows = results.map((item) =>
    `${item.symbol} | ${item.timeframe} | ${item.earliest} | ${item.latest} | ${item.count} | ${item.status} | ${item.notes}`
  );
  return [heading, ...rows].join("\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const exportDirectory = path.resolve(process.argv[2] || "dukascopy-exports");
  const report = await probeExports(exportDirectory);
  console.log(formatProbeReport(report));
  console.log("\nExports are read-only inputs named SYMBOL_TIMEFRAME.csv with columns time,open,high,low,close[,volume].");
}
