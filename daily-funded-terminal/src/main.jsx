import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BarChart3,
  CandlestickChart,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  Menu,
  Minus,
  PanelBottomClose,
  Plus,
  Search,
  Settings2,
  Shield,
  Star,
  X,
} from "lucide-react";
import { CandlestickSeries, ColorType, createChart } from "lightweight-charts";
import "../node_modules/flag-icons/css/flag-icons.min.css";
import "./styles.css";

const API_BASE = "";
const QUOTE_POLL_MS = 5000;
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const CATEGORY_SECTIONS = [
  { key: "FOREX", label: "Forex" },
  { key: "METALS", label: "Metals" },
  { key: "CRYPTO", label: "Crypto" },
  { key: "ENERGY", label: "Energy" },
  { key: "INDEX", label: "Indices" },
];
const SHORT_NAMES = {
  AUS200: "Australia 200",
  BTCUSD: "Bitcoin / US Dollar",
  ETHUSD: "Ethereum / US Dollar",
  EURUSD: "Euro / US Dollar",
  GER40: "Germany 40",
  GBPUSD: "Pound / US Dollar",
  UK100: "UK 100",
  UKOIL: "Brent Crude",
  US30: "Wall Street 30",
  US500: "US 500",
  USOIL: "WTI Crude",
  USDJPY: "US Dollar / Yen",
  USTEC: "US Tech 100",
  XAGUSD: "Silver / US Dollar",
  XAUUSD: "Gold / US Dollar",
  XCUUSD: "Copper / US Dollar",
  XNGUSD: "Natural Gas / US Dollar",
};
const INSTRUMENT_MARKS = {
  AUS200: { kind: "regional-index", flag: "au", label: "Australia 200" },
  BTCUSD: { kind: "bitcoin", label: "Bitcoin" },
  ETHUSD: { kind: "ethereum", label: "Ethereum" },
  EURUSD: { kind: "pair", flags: ["eu", "us"], label: "Euro and US flags" },
  GER40: { kind: "regional-index", flag: "de", label: "Germany 40" },
  GBPUSD: { kind: "pair", flags: ["gb", "us"], label: "UK and US flags" },
  UK100: { kind: "regional-index", flag: "gb", label: "UK 100" },
  UKOIL: { kind: "oil-drop", label: "Brent crude" },
  US30: { kind: "regional-index", flag: "us", label: "Wall Street 30" },
  US500: { kind: "regional-index", flag: "us", label: "US 500" },
  USOIL: { kind: "oil-drop", label: "WTI crude" },
  USDJPY: { kind: "pair", flags: ["us", "jp"], label: "US and Japan flags" },
  USTEC: { kind: "regional-index", flag: "us", label: "US Tech 100" },
  XAGUSD: { kind: "quoted-metal", flag: "us", label: "Silver / US Dollar" },
  XAUUSD: { kind: "quoted-gold", flag: "us", label: "Gold / US Dollar" },
  XCUUSD: { kind: "quoted-copper", flag: "us", label: "Copper / US Dollar" },
  XNGUSD: { kind: "gas-flame", label: "Natural gas" },
};

async function getJson(path, signal) {
  const response = await fetch(`${API_BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The market service returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Market service error (${response.status}).`);
  }
  return payload;
}

function formatPrice(value, decimals = 5) {
  if (!Number.isFinite(Number(value)) || value === null) return "--";
  const digits = Math.min(Math.max(decimals, 0), 8);
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function getPriceDigits(symbol) {
  if (symbol?.includes("JPY")) return 3;
  if (["BTCUSD", "ETHUSD", "US30", "USTEC", "US500", "GER40", "UK100", "AUS200"].includes(symbol)) return 2;
  if (["XAUUSD", "UKOIL", "USOIL"].includes(symbol)) return 2;
  return 5;
}

function priceForWatchlist(quote, digits) {
  if (!quote) return "--";
  if (quote.bid !== null && quote.ask !== null) {
    return `${formatPrice(quote.bid, digits)} / ${formatPrice(quote.ask, digits)}`;
  }
  return quote.mid === null ? "--" : formatPrice(quote.mid, digits);
}

function getMarketState(quote, error) {
  if (error) return { label: "Unavailable", tone: "unavailable" };
  if (!quote) return { label: "Waiting", tone: "waiting" };
  if (quote.stale) return { label: "Stale", tone: "stale" };
  if (quote.market_state?.toLowerCase() === "closed") return { label: "Closed", tone: "closed" };
  return { label: "Live", tone: "live" };
}

function useMarketData() {
  const [symbols, setSymbols] = useState([]);
  const [symbolState, setSymbolState] = useState("loading");
  const [symbolError, setSymbolError] = useState("");
  const [quotes, setQuotes] = useState({});
  const [quoteErrors, setQuoteErrors] = useState({});
  const [quoteRefresh, setQuoteRefresh] = useState("loading");
  const quoteFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    getJson("/market/symbols", controller.signal)
      .then((payload) => {
        const marketSymbols = Array.isArray(payload.symbols) ? payload.symbols : [];
        setSymbols(marketSymbols);
        setSymbolState(marketSymbols.length ? "ready" : "empty");
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setSymbolError(error.message);
        setSymbolState("error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!symbols.length) return undefined;
    let disposed = false;
    const refresh = async () => {
      if (disposed || document.hidden || quoteFlight.current) return;
      quoteFlight.current = true;
      setQuoteRefresh((current) => current === "loading" ? "loading" : "refreshing");
      try {
        const query = symbols.map((item) => item.symbol).join(",");
        const payload = await getJson(`/market/quotes?symbols=${encodeURIComponent(query)}`);
        if (disposed) return;
        const nextQuotes = {};
        const nextErrors = {};
        for (const quote of payload.quotes || []) nextQuotes[quote.symbol] = quote;
        for (const item of payload.errors || []) nextErrors[item.symbol] = item;
        setQuotes(nextQuotes);
        setQuoteErrors(nextErrors);
        setQuoteRefresh("ready");
      } catch (error) {
        if (disposed) return;
        setQuoteErrors(Object.fromEntries(symbols.map(({ symbol }) => [symbol, {
          symbol,
          code: "request_failed",
          message: error.message,
        }])));
        setQuoteRefresh("error");
      } finally {
        quoteFlight.current = false;
      }
    };

    refresh();
    const timer = window.setInterval(refresh, QUOTE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [symbols]);

  return { symbols, symbolState, symbolError, quotes, quoteErrors, quoteRefresh };
}

function useCandles(symbol, interval) {
  const [candles, setCandles] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");

  useEffect(() => {
    if (!symbol) {
      setCandles([]);
      setState("empty");
      return undefined;
    }
    const controller = new AbortController();
    setState("loading");
    setError("");
    getJson(`/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=100`, controller.signal)
      .then((payload) => {
        const rows = Array.isArray(payload.bars) ? payload.bars : [];
        const normalized = rows.map((bar) => ({
          time: Math.floor(new Date(bar.open_time).getTime() / 1000),
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
        })).filter((bar) =>
          Number.isFinite(bar.time) &&
          [bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0)
        ).sort((left, right) => left.time - right.time);
        const unique = normalized.filter((bar, index) => index === 0 || bar.time !== normalized[index - 1].time);
        setCandles(unique);
        setSource(payload.source || "");
        setState(unique.length ? "ready" : "empty");
      })
      .catch((requestError) => {
        if (requestError.name === "AbortError") return;
        setCandles([]);
        setError(requestError.message);
        setState("error");
      });
    return () => controller.abort();
  }, [symbol, interval]);

  return { candles, state, error, source };
}

function BrandMark() {
  return (
    <div className="brand-lockup" aria-label="Daily Funded">
      <span className="brand-mark"><span /></span>
      <span className="brand-name">daily<span>funded</span></span>
    </div>
  );
}

function InstrumentMark({ symbol }) {
  const mark = INSTRUMENT_MARKS[symbol] || { kind: "default", glyph: symbol?.slice(0, 2) || "--", label: symbol || "Unknown instrument" };
  return (
    <span className={`instrument-mark instrument-mark-${mark.kind} instrument-mark-${symbol?.toLowerCase() || "default"}`} role="img" aria-label={mark.label}>
      {mark.kind === "pair" && mark.flags.map((flag, index) => <span key={flag} className={`fi fi-${flag} pair-flag pair-flag-${index + 1}`} aria-hidden="true" />)}
      {mark.kind === "regional-index" && <><span className={`fi fi-${mark.flag} regional-flag`} aria-hidden="true" /><span className="index-mark" aria-hidden="true">▥</span></>}
      {mark.kind === "energy" && <><span className={`fi fi-${mark.flag} energy-flag`} aria-hidden="true" /><span className="energy-glyph" aria-hidden="true">{mark.glyph}</span></>}
      {mark.kind === "bitcoin" && <span className="bitcoin-glyph" aria-hidden="true">₿</span>}
      {mark.kind === "ethereum" && <svg className="ethereum-glyph" viewBox="0 0 32 40" aria-hidden="true"><path d="M16 1 2 21l14 8 14-8L16 1Z" /><path d="m2 24 14 15 14-15-14 8-14-8Z" /></svg>}
      {mark.kind === "oil-drop" && <svg className="oil-glyph" viewBox="0 0 32 40" aria-hidden="true"><path d="M16 1C13 8 4 17 4 25a12 12 0 0 0 24 0C28 17 19 8 16 1Z" /><path className="oil-highlight" d="M10 25c0-3 2-6 4-9" /></svg>}
      {mark.kind === "gas-flame" && <svg className="gas-glyph" viewBox="0 0 32 40" aria-hidden="true"><path d="M18 1c2 8-3 9-2 15 2-2 4-4 5-7 7 7 10 13 8 20a13 13 0 0 1-26-2C2 18 12 13 18 1Z" /><path className="gas-core" d="M17 20c1 4-2 5-2 8 0 2 1 4 3 4s4-2 4-5c0-2-2-5-5-7Z" /></svg>}
      {mark.kind === "quoted-metal" && <><span className={`fi fi-${mark.flag} quote-flag`} aria-hidden="true" /><svg className="silver-bars" viewBox="0 0 36 28" aria-hidden="true"><path d="m3 9 8-5 9 5-8 5-9-5Z" /><path d="m14 9 8-5 9 5-8 5-9-5Z" /><path d="m2 17 9-5 9 5-9 5-9-5Z" /><path d="m14 17 9-5 9 5-9 5-9-5Z" /></svg></>}
      {mark.kind === "quoted-gold" && <><span className={`fi fi-${mark.flag} quote-flag`} aria-hidden="true" /><svg className="gold-bars" viewBox="0 0 36 28" aria-hidden="true"><path d="m4 8 9-5 10 4-8 6-11-5Z" /><path d="m17 12 8-5 8 4-8 5-8-4Z" /><path d="m2 17 9-5 11 5-10 6-10-6Z" /></svg></>}
      {mark.kind === "quoted-copper" && <><span className={`fi fi-${mark.flag} quote-flag`} aria-hidden="true" /><svg className="copper-bars" viewBox="0 0 36 28" aria-hidden="true"><path d="m4 8 9-5 10 4-8 6-11-5Z" /><path d="m17 12 8-5 8 4-8 5-8-4Z" /><path d="m2 17 9-5 11 5-10 6-10-6Z" /></svg></>}
      {(mark.kind === "metal" || mark.kind === "default") && <span className="mark-glyph" aria-hidden="true">{mark.glyph}</span>}
    </span>
  );
}

function QuoteChip({ label, value, tone = "neutral" }) {
  return (
    <div className={`quote-chip quote-chip-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TopBar({ symbol, selected, quote, quoteError, watchOpen, onToggleWatch, onToggleOrder }) {
  const digits = getPriceDigits(symbol);
  const spread = quote?.bid != null && quote?.ask != null
    ? Number(quote.ask) - Number(quote.bid)
    : null;
  const marketState = getMarketState(quote, quoteError);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button mobile-only" type="button" aria-label={watchOpen ? "Close watchlist" : "Open watchlist"} onClick={onToggleWatch}>
          {watchOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <BrandMark />
        <button className="account-select" type="button" title="Account connection will be available in a later stage">
          <span className="account-avatar">DF</span>
          <span className="account-select-copy"><small>TRADING ACCOUNT</small><strong>Select account</strong></span>
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="topbar-market">
        <div className="market-selected">
          <InstrumentMark symbol={symbol} />
          <div><strong>{symbol || "Select market"}</strong><small>{selected ? (SHORT_NAMES[symbol] || selected.display_name || symbol) : "Market data"}</small></div>
          <span className={`state-dot state-${marketState.tone}`} title={marketState.label} />
        </div>
        <QuoteChip label="BID" value={quote?.bid == null ? "--" : formatPrice(quote.bid, digits)} tone="sell" />
        <QuoteChip label="ASK" value={quote?.ask == null ? (quote?.mid == null ? "--" : formatPrice(quote.mid, digits)) : formatPrice(quote.ask, digits)} tone="buy" />
        <QuoteChip label="SPREAD" value={spread == null ? "--" : formatPrice(spread, digits)} />
      </div>

      <div className="topbar-right">
        <div className="account-metric"><span>Balance</span><strong>--</strong></div>
        <div className="account-metric"><span>Equity</span><strong>--</strong></div>
        <span className="topbar-divider" />
        <button className="icon-button settings-button" type="button" title="Terminal settings" aria-label="Terminal settings"><Settings2 size={18} /></button>
        <button className="mobile-order-trigger" type="button" onClick={onToggleOrder}>Order</button>
      </div>
    </header>
  );
}

function InstrumentRow({ item, quote, error, selected, favorite, onSelect, onFavorite }) {
  const marketState = getMarketState(quote, error);
  const digits = getPriceDigits(item.symbol);
  const quoteText = priceForWatchlist(quote, digits);

  return (
    <div className={`instrument-row ${selected ? "instrument-row-selected" : ""}`}>
      <button className="instrument-main" type="button" onClick={() => onSelect(item.symbol)} aria-pressed={selected}>
        <InstrumentMark symbol={item.symbol} />
        <span className="instrument-name"><strong>{item.symbol}</strong><small>{SHORT_NAMES[item.symbol] || item.display_name || item.symbol}</small></span>
        <span className="instrument-quote"><strong>{quoteText}</strong><small className={`market-state state-text-${marketState.tone}`}>{marketState.label}</small></span>
      </button>
      <button className={`favorite-button ${favorite ? "is-favorite" : ""}`} type="button" aria-label={favorite ? `Remove ${item.symbol} from favorites` : `Add ${item.symbol} to favorites`} aria-pressed={favorite} onClick={() => onFavorite(item.symbol)}>
        <Star size={14} fill={favorite ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

function Watchlist({
  symbols,
  quotes,
  quoteErrors,
  selectedSymbol,
  favorites,
  onSelect,
  onFavorite,
  loading,
  error,
  collapsed,
  onToggleCollapse,
  open,
  onClose,
}) {
  const [search, setSearch] = useState("");
  const searchValue = search.trim().toLowerCase();
  const visible = symbols.filter((item) => {
    const name = SHORT_NAMES[item.symbol] || item.display_name || "";
    return !searchValue || `${item.symbol} ${name}`.toLowerCase().includes(searchValue);
  });
  const favoriteRows = visible.filter((item) => favorites.includes(item.symbol));

  return (
    <>
      <button className={`drawer-scrim ${open ? "scrim-visible" : ""}`} type="button" aria-label="Close watchlist" onClick={onClose} />
      <aside className={`watchlist-panel ${open ? "watchlist-open" : ""} ${collapsed ? "watchlist-collapsed" : ""}`}>
        <div className="panel-heading watchlist-heading">
          {!collapsed && <div><span className="eyebrow">MARKETS</span><h2>Watchlist <span className="count-pill">{symbols.length}</span></h2></div>}
          <button className="icon-button mobile-only" type="button" aria-label="Close watchlist" onClick={onClose}><X size={18} /></button>
          <button className="collapse-button desktop-only" type="button" title={collapsed ? "Expand watchlist" : "Collapse watchlist"} aria-label={collapsed ? "Expand watchlist" : "Collapse watchlist"} onClick={onToggleCollapse}>{collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button>
        </div>
        <label className="search-field">
          <Search size={15} />
          <input type="search" placeholder="Search markets" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search markets" />
          <kbd>/</kbd>
        </label>
        <div className="watchlist-columns"><span>INSTRUMENT</span><span>BID / ASK · STATE</span></div>
        <div className="watchlist-scroll">
          {loading && <div className="watchlist-message"><span className="loader-dot" />Loading markets…</div>}
          {error && <div className="watchlist-error"><strong>Markets unavailable</strong><span>{error}</span></div>}
          {!loading && !error && symbols.length === 0 && <div className="watchlist-message">No market data symbols returned.</div>}
          {!loading && !error && (
            <>
              {favoriteRows.length > 0 && (
                <WatchlistSection label="Favorites" items={favoriteRows} quotes={quotes} errors={quoteErrors} selectedSymbol={selectedSymbol} favorites={favorites} onSelect={onSelect} onFavorite={onFavorite} />
              )}
              {CATEGORY_SECTIONS.map(({ key, label }) => {
                const items = visible.filter((item) => item.category?.toUpperCase() === key && !favorites.includes(item.symbol));
                if (!items.length) return null;
                return <WatchlistSection key={key} label={label} items={items} quotes={quotes} errors={quoteErrors} selectedSymbol={selectedSymbol} favorites={favorites} onSelect={onSelect} onFavorite={onFavorite} />;
              })}
              {visible.length === 0 && <div className="watchlist-message">No markets match “{search}”.</div>}
            </>
          )}
        </div>
        <div className="watchlist-foot"><span className="live-led" />Prices from Daily Funded market data</div>
      </aside>
    </>
  );
}

function WatchlistSection({ label, items, quotes, errors, selectedSymbol, favorites, onSelect, onFavorite }) {
  return (
    <section className="watchlist-section">
      <div className="section-label"><span>{label}</span><span>{items.length}</span></div>
      {items.map((item) => <InstrumentRow key={item.symbol} item={item} quote={quotes[item.symbol]} error={errors[item.symbol]} selected={selectedSymbol === item.symbol} favorite={favorites.includes(item.symbol)} onSelect={onSelect} onFavorite={onFavorite} />)}
    </section>
  );
}

function ChartView({ symbol, selected, quote, candles, state, error, source, interval, onIntervalChange, onOpenWatchlist }) {
  const chartHost = useRef(null);
  const chartRef = useRef(null);
  const candleSeries = useRef(null);
  const digits = getPriceDigits(symbol);

  useEffect(() => {
    if (!chartHost.current) return undefined;
    const chart = createChart(chartHost.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#15191a" },
        textColor: "#828c8c",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#252b2c" },
        horzLines: { color: "#252b2c" },
      },
      rightPriceScale: { borderColor: "#303737", minimumWidth: 72, autoScale: true },
      timeScale: { borderColor: "#303737", timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 9 },
      crosshair: { vertLine: { color: "#758280", labelBackgroundColor: "#2e3735" }, horzLine: { color: "#758280", labelBackgroundColor: "#2e3735" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: { priceFormatter: (price) => formatPrice(price, digits) },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#72d6ae",
      downColor: "#ee7c72",
      borderUpColor: "#72d6ae",
      borderDownColor: "#ee7c72",
      wickUpColor: "#72d6ae",
      wickDownColor: "#ee7c72",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    candleSeries.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeries.current = null;
    };
  }, []);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    series.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    if (!candles.length) {
      series.setData([]);
      return;
    }
    series.setData(candles);
    chartRef.current?.timeScale().fitContent();
  }, [candles, digits]);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    series.applyOptions({ priceLineVisible: quote?.mid != null });
    if (quote?.mid != null && Number.isFinite(Number(quote.mid))) {
      const line = series.createPriceLine({
        price: Number(quote.mid),
        color: quote.stale ? "#a5a88f" : "#c7eb77",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "MID",
      });
      return () => series.removePriceLine(line);
    }
    return undefined;
  }, [quote?.mid, quote?.stale]);

  const marketState = getMarketState(quote, null);
  const highLow = candles.length ? candles.reduce((range, candle) => ({
    high: Math.max(range.high, candle.high),
    low: Math.min(range.low, candle.low),
  }), { high: -Infinity, low: Infinity }) : null;

  return (
    <section className="chart-panel">
      <div className="chart-header">
        <div className="chart-market-title">
          <button className="icon-button mobile-only" type="button" onClick={onOpenWatchlist} aria-label="Open watchlist"><Menu size={18} /></button>
          <InstrumentMark symbol={symbol} />
          <div className="chart-title-copy"><div><h1>{symbol || "Select a market"}</h1><span className={`market-state state-text-${marketState.tone}`}>{marketState.label}</span></div><p>{SHORT_NAMES[symbol] || selected?.display_name || "Live market"}</p></div>
          <span className="chart-symbol-divider" />
          <div className="chart-ohlc"><span>HIGH <strong>{highLow ? formatPrice(highLow.high, digits) : "--"}</strong></span><span>LOW <strong>{highLow ? formatPrice(highLow.low, digits) : "--"}</strong></span></div>
        </div>
        <div className="chart-header-actions">
          <div className="interval-control" role="group" aria-label="Chart timeframe">
            {INTERVALS.map((value) => <button key={value} type="button" className={interval === value ? "interval-active" : ""} aria-pressed={interval === value} onClick={() => onIntervalChange(value)}>{value}</button>)}
          </div>
          <button className="icon-button chart-tool" type="button" title="Chart style" aria-label="Chart style"><CandlestickChart size={17} /></button>
        </div>
      </div>
      <div className="chart-quote-strip">
        <QuoteChip label="BID" value={quote?.bid == null ? "--" : formatPrice(quote.bid, digits)} tone="sell" />
        <QuoteChip label="ASK" value={quote?.ask == null ? (quote?.mid == null ? "--" : formatPrice(quote.mid, digits)) : formatPrice(quote.ask, digits)} tone="buy" />
        <QuoteChip label="MID" value={quote?.mid == null ? "--" : formatPrice(quote.mid, digits)} />
        {quote?.stale && <span className="stale-flag">STALE QUOTE</span>}
        {source && <span className="source-label">{source === "provider_historical" ? "PROVIDER HISTORY" : "WORKER GENERATED"}</span>}
      </div>
      <div className="chart-canvas-wrap">
        <div className="chart-canvas" ref={chartHost} aria-label={`${symbol} candlestick chart`} />
        {state !== "ready" && <div className="chart-overlay">
          {state === "loading" && <><span className="chart-loader" /><strong>Loading {symbol} candles</strong><span>Requesting {interval} market history</span></>}
          {state === "empty" && <><span className="empty-chart-icon"><BarChart3 size={22} /></span><strong>History unavailable</strong><span>No {interval} candles were returned for {symbol}.</span></>}
          {state === "error" && <><span className="empty-chart-icon error-icon"><Activity size={22} /></span><strong>Chart data unavailable</strong><span>{error || "The market service could not return candles."}</span></>}
        </div>}
        {state === "ready" && <div className="chart-legend"><span className="legend-dot legend-up" />Up <span className="legend-dot legend-down" />Down <span className="legend-divider" />{candles.length} bars</div>}
      </div>
      <div className="chart-footer"><span><Activity size={13} /> Market data only</span><span><CircleHelp size={13} /> Drag to pan · scroll to zoom</span></div>
    </section>
  );
}

function Stepper({ value, onChange, label }) {
  return (
    <div className="stepper" aria-label={label}>
      <button type="button" aria-label="Decrease volume" onClick={() => onChange((current) => Math.max(0.01, Number((current - 0.01).toFixed(2))))}><Minus size={13} /></button>
      <input aria-label="Volume in lots" type="number" min="0.01" step="0.01" value={value.toFixed(2)} onChange={(event) => onChange(Math.max(0.01, Number(event.target.value) || 0.01))} />
      <button type="button" aria-label="Increase volume" onClick={() => onChange((current) => Number((current + 0.01).toFixed(2)))}><Plus size={13} /></button>
    </div>
  );
}

function OrderPanel({ symbol, quote, orderOpen, onClose }) {
  const [side, setSide] = useState("BUY");
  const [orderType, setOrderType] = useState("Market Order");
  const [volume, setVolume] = useState(0.1);
  const [oneClick, setOneClick] = useState(false);
  const [notice, setNotice] = useState(false);
  const digits = getPriceDigits(symbol);

  function blockedAction() {
    setNotice(true);
    window.setTimeout(() => setNotice(false), 3200);
  }

  return (
    <>
      <button className={`drawer-scrim order-scrim ${orderOpen ? "scrim-visible" : ""}`} type="button" aria-label="Close order panel" onClick={onClose} />
      <aside className={`order-panel ${orderOpen ? "order-open" : ""}`}>
        <div className="panel-heading order-heading">
          <div><span className="eyebrow">STAGE 1 · MARKET DATA</span><h2>New order <span className="stage-chip">PREVIEW</span></h2></div>
          <button className="icon-button mobile-only" type="button" aria-label="Close order panel" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="order-symbol-select">
          <InstrumentMark symbol={symbol} />
          <div><strong>{symbol || "No market selected"}</strong><small>{SHORT_NAMES[symbol] || "Select from watchlist"}</small></div>
          <span className="market-state state-text-live">{quote?.stale ? "Stale" : quote ? "Live quote" : "Awaiting quote"}</span>
        </div>
        <div className="side-switch" role="tablist" aria-label="Order side">
          <button type="button" role="tab" aria-selected={side === "BUY"} className={side === "BUY" ? "side-buy-active" : ""} onClick={() => setSide("BUY")}><span className="side-arrow">↗</span> Buy</button>
          <button type="button" role="tab" aria-selected={side === "SELL"} className={side === "SELL" ? "side-sell-active" : ""} onClick={() => setSide("SELL")}><span className="side-arrow">↘</span> Sell</button>
        </div>
        <label className="field-label">Order type</label>
        <div className="select-wrap">
          <select value={orderType} onChange={(event) => setOrderType(event.target.value)} aria-label="Order type">
            <option>Market Order</option>
            <option>Limit Order</option>
          </select><ChevronDown size={15} />
        </div>
        <label className="field-label volume-label">Volume <span>Lots</span></label>
        <Stepper value={volume} onChange={setVolume} label="Order volume" />
        {orderType === "Limit Order" && <PriceField label="Entry price" placeholder={quote?.mid == null ? "Unavailable" : formatPrice(quote.mid, digits)} />}
        <div className="optional-fields-heading"><span>Risk controls</span><span>Optional</span></div>
        <PriceField label="Take Profit" placeholder="Price level" />
        <PriceField label="Stop Loss" placeholder="Price level" />
        <button className={`one-click-row ${oneClick ? "one-click-enabled" : ""}`} type="button" role="switch" aria-checked={oneClick} onClick={() => setOneClick((current) => !current)}>
          <span><strong>One-Click Trading</strong><small>Visual preference only · no orders sent</small></span><span className="switch-track"><span /></span>
        </button>
        <div className="order-preview">
          <div><span>Estimated price</span><strong>{quote?.mid == null ? "Unavailable" : formatPrice(quote.mid, digits)}</strong></div>
          <div><span>Volume</span><strong>{volume.toFixed(2)} lots</strong></div>
        </div>
        <div className="order-actions">
          <button className={`submit-order submit-${side.toLowerCase()}`} type="button" onClick={blockedAction}><span>{side === "BUY" ? "Buy" : "Sell"} {symbol || "market"}</span><strong>{quote?.mid == null ? "--" : formatPrice(quote.mid, digits)}</strong></button>
          <span className="execution-note"><Shield size={13} /> Stage 1 preview. No trading requests are sent.</span>
        </div>
        {notice && <div className="order-notice" role="status">Order execution is not enabled in Stage 1.</div>}
      </aside>
    </>
  );
}

function PriceField({ label, placeholder }) {
  return (
    <label className="price-field"><span>{label}</span><input type="number" min="0" step="any" placeholder={placeholder} /></label>
  );
}

function TradingPanel({ open, onToggle }) {
  const [tab, setTab] = useState("Positions");
  return (
    <section className={`trading-panel ${open ? "trading-panel-open" : "trading-panel-closed"}`}>
      <div className="trading-panel-header">
        <div className="trading-tabs" role="tablist" aria-label="Trading activity">
          {["Positions", "Orders", "History"].map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "trading-tab-active" : ""} onClick={() => setTab(value)}>{value}<span className="tab-count">—</span></button>)}
        </div>
        <button className="collapse-button" type="button" onClick={onToggle} aria-label={open ? "Collapse activity panel" : "Expand activity panel"} title={open ? "Collapse panel" : "Expand panel"}>{open ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button>
      </div>
      {open && <div className="trading-content">
        <div className="table-header"><span>INSTRUMENT</span><span>SIDE</span><span>VOLUME</span><span>OPEN PRICE</span><span>CURRENT PRICE</span><span>FLOATING P/L</span><span>OPENED</span></div>
        <div className="trading-empty"><span className="empty-table-icon"><PanelBottomClose size={18} /></span><strong>{tab === "Positions" ? "No open positions" : `No ${tab.toLowerCase()} to display`}</strong><span>Account activity will appear here when an account is connected.</span></div>
      </div>}
    </section>
  );
}

function StatusBar({ quoteRefresh, quote, source }) {
  const state = getMarketState(quote, null);
  const statusLabel = quoteRefresh === "error" ? "Quote feed unavailable" : quoteRefresh === "loading" ? "Connecting to market data" : quoteRefresh === "refreshing" ? "Refreshing quotes" : state.label === "Stale" ? "Last quote is stale" : "Market data connected";
  return (
    <footer className="statusbar">
      <span className={`connection-indicator ${quoteRefresh === "error" ? "connection-error" : ""}`}><span />{statusLabel}</span>
      <span>{source === "provider_historical" ? "Provider candle history" : "Market prices via Daily Funded Worker"}</span>
      <span className="statusbar-right"><Clock3 size={12} /> Quotes refresh every 5 sec</span>
    </footer>
  );
}

function App() {
  const { symbols, symbolState, symbolError, quotes, quoteErrors, quoteRefresh } = useMarketData();
  const [selectedSymbol, setSelectedSymbol] = useState("XAUUSD");
  const [interval, setInterval] = useState("1m");
  const [watchCollapsed, setWatchCollapsed] = useState(false);
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("df-terminal-favorites") || "[\"XAUUSD\"]");
    } catch {
      return ["XAUUSD"];
    }
  });
  const [watchOpen, setWatchOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const selected = symbols.find((item) => item.symbol === selectedSymbol) || null;
  const quote = quotes[selectedSymbol] || null;
  const quoteError = quoteErrors[selectedSymbol] || null;
  const { candles, state: candleState, error: candleError, source } = useCandles(selected ? selectedSymbol : "", interval);

  useEffect(() => {
    if (symbolState !== "ready" || symbols.some((item) => item.symbol === selectedSymbol)) return;
    setSelectedSymbol(symbols.find((item) => item.symbol === "XAUUSD")?.symbol || symbols[0]?.symbol || "");
  }, [symbolState, symbols, selectedSymbol]);

  function toggleFavorite(symbol) {
    setFavorites((current) => {
      const next = current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol];
      try {
        localStorage.setItem("df-terminal-favorites", JSON.stringify(next));
      } catch {
        // Favorites remain usable for this session when storage is unavailable.
      }
      return next;
    });
  }

  function selectSymbol(symbol) {
    setSelectedSymbol(symbol);
    setWatchOpen(false);
  }

  return (
    <div className="terminal-shell">
      <TopBar symbol={selectedSymbol} selected={selected} quote={quote} quoteError={quoteError} watchOpen={watchOpen} onToggleWatch={() => setWatchOpen((current) => !current)} onToggleOrder={() => setOrderOpen(true)} />
      <div className={`terminal-workspace ${watchCollapsed ? "workspace-watchlist-collapsed" : ""}`}>
        <Watchlist symbols={symbols} quotes={quotes} quoteErrors={quoteErrors} selectedSymbol={selectedSymbol} favorites={favorites} onSelect={selectSymbol} onFavorite={toggleFavorite} loading={symbolState === "loading"} error={symbolState === "error" ? symbolError : ""} collapsed={watchCollapsed} onToggleCollapse={() => setWatchCollapsed((current) => !current)} open={watchOpen} onClose={() => setWatchOpen(false)} />
        <main className="terminal-main">
          <ChartView symbol={selectedSymbol} selected={selected} quote={quote} candles={candles} state={selected ? candleState : symbolState === "loading" ? "loading" : "empty"} error={candleError || symbolError} source={source} interval={interval} onIntervalChange={setInterval} onOpenWatchlist={() => setWatchOpen(true)} />
          <TradingPanel open={activityOpen} onToggle={() => setActivityOpen((current) => !current)} />
        </main>
        <OrderPanel symbol={selectedSymbol} quote={quote} orderOpen={orderOpen} onClose={() => setOrderOpen(false)} />
      </div>
      <StatusBar quoteRefresh={quoteRefresh} quote={quote} source={source} />
      <nav className="mobile-bottom-nav" aria-label="Terminal panels">
        <button type="button" onClick={() => setWatchOpen(true)}><Menu size={17} /><span>Markets</span></button>
        <button type="button" onClick={() => setActivityOpen((current) => !current)}><BarChart3 size={17} /><span>Activity</span></button>
        <button type="button" onClick={() => setOrderOpen(true)}><Activity size={17} /><span>Order</span></button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);