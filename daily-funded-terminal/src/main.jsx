import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as signalR from "@microsoft/signalr";
import {
  Activity,
  BarChart3,
  Clock3,
  CandlestickChart,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
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
import { CandlestickSeries, ColorType, createChart, TickMarkType } from "lightweight-charts";
import {
  createCandleHistoryPager,
  candleFromLiveTick,
  fitInitialHistoryOnce,
  mergeHistoryWithLive,
  setSeriesDataPreservingVisibleRange,
  shouldLoadOlderHistory,
} from "./candleHistory.js";
import "../node_modules/flag-icons/css/flag-icons.min.css";
import "./styles.css";

const API_BASE = import.meta.env.DEV ? "" : "https://throbbing-bonus-6fed.dailyfunded.workers.dev";
const QUOTE_FALLBACK_MS = 5000;
const LIVE_TICK_MAX_AGE_MS = 5 * 60 * 1000;
const TRADING_API_BASE = import.meta.env.DEV ? "/api" : "https://daily-funded-api.onrender.com/api";
const TRADING_POLL_MS = 5000;
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyArsv-HojE9hn_3BAcJVFh5zp4XS9Dw480",
  authDomain: "daily-funded.firebaseapp.com",
  projectId: "daily-funded",
  storageBucket: "daily-funded.firebasestorage.app",
  messagingSenderId: "1080360028653",
  appId: "1:1080360028653:web:9afa42197ba011c1613fe4",
  measurementId: "G-Y7SP58FQ6H",
};
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const INTERVAL_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const EXCHANGE_TIME_ZONES = {
  AUS200: "Australia/Sydney",
  GER40: "Europe/Berlin",
  UK100: "Europe/London",
  US30: "America/New_York",
  US500: "America/New_York",
  USTEC: "America/New_York",
};
const FALLBACK_TIME_ZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Phoenix",
  "America/Vancouver", "America/Denver", "America/Mexico_City", "America/Chicago",
  "America/Bogota", "America/Lima", "America/New_York", "America/Toronto",
  "America/Sao_Paulo", "Atlantic/Reykjavik", "Europe/London", "Europe/Paris",
  "Europe/Berlin", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Bangkok", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland",
];
const SUPPORTED_TIME_ZONES = typeof Intl.supportedValuesOf === "function"
  ? Intl.supportedValuesOf("timeZone")
  : FALLBACK_TIME_ZONES;

function isValidTimeZone(timeZone) {
  if (timeZone === "UTC" || timeZone === "Exchange") return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function getInitialChartTimeZone() {
  try {
    const savedTimeZone = localStorage.getItem("df-terminal-chart-timezone");
    if (savedTimeZone && isValidTimeZone(savedTimeZone)) return savedTimeZone;
  } catch (error) {
    console.warn("Unable to load the saved chart time zone.", error);
  }
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return browserTimeZone && isValidTimeZone(browserTimeZone) ? browserTimeZone : "UTC";
}

function getExchangeTimeZone(symbol) {
  return EXCHANGE_TIME_ZONES[symbol?.toUpperCase()] || "UTC";
}

function getResolvedTimeZone(timeZone, symbol) {
  return timeZone === "Exchange" ? getExchangeTimeZone(symbol) : timeZone;
}

function formatTimeZoneOffset(timeZone, date) {
  const zoneName = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (!zoneName || zoneName === "GMT" || zoneName === "UTC") return "UTC";
  const match = zoneName.match(/^GMT([+-])(\d{2})(?::(\d{2}))?$/);
  if (!match) return zoneName.replace(/^GMT/, "UTC");
  const [, sign, rawHours, minutes = "00"] = match;
  const hours = Number(rawHours);
  return minutes === "00" ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${minutes}`;
}

function timeToDate(time) {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") return new Date(time);
  if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day));
  }
  return null;
}

function formatChartTime(time, timeZone, tickMarkType) {
  const date = timeToDate(time);
  if (!date || Number.isNaN(date.getTime())) return null;
  const options = tickMarkType === TickMarkType.Year
    ? { year: "numeric" }
    : tickMarkType === TickMarkType.Month
      ? { month: "short" }
      : tickMarkType === TickMarkType.DayOfMonth
        ? { day: "2-digit" }
        : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(date);
}

function formatChartCrosshairTime(time, timeZone) {
  const date = timeToDate(time);
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatChartRangeTimestamp(timestampMs, timeZone) {
  if (!Number.isFinite(timestampMs)) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(timestampMs));
}

function formatChartClock(date, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function ChartTimezonePicker({ timeZone, exchangeTimeZone, now, onSelect }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const pickerRef = useRef(null);
  const selectedZone = timeZone === "Exchange" ? exchangeTimeZone : timeZone;
  const displayedZone = timeZone === "Exchange" ? exchangeTimeZone : timeZone;
  const searchValue = search.trim().toLowerCase();
  const zoneOptions = useMemo(() => {
    if (!open) return [];
    const date = new Date(now);
    return SUPPORTED_TIME_ZONES.map((zone) => ({
      zone,
      city: zone.split("/").pop().replace(/_/g, " "),
      offset: formatTimeZoneOffset(zone, date),
      offsetMinutes: getTimeZoneOffsetMinutes(zone, date),
    })).sort((a, b) =>
      a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city)
    );
  }, [open, Math.floor(now / 60000)]);
  const visibleZones = zoneOptions.filter(({ zone, city, offset }) =>
    !searchValue || `${zone} ${city} ${offset}`.toLowerCase().includes(searchValue)
  );
  const clockText = `${formatChartClock(new Date(now), selectedZone)} ${formatTimeZoneOffset(selectedZone, new Date(now))}`;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function chooseTimeZone(value) {
    onSelect(value);
    setSearch("");
    setOpen(false);
  }

  return (
    <div className="chart-timezone-picker" ref={pickerRef}>
      <button
        className="chart-timezone-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Chart time ${clockText}. Time zone: ${timeZone === "Exchange" ? `Exchange (${displayedZone})` : timeZone}. Change time zone`}
        title={`${timeZone === "Exchange" ? `Exchange (${displayedZone})` : timeZone} · click to change`}
        onClick={() => setOpen((current) => !current)}
      >
        <Clock3 size={13} />
        <span>{clockText}</span>
        <ChevronDown size={12} />
      </button>
      {open && <div className="chart-timezone-menu">
        <label className="chart-timezone-search">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search time zones"
            aria-label="Search time zones"
          />
        </label>
        <div className="chart-timezone-options" role="listbox" aria-label="Chart time zone">
          {[
            ["UTC", "UTC"],
            ["Exchange", `Exchange · ${exchangeTimeZone}`],
          ].filter(([value, label]) =>
            !searchValue || `${value} ${label}`.toLowerCase().includes(searchValue)
          ).map(([value, label]) => (
            <button
              key={value}
              className={`chart-timezone-option ${timeZone === value ? "chart-timezone-option-selected" : ""}`}
              type="button"
              role="option"
              aria-selected={timeZone === value}
              onClick={() => chooseTimeZone(value)}
            >{label}</button>
          ))}
          <div className="chart-timezone-divider" />
          {visibleZones.map(({ zone, city, offset }) => (
            <button
              key={zone}
              className={`chart-timezone-option ${timeZone === zone ? "chart-timezone-option-selected" : ""}`}
              type="button"
              role="option"
              aria-selected={timeZone === zone}
              title={zone}
              onClick={() => chooseTimeZone(zone)}
            >({offset}) {city}</button>
          ))}
          {visibleZones.length === 0 && <div className="chart-timezone-empty">No matching time zones</div>}
        </div>
      </div>}
    </div>
  );
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = Number(part.value);
    return result;
  }, {});
  const roundedDate = Math.floor(date.getTime() / 1000) * 1000;
  const zoneDate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (zoneDate - roundedDate) / 60000;
}
const TRADING_ERROR_MESSAGES = {
  authentication_required: "Sign in with your Daily Funded account to use trading.",
  trading_disabled: "Trading is disabled until this account is approved and active.",
  trading_account_not_found: "This trading account is unavailable.",
  trading_account_unavailable: "This trading account is unavailable.",
  account_lookup_failed: "Account service is unavailable. Try again shortly.",
  market_unavailable: "Current market data is unavailable. No order was placed.",
  stale_quote: "The quote is stale or the market is closed. No order was placed.",
  invalid_volume: "The order volume is invalid for this symbol or account.",
  invalid_tp: "Take profit must be on the profitable side of the current executable price.",
  invalid_sl: "Stop loss must be on the protective side of the current executable price.",
  insufficient_margin: "There is not enough available margin for this order.",
  rule_violation: "The order violates this account's trading rules.",
  position_not_found: "Position not found or not available to this user.",
  unauthorized_action: "This action is not authorized.",
  invalid_order_type: "Only market orders are currently supported.",
  worker_timeout: "Trading service timed out. Try again shortly.",
  worker_network_error: "Trading service is unavailable. Try again shortly.",
  worker_http_error: "Trading service could not process the request.",
  worker_rejected: "Trading service rejected the request.",
  worker_response_invalid: "Trading service returned an invalid response.",
  server_response_invalid: "Trading service returned an invalid position.",
  server_error: "Trading service is unavailable. Try again shortly.",
};
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

let terminalFirebaseAuth;

function getTerminalFirebaseAuth() {
  if (terminalFirebaseAuth) return terminalFirebaseAuth;
  const firebase = window.firebase;
  if (!firebase) throw new Error(TRADING_ERROR_MESSAGES.authentication_required);
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  terminalFirebaseAuth = firebase.auth();
  return terminalFirebaseAuth;
}

class TradingRequestError extends Error {
  constructor(code, status) {
    super(TRADING_ERROR_MESSAGES[code] || TRADING_ERROR_MESSAGES.server_error);
    this.code = code;
    this.status = status;
  }
}

async function getTradingJson(path, user, options = {}) {
  if (!user) throw new TradingRequestError("authentication_required", 401);
  let token;
  try {
    token = await user.getIdToken();
  } catch {
    throw new TradingRequestError("authentication_required", 401);
  }
  let response;
  try {
    response = await fetch(`${TRADING_API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
  } catch {
    throw new TradingRequestError("server_error", 0);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TradingRequestError("server_error", response.status);
  }
  if (!response.ok) {
    const code = payload.code ||
      (response.status === 401 ? "authentication_required" :
        response.status === 403 ? "unauthorized_action" :
          response.status === 404 ? "position_not_found" :
            response.status === 409 ? "trading_disabled" : "server_error");
    throw new TradingRequestError(code, response.status);
  }
  return payload;
}

function useTradingSession() {
  const [authStatus, setAuthStatus] = useState("loading");
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [rules, setRules] = useState(null);
  const [positions, setPositions] = useState([]);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const confirmedPositionVersion = useRef(0);
  const confirmedPositions = useRef(new Map());
  const livePositionMarks = useRef(new Map());
  const loadedAccountId = useRef(null);
  const [trades, setTrades] = useState([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  const clearPositionTracking = useCallback(() => {
    confirmedPositionVersion.current = 0;
    confirmedPositions.current.clear();
    livePositionMarks.current.clear();
  }, []);

  const reconcilePositions = useCallback((serverPositions, refreshVersionAtStart) => {
    const byId = new Map(
      serverPositions
        .filter((position) => position && typeof position.id === "string")
        .map((position) => [position.id, position])
    );

    for (const [id, confirmed] of confirmedPositions.current) {
      if (confirmed.version > refreshVersionAtStart) {
        byId.set(id, confirmed.position);
      } else if (byId.has(id)) {
        confirmedPositions.current.delete(id);
      } else {
        confirmedPositions.current.delete(id);
        livePositionMarks.current.delete(id);
      }
    }

    const reconciled = [...byId.values()].map((position) => {
      const liveMark = livePositionMarks.current.get(position.id);
      if (position.status === "open" && liveMark) {
        return {
          ...position,
          current_price: liveMark.current_price,
          floating_pnl: liveMark.floating_pnl,
          live_tick_at: liveMark.timestampMs,
        };
      }
      if (position.status !== "open") livePositionMarks.current.delete(position.id);
      return position;
    });
    const activeIds = new Set(reconciled.map((position) => position.id));
    for (const id of livePositionMarks.current.keys()) {
      if (!activeIds.has(id)) livePositionMarks.current.delete(id);
    }
    return reconciled;
  }, []);

  const addConfirmedPosition = useCallback((position) => {
    if (!position || typeof position.id !== "string" || position.status !== "open") {
      throw new TradingRequestError("server_error", 502);
    }
    confirmedPositionVersion.current += 1;
    confirmedPositions.current.set(position.id, {
      position,
      version: confirmedPositionVersion.current,
    });
    const liveMark = livePositionMarks.current.get(position.id);
    const displayedPosition = liveMark
      ? {
        ...position,
        current_price: liveMark.current_price,
        floating_pnl: liveMark.floating_pnl,
        live_tick_at: liveMark.timestampMs,
      }
      : position;
    setPositions((current) => [
      displayedPosition,
      ...current.filter((item) => item.id !== position.id),
    ]);
  }, []);

  const removeClosedPosition = useCallback((positionId) => {
    confirmedPositions.current.delete(positionId);
    livePositionMarks.current.delete(positionId);
    setPositions((current) => current.filter((position) => position.id !== positionId));
  }, []);

  const applyLiveTickToPositions = useCallback((tick) => {
    if (!Number.isFinite(tick.timestampMs)) return;
    const updates = new Map();
    for (const position of positionsRef.current) {
      if (position.status !== "open" || position.symbol?.toUpperCase() !== tick.symbol) continue;
      const markPrice = position.side === "BUY" ? tick.bid : position.side === "SELL" ? tick.ask : null;
      const floatingPnl = calculateDisplayFloatingPnl(position, markPrice);
      if (floatingPnl === null) continue;
      const previous = livePositionMarks.current.get(position.id);
      if (previous && tick.timestampMs < previous.timestampMs) continue;
      const mark = { timestampMs: tick.timestampMs, current_price: markPrice, floating_pnl: floatingPnl };
      livePositionMarks.current.set(position.id, mark);
      updates.set(position.id, mark);
    }
    if (!updates.size) return;
    setPositions((current) => current.map((position) => {
      const mark = updates.get(position.id);
      return mark && position.status === "open"
        ? {
          ...position,
          current_price: mark.current_price,
          floating_pnl: mark.floating_pnl,
          live_tick_at: mark.timestampMs,
        }
        : position;
    }));
  }, []);

  useEffect(() => {
    let unsubscribe;
    let disposed = false;
    try {
      const auth = getTerminalFirebaseAuth();
      auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL)
        .then(() => {
          if (disposed) return;
          unsubscribe = auth.onAuthStateChanged((nextUser) => {
            setUser(nextUser);
            setAuthStatus(nextUser ? "signed-in" : "signed-out");
            setAccounts([]);
            setSelectedAccountId("");
            setAccount(null);
            setRules(null);
            setPositions([]);
            setTrades([]);
            setError("");
          }, () => {
            setAuthStatus("unavailable");
            setError(TRADING_ERROR_MESSAGES.authentication_required);
          });
        })
        .catch(() => {
          if (disposed) return;
          setAuthStatus("unavailable");
          setAccountsLoading(false);
          setError(TRADING_ERROR_MESSAGES.authentication_required);
        });
    } catch {
      setAuthStatus("unavailable");
      setAccountsLoading(false);
      setError(TRADING_ERROR_MESSAGES.authentication_required);
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setAccounts([]);
      setSelectedAccountId("");
      setAccountsLoading(authStatus === "loading");
      return undefined;
    }
    let disposed = false;
    setAccountsLoading(true);
    getTradingJson("/my/accounts", user)
      .then((rows) => {
        if (disposed) return;
        const ownedAccounts = Array.isArray(rows) ? rows : [];
        setAccounts(ownedAccounts);
        setSelectedAccountId((current) =>
          ownedAccounts.some((item) => item.id === current)
            ? current
            : ownedAccounts.find((item) => item.status === "active" && item.tradingEnabled)?.id ||
              ownedAccounts[0]?.id ||
              ""
        );
        setError("");
      })
      .catch((requestError) => {
        if (disposed) return;
        setError(requestError.message);
      })
      .finally(() => {
        if (!disposed) setAccountsLoading(false);
      });
    return () => { disposed = true; };
  }, [user]);

  const selectedAccount = accounts.find((item) => item.id === selectedAccountId) || null;
  const canTrade = Boolean(
    user &&
    selectedAccount &&
    selectedAccount.status === "active" &&
    selectedAccount.tradingEnabled === true
  );

  useEffect(() => {
    if (!user || !selectedAccount) {
      loadedAccountId.current = null;
      clearPositionTracking();
      setDataLoading(false);
      setAccount(null);
      setRules(null);
      setPositions([]);
      setTrades([]);
      return undefined;
    }
    if (!canTrade) {
      loadedAccountId.current = null;
      clearPositionTracking();
      setDataLoading(false);
      setAccount(null);
      setRules(null);
      setPositions([]);
      setTrades([]);
      setError(TRADING_ERROR_MESSAGES.trading_disabled);
      return undefined;
    }

    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    if (loadedAccountId.current !== selectedAccount.id) {
      loadedAccountId.current = selectedAccount.id;
      clearPositionTracking();
      setAccount(null);
      setRules(null);
      setPositions([]);
      setTrades([]);
    }
    setDataLoading(true);
    setError("");
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const refreshVersionAtStart = confirmedPositionVersion.current;
      try {
        const accountQuery = `?account_id=${encodeURIComponent(selectedAccount.id)}`;
        const [accountResult, rulesResult, tradesResult] = await Promise.all([
          getTradingJson(`/trading/accounts${accountQuery}`, user, { signal: controller.signal }),
          getTradingJson(`/trading/account-rules${accountQuery}`, user, { signal: controller.signal }),
          getTradingJson(`/trading/trades${accountQuery}`, user, { signal: controller.signal }),
        ]);
        if (disposed) return;
        setAccount(accountResult.account || null);
        setPositions(reconcilePositions(
          Array.isArray(accountResult.positions) ? accountResult.positions : [],
          refreshVersionAtStart
        ));
        setRules(rulesResult.rules || accountResult.rules || null);
        setTrades(Array.isArray(tradesResult.trades) ? tradesResult.trades : []);
        setError("");
      } catch (requestError) {
        if (disposed || requestError.name === "AbortError") return;
        setError(requestError.message);
        setAccount(null);
        setRules(null);
        setTrades([]);
      } finally {
        if (!disposed) setDataLoading(false);
        inFlight = false;
      }
    };
    refresh();
    const timer = window.setInterval(refresh, TRADING_POLL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [user, selectedAccount?.id, canTrade, refreshVersion, clearPositionTracking, reconcilePositions]);

  return {
    authStatus,
    user,
    accounts,
    accountsLoading,
    selectedAccount,
    selectedAccountId,
    setSelectedAccountId,
    account,
    rules,
    positions,
    trades,
    dataLoading,
    error,
    canTrade,
    addConfirmedPosition,
    removeClosedPosition,
    applyLiveTickToPositions,
    refresh: () => setRefreshVersion((current) => current + 1),
  };
}

function calculateDisplayFloatingPnl(position, markPrice) {
  const price = Number(markPrice);
  const openPrice = Number(position.open_price);
  const volume = Number(position.volume);
  const metadata = position.pnl_metadata;
  const contractSize = Number(metadata?.contract_size);
  const baseCurrency = typeof metadata?.base_currency === "string"
    ? metadata.base_currency.toUpperCase()
    : "";
  const quoteCurrency = typeof metadata?.quote_currency === "string"
    ? metadata.quote_currency.toUpperCase()
    : "";
  if (
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(openPrice) || openPrice <= 0 ||
    !Number.isFinite(volume) || volume <= 0 ||
    !Number.isFinite(contractSize) || contractSize <= 0 ||
    !baseCurrency || !quoteCurrency ||
    !["BUY", "SELL"].includes(position.side)
  ) return null;

  const direction = position.side === "BUY" ? 1 : -1;
  const quotePnl = direction * (price - openPrice) * volume * contractSize;
  if (quoteCurrency === "USD") return quotePnl;
  if (baseCurrency === "USD" && ["JPY", "CHF", "CAD"].includes(quoteCurrency)) {
    return quotePnl / price;
  }
  return null;
}

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

function getPositionPriceDigits(position) {
  const digits = Number(position?.pnl_metadata?.price_decimals);
  return Number.isInteger(digits) && digits >= 0 ? digits : getPriceDigits(position?.symbol);
}

function snapPriceToPositionPrecision(price, position) {
  const digits = Number(position?.pnl_metadata?.price_decimals);
  if (!Number.isInteger(digits) || digits < 0 || !Number.isFinite(price) || price <= 0) return null;
  const scale = 10 ** digits;
  return Number((Math.round(price * scale) / scale).toFixed(digits));
}

function formatSignedMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  const amount = Number(value);
  return `${amount >= 0 ? "+" : "-"}$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
  if (quote.market_state?.toLowerCase() === "closed") return { label: "Market Closed", tone: "closed" };
  if (quote.stale) return { label: "Stale", tone: "stale" };
  return { label: "Live", tone: "live" };
}

function normalizeQuotePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function quoteTimestampMs(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function useMarketData(liveTickHandler, onAcceptedTick) {
  const [symbols, setSymbols] = useState([]);
  const [symbolState, setSymbolState] = useState("loading");
  const [symbolError, setSymbolError] = useState("");
  const [quotes, setQuotes] = useState({});
  const [quoteErrors, setQuoteErrors] = useState({});
  const [quoteRefresh, setQuoteRefresh] = useState("loading");
  const quoteTimes = useRef({});

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
    let starting = false;
    let streamReady = false;
    let retryTimer = null;
    let connection = null;
    let snapshotPromise = null;
    const marketSymbolRecords = symbols
      .filter((item) => item?.enabled !== false && item?.is_enabled !== false)
      .map((item) => ({
        symbol: item.symbol?.trim().toUpperCase(),
        provider: item.provider,
        providerSymbol: item.provider_symbol?.trim().toUpperCase(),
      }))
      .filter((item) => item.symbol);
    const canonicalSymbols = [...new Set(marketSymbolRecords.map((item) => item.symbol))];
    if (!canonicalSymbols.length) return undefined;
    const enabledSymbols = new Set(canonicalSymbols);
    const canonicalSymbolsByProviderSymbol = new Map();
    for (const item of marketSymbolRecords) {
      if (item.provider !== "biquote" || !item.providerSymbol) continue;
      const mappedSymbols = canonicalSymbolsByProviderSymbol.get(item.providerSymbol) || [];
      mappedSymbols.push(item.symbol);
      canonicalSymbolsByProviderSymbol.set(item.providerSymbol, mappedSymbols);
    }
    const providerSymbols = [...canonicalSymbolsByProviderSymbol.keys()];
    const liveMappedSymbols = new Set([...canonicalSymbolsByProviderSymbol.values()].flat());
    const unmappedSymbols = canonicalSymbols.filter((symbol) => !liveMappedSymbols.has(symbol));
    if (unmappedSymbols.length) {
      setQuoteErrors((current) => ({
        ...current,
        ...Object.fromEntries(unmappedSymbols.map((symbol) => [symbol, {
          symbol,
          code: "provider_mapping_missing",
          message: "No Biquote live symbol mapping is configured.",
        }])),
      }));
    }

    const markQuotesStale = () => {
      streamReady = false;
      setQuoteRefresh("error");
      setQuotes((current) => Object.fromEntries(Object.entries(current).map(([symbol, quote]) => [
        symbol,
        { ...quote, bid: null, ask: null, mid: null, stale: true },
      ])));
    };

    const applyQuote = (quote, timestamp, preserveMarketState = false) => {
      const previousTimestamp = quoteTimes.current[quote.symbol];
      if (previousTimestamp !== undefined && (timestamp === null || timestamp < previousTimestamp)) return false;
      if (timestamp !== null) quoteTimes.current[quote.symbol] = timestamp;
      setQuotes((current) => {
        const previous = current[quote.symbol];
        const nextQuote = preserveMarketState && quote.market_state == null && previous?.market_state
          ? { ...quote, market_state: previous.market_state }
          : quote;
        return { ...current, [quote.symbol]: nextQuote };
      });
      return true;
    };

    const refreshSnapshot = () => {
      if (disposed || document.hidden) return Promise.resolve(null);
      if (snapshotPromise) return snapshotPromise;
      setQuoteRefresh((current) => current === "loading" ? "loading" : "refreshing");
      snapshotPromise = (async () => {
        try {
          const query = canonicalSymbols.join(",");
          const payload = await getJson(`/market/quotes?symbols=${encodeURIComponent(query)}`);
          if (disposed) return null;
          const nextErrors = {};
          const freshSymbols = new Set();
          for (const rawQuote of payload.quotes || []) {
            const symbol = typeof rawQuote?.symbol === "string" ? rawQuote.symbol.trim().toUpperCase() : "";
            if (!enabledSymbols.has(symbol)) continue;
            const timestamp = quoteTimestampMs(rawQuote.timestamp);
            const accepted = applyQuote({
              ...rawQuote,
              symbol,
              bid: normalizeQuotePrice(rawQuote.bid),
              ask: normalizeQuotePrice(rawQuote.ask),
              mid: normalizeQuotePrice(rawQuote.mid),
              stale: !streamReady || rawQuote.stale === true,
            }, timestamp);
            if (accepted && rawQuote.stale !== true) freshSymbols.add(symbol);
          }
          for (const item of payload.errors || []) {
            const symbol = typeof item?.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
            if (!enabledSymbols.has(symbol)) continue;
            nextErrors[symbol] = item;
            setQuotes((current) => current[symbol] ? {
              ...current,
              [symbol]: { ...current[symbol], bid: null, ask: null, mid: null, stale: true },
            } : current);
          }
          setQuoteErrors(nextErrors);
          setQuoteRefresh(streamReady ? "ready" : "error");
          return { errors: new Set(Object.keys(nextErrors)), freshSymbols };
        } catch (error) {
          if (disposed) return null;
          setQuoteErrors(Object.fromEntries(symbols.map(({ symbol }) => [symbol, {
            symbol,
            code: "request_failed",
            message: error.message,
          }])));
          setQuoteRefresh("error");
          return null;
        } finally {
          snapshotPromise = null;
        }
      })();
      return snapshotPromise;
    };

    const markSnapshotFresh = (snapshot) => {
      if (!snapshot) return;
      setQuotes((current) => Object.fromEntries(Object.entries(current).map(([symbol, quote]) => [
        symbol,
        snapshot.freshSymbols.has(symbol) && !snapshot.errors.has(symbol) ? { ...quote, stale: false } : quote,
      ])));
    };

    const refreshSnapshotForConnection = async () => {
      if (snapshotPromise) await snapshotPromise;
      return refreshSnapshot();
    };

    const scheduleRetry = () => {
      if (disposed || document.hidden || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void startConnection();
      }, QUOTE_FALLBACK_MS);
    };

    const subscribeAndSync = async () => {
      const snapshotErrors = await refreshSnapshotForConnection();
      if (disposed || document.hidden || connection.state !== signalR.HubConnectionState.Connected) return;
      await connection.invoke("Subscribe", providerSymbols);
      if (disposed || document.hidden) return;
      streamReady = true;
      markSnapshotFresh(snapshotErrors);
      setQuoteRefresh("ready");
    };

    const startConnection = async () => {
      if (disposed || document.hidden || starting || !connection
        || connection.state !== signalR.HubConnectionState.Disconnected) return;
      starting = true;
      setQuoteRefresh((current) => current === "loading" ? "loading" : "refreshing");
      try {
        await connection.start();
        await subscribeAndSync();
      } catch {
        markQuotesStale();
        if (connection.state !== signalR.HubConnectionState.Disconnected) await connection.stop();
        scheduleRetry();
      } finally {
        starting = false;
        if (!disposed && !document.hidden && connection?.state === signalR.HubConnectionState.Disconnected) {
          scheduleRetry();
        }
      }
    };

    if (providerSymbols.length) {
      connection = new signalR.HubConnectionBuilder()
        .withUrl("https://biquote.io/hubs/tick", { withCredentials: false })
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Error)
        .build();
      connection.on("ReceiveTick", (rawTick) => {
        if (disposed || !rawTick || typeof rawTick !== "object") return;
        const providerSymbol = typeof rawTick.symbol === "string" ? rawTick.symbol.trim().toUpperCase() : "";
        const mappedSymbols = canonicalSymbolsByProviderSymbol.get(providerSymbol);
        const timestamp = quoteTimestampMs(rawTick.timestamp);
        if (!mappedSymbols?.length || timestamp === null) return;
        const bid = normalizeQuotePrice(rawTick.bid);
        const ask = normalizeQuotePrice(rawTick.ask);
        const mid = normalizeQuotePrice(rawTick.mid);
        if ((rawTick.bid != null && bid === null) || (rawTick.ask != null && ask === null) || mid === null) return;
        const marketState = typeof rawTick.marketState === "string" ? rawTick.marketState : null;
        const receivedAt = Date.now();
        const isStale = rawTick.stale === true ||
          marketState?.toLowerCase() === "closed" ||
          timestamp > receivedAt + 60_000 ||
          receivedAt - timestamp > LIVE_TICK_MAX_AGE_MS;
        if (isStale) {
          setQuotes((current) => {
            const next = { ...current };
            for (const symbol of mappedSymbols) {
              const previousTimestamp = quoteTimes.current[symbol];
              if (previousTimestamp !== undefined && timestamp <= previousTimestamp) continue;
              next[symbol] = {
                symbol,
                bid,
                ask,
                mid,
                timestamp: rawTick.timestamp ?? null,
                stale: true,
                ...(marketState ? { market_state: marketState } : {}),
              };
            }
            return next;
          });
          return;
        }
        flushSync(() => {
          let accepted = false;
          for (const symbol of mappedSymbols) {
            const previousTimestamp = quoteTimes.current[symbol];
            if (previousTimestamp !== undefined && timestamp < previousTimestamp) continue;
            const tick = {
              symbol,
              bid,
              ask,
              mid,
              timestamp: rawTick.timestamp ?? null,
              timestampMs: timestamp,
              stale: false,
              ...(marketState ? { market_state: marketState } : {}),
            };
            if (!applyQuote(tick, timestamp, true)) continue;
            accepted = true;
            onAcceptedTick?.(tick);
            liveTickHandler.current?.(tick);
            setQuoteErrors((current) => {
              if (!current[symbol]) return current;
              const next = { ...current };
              delete next[symbol];
              return next;
            });
          }
          if (accepted) setQuoteRefresh("ready");
        });
      });
      connection.onreconnecting(markQuotesStale);
      connection.onreconnected(() => {
        streamReady = false;
        void subscribeAndSync().catch(() => {
          markQuotesStale();
          void connection.stop();
        });
      });
      connection.onclose(() => {
        markQuotesStale();
        scheduleRetry();
      });
      void startConnection();
    }

    const fallbackTimer = window.setInterval(() => {
      if (!streamReady) void refreshSnapshot();
    }, QUOTE_FALLBACK_MS);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        markQuotesStale();
        if (connection && connection.state !== signalR.HubConnectionState.Disconnected) void connection.stop();
      } else {
        void startConnection();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(fallbackTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (connection) void connection.stop();
    };
  }, [symbols, onAcceptedTick]);

  return { symbols, symbolState, symbolError, quotes, quoteErrors, quoteRefresh };
}

function useCandles(symbol, interval) {
  const [candles, setCandles] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [dataKey, setDataKey] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const pagerRef = useRef(null);
  const loadingMoreRef = useRef(false);
  const requestKey = `${symbol}|${interval}`;

  const loadOlderHistory = useCallback(async () => {
    const pager = pagerRef.current;
    if (!pager || !pager.hasMore || loadingMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await pager.loadOlder();
      if (pagerRef.current !== pager) return;
      if (result.added > 0) setCandles(result.candles);
      setHasMoreHistory(result.hasMore);
      setError("");
    } catch (requestError) {
      if (requestError.name === "AbortError" || pagerRef.current !== pager) return;
      setError(requestError.message);
    } finally {
      if (pagerRef.current === pager) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    setCandles([]);
    setDataKey(requestKey);
    setState("loading");
    setError("");
    setSource("");
    setLoadingMore(false);
    setHasMoreHistory(false);
    loadingMoreRef.current = false;
    if (!symbol) {
      pagerRef.current = null;
      setState("empty");
      return undefined;
    }
    const controller = new AbortController();
    let initialPageLoaded = false;
    const fetchPage = async ({ symbol: requestedSymbol, interval: requestedInterval, limit, to, signal }) => {
      const params = new URLSearchParams({
        symbol: requestedSymbol,
        interval: requestedInterval,
        limit: String(limit),
      });
      if (to) params.set("to", to);
      const payload = await getJson(`/market/candles?${params}`, signal);
      if (!Array.isArray(payload.bars)) {
        throw new Error("The market service returned malformed candle data.");
      }
      return payload.bars;
    };
    const pager = createCandleHistoryPager({
      symbol,
      interval,
      signal: controller.signal,
      fetchPage,
    });
    pagerRef.current = pager;
    pager.loadInitial().then((result) => {
      if (controller.signal.aborted || pagerRef.current !== pager) return;
      initialPageLoaded = true;
      setCandles(result.candles);
      setSource("provider_historical");
      setState(result.candles.length ? "ready" : "empty");
      setHasMoreHistory(result.hasMore);
    }).catch((requestError) => {
      if (
        requestError.name === "AbortError" ||
        controller.signal.aborted ||
        pagerRef.current !== pager
      ) return;
      setError(requestError.message);
      setState(initialPageLoaded ? "ready" : "error");
    });
    return () => {
      controller.abort();
      if (pagerRef.current === pager) pagerRef.current = null;
    };
  }, [symbol, interval]);

  return {
    candles,
    state,
    error,
    source,
    dataKey,
    loadingMore,
    hasMoreHistory,
    loadOlderHistory,
  };
}

function BrandMark() {
  return (
    <div className="brand-lockup" aria-label="Daily Funded">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M7 18V7.5c0-.8.7-1.5 1.5-1.5H18" />
          <path d="M9 15.5 12 12l2.2 1.8L18 9" />
          <path d="M15 9h3v3" />
        </svg>
      </span>
      <span className="brand-name">Daily <span>Funded</span></span>
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

function TopBar({
  symbol,
  selected,
  quote,
  quoteError,
  watchOpen,
  onToggleWatch,
  onToggleOrder,
  account,
  equity,
  freeMargin,
  openPnl,
  accounts,
  accountsLoading,
  selectedAccountId,
  onAccountChange,
  authStatus,
  accountStatus,
  selectedAccount,
}) {
  const digits = getPriceDigits(symbol);
  const spread = quote?.bid != null && quote?.ask != null
    ? Number(quote.ask) - Number(quote.bid)
    : null;
  const marketState = getMarketState(quote, quoteError);
  const formatAccountPhase = (phase) => {
    if (typeof phase !== "string") return "";
    if (phase.toLowerCase() === "instant") return "Instant";
    const match = /^phase[_ -]?(\d+)$/i.exec(phase);
    return match ? `Phase ${match[1]}` : "";
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button mobile-only" type="button" aria-label={watchOpen ? "Close watchlist" : "Open watchlist"} onClick={onToggleWatch}>
          {watchOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <BrandMark />
        <label className="account-select">
          <span className="account-avatar">DF</span>
          <span className="account-select-copy">
            <small>TRADING ACCOUNT</small>
            <select
              className="account-select-dropdown"
              aria-label="Trading account"
              value={selectedAccountId}
              onChange={(event) => onAccountChange(event.target.value)}
              disabled={accountsLoading || !accounts.length}
            >
              {accounts.length
                ? accounts.map((item) => {
                  const phase = formatAccountPhase(item.phase);
                  return (
                    <option key={item.id} value={item.id}>
                      {`$${Number(item.size || 0).toLocaleString("en-US")} · ${item.label || item.plan || "Challenge"}${phase ? ` · ${phase}` : ""} · ${(item.status || "unknown").toUpperCase()} · ${item.status === "active" && item.tradingEnabled === true ? "Trading enabled" : "Trading disabled"}`}
                    </option>
                  );
                })
                : <option value="">{accountsLoading ? "Loading accounts…" : authStatus === "signed-out" ? "Sign in required" : "No account available"}</option>}
            </select>
            <small className={`account-status account-status-${(accountStatus || "unavailable").toLowerCase()}`}>
              {accountStatus
                ? `${accountStatus.toUpperCase()} · ${selectedAccount?.status === "active" && selectedAccount?.tradingEnabled === true ? "Trading enabled" : "Trading disabled"}`
                : accountsLoading ? "Loading" : "Unavailable"}
            </small>
          </span>
          <ChevronDown size={14} />
        </label>
      </div>

      <div className="topbar-market">
        <div className="market-selected">
          <InstrumentMark symbol={symbol} />
          <div><strong>{symbol || "Select market"}</strong><small>{selected ? (SHORT_NAMES[symbol] || selected.display_name || symbol) : "Market data"}</small></div>
          <span className={`state-dot state-${marketState.tone}`} title={marketState.label} />
        </div>
        <QuoteChip label="BID" value={quote?.bid == null ? "--" : formatPrice(quote.bid, digits)} tone="sell" />
        <QuoteChip label="ASK" value={quote?.ask == null ? "--" : formatPrice(quote.ask, digits)} tone="buy" />
        <QuoteChip label="SPREAD" value={spread == null ? "--" : formatPrice(spread, digits)} />
      </div>

      <div className="topbar-right">
        <div className="account-metric"><span>Balance</span><strong>{formatMoney(account?.balance)}</strong></div>
        <div className="account-metric"><span>Equity</span><strong>{formatMoney(equity)}</strong></div>
        <div className="account-metric account-metric-wide"><span>Free margin</span><strong>{formatMoney(freeMargin)}</strong></div>
        <div className="account-metric account-metric-wide"><span>Open P/L</span><strong>{formatMoney(openPnl)}</strong></div>
        <span className="topbar-divider" />
        <button className="icon-button settings-button" type="button" title="Terminal settings" aria-label="Terminal settings"><Settings2 size={18} /></button>
        <button className="mobile-order-trigger" type="button" onClick={onToggleOrder}>Order</button>
      </div>
    </header>
  );
}

function formatMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function ChartView({
  symbol,
  selected,
  quote,
  quoteError,
  candles,
  candleDataKey,
  state,
  error,
  hasMoreHistory,
  loadOlderHistory,
  loadingMore,
  interval,
  onIntervalChange,
  onOpenWatchlist,
  liveTickHandler,
  positions,
  canTrade,
  onClosePosition,
  onModifyPosition,
}) {
  const chartHost = useRef(null);
  const chartRef = useRef(null);
  const candleSeries = useRef(null);
  const candleDataRef = useRef([]);
  const liveCandlesRef = useRef(new Map());
  const positionPriceLines = useRef(new Map());
  const pendingLiveTicks = useRef([]);
  const candleKeyRef = useRef("");
  const initialHistoryFitKeyRef = useRef("");
  const applyingHistoryRef = useRef(false);
  const baselineKeyRef = useRef("");
  const applyLiveTickRef = useRef(null);
  const dragRef = useRef(null);
  const [hasLiveCandle, setHasLiveCandle] = useState(false);
  const [candleCount, setCandleCount] = useState(0);
  const [candleBucketTime, setCandleBucketTime] = useState(null);
  const [latestTickTimestampMs, setLatestTickTimestampMs] = useState(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [chartTimeZone, setChartTimeZone] = useState(getInitialChartTimeZone);
  const [draftPrices, setDraftPrices] = useState(new Map());
  const [closingIds, setClosingIds] = useState(new Set());
  const [modifyingIds, setModifyingIds] = useState(new Set());
  const [controlError, setControlError] = useState("");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const digits = getPriceDigits(symbol);
  const chartTimeZoneRef = useRef(getResolvedTimeZone(chartTimeZone, symbol));
  chartTimeZoneRef.current = getResolvedTimeZone(chartTimeZone, symbol);
  const dataKey = `${symbol}|${interval}`;

  useLayoutEffect(() => {
    if (!chartHost.current) return undefined;
    const chart = createChart(chartHost.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#141b1f" },
        textColor: "#828c8c",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#303a3f" },
        horzLines: { color: "#303a3f" },
      },
      rightPriceScale: { borderColor: "#303737", minimumWidth: 72, autoScale: true },
      timeScale: {
        borderColor: "#303737",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 9,
        tickMarkFormatter: (time, tickMarkType) => formatChartTime(time, chartTimeZoneRef.current, tickMarkType),
      },
      crosshair: { vertLine: { color: "#758280", labelBackgroundColor: "#2e3735" }, horzLine: { color: "#758280", labelBackgroundColor: "#2e3735" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: {
        priceFormatter: (price) => formatPrice(price, digits),
        timeFormatter: (time) => formatChartCrosshairTime(time, chartTimeZoneRef.current),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#1685f5",
      downColor: "#f0443e",
      borderUpColor: "#1685f5",
      borderDownColor: "#f0443e",
      wickUpColor: "#1685f5",
      wickDownColor: "#f0443e",
      borderVisible: true,
      wickVisible: true,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    candleSeries.current = series;
    const updateOverlayLayout = () => setLayoutVersion((version) => version + 1);
    chart.subscribeCrosshairMove(updateOverlayLayout);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateOverlayLayout);
    if (chartHost.current) resizeObserver?.observe(chartHost.current);
    return () => {
      resizeObserver?.disconnect();
      chart.unsubscribeCrosshairMove(updateOverlayLayout);
      for (const { line } of positionPriceLines.current.values()) {
        series.removePriceLine(line);
      }
      positionPriceLines.current.clear();
      chart.remove();
      chartRef.current = null;
      candleSeries.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (candleKeyRef.current === dataKey) return;
    candleKeyRef.current = dataKey;
    initialHistoryFitKeyRef.current = "";
    baselineKeyRef.current = "";
    candleDataRef.current = [];
    liveCandlesRef.current = new Map();
    pendingLiveTicks.current = [];
    setCandleBucketTime(null);
    setLatestTickTimestampMs(null);
    setDraftPrices(new Map());
    setHasLiveCandle(false);
    setCandleCount(0);
    candleSeries.current?.setData([]);
  }, [dataKey]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series) return undefined;
    const intervalSeconds = INTERVAL_SECONDS[interval];
    const applyTick = (tick) => {
      if (tick.symbol !== symbol) return true;
      if (!Number.isFinite(tick.timestampMs) || tick.mid == null) return false;
      if (baselineKeyRef.current !== dataKey) {
        pendingLiveTicks.current.push(tick);
        return true;
      }
      const current = candleDataRef.current;
      const last = current[current.length - 1];
      const next = candleFromLiveTick(last, tick, intervalSeconds);
      if (!next) return false;
      const candleTime = next.time;
      liveCandlesRef.current.set(candleTime, next);
      setCandleBucketTime(candleTime);
      setLatestTickTimestampMs(tick.timestampMs);

      series.update(next);
      if (last && candleTime === last.time) current[current.length - 1] = next;
      else {
        current.push(next);
        setCandleCount((count) => count + 1);
      }
      setHasLiveCandle(true);
      return true;
    };

    applyLiveTickRef.current = applyTick;
    liveTickHandler.current = applyTick;
    return () => {
      if (liveTickHandler.current === applyTick) liveTickHandler.current = null;
      if (applyLiveTickRef.current === applyTick) applyLiveTickRef.current = null;
    };
  }, [dataKey, interval, liveTickHandler, symbol]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series || state === "loading" || candleDataKey !== dataKey) return;
    const sameBaseline = baselineKeyRef.current === dataKey;
    const timeScale = chartRef.current?.timeScale();
    const mergedCandles = mergeHistoryWithLive(candles, liveCandlesRef.current);
    series.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    applyingHistoryRef.current = true;
    try {
      setSeriesDataPreservingVisibleRange(series, timeScale, mergedCandles, sameBaseline);
    } finally {
      applyingHistoryRef.current = false;
    }
    candleDataRef.current = mergedCandles;
    setCandleCount(mergedCandles.length);
    baselineKeyRef.current = dataKey;
    const queuedTicks = pendingLiveTicks.current;
    pendingLiveTicks.current = [];
    for (const tick of queuedTicks) applyLiveTickRef.current?.(tick);
    fitInitialHistoryOnce(timeScale, dataKey, loadingMore, initialHistoryFitKeyRef, mergedCandles.length);
  }, [candles, candleDataKey, dataKey, digits, loadingMore, state]);

  useEffect(() => {
    if (!hasMoreHistory || state !== "ready" || candleDataKey !== dataKey) return undefined;
    const timeScale = chartRef.current?.timeScale();
    if (!timeScale) return undefined;
    const checkLeftEdge = (logicalRange) => {
      if (!applyingHistoryRef.current && shouldLoadOlderHistory(logicalRange)) {
        void loadOlderHistory();
      }
    };
    timeScale.subscribeVisibleLogicalRangeChange(checkLeftEdge);
    checkLeftEdge(timeScale.getVisibleLogicalRange());
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(checkLeftEdge);
  }, [candles, candleDataKey, dataKey, hasMoreHistory, loadOlderHistory, state]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    series.applyOptions({ priceLineVisible: false, lastValueVisible: false });
    if (quote?.mid != null && Number.isFinite(Number(quote.mid))) {
      const line = series.createPriceLine({
        price: Number(quote.mid),
        color: quote.stale ? "#a5a88f" : "#ee4f4f",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      return () => series.removePriceLine(line);
    }
    return undefined;
  }, [quote?.mid, quote?.stale]);

  useLayoutEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    const desiredLines = new Map();
    for (const position of positions) {
      if (
        position?.status !== "open" ||
        position.symbol?.toUpperCase() !== symbol ||
        typeof position.id !== "string"
      ) continue;
      const entryPrice = Number(position.open_price);
      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        desiredLines.set(`${position.id}:entry`, {
          price: entryPrice,
          color: position.side === "BUY" ? "#62c99d" : "#ef8279",
          lineStyle: 0,
        });
      }
      for (const [field, color, title] of [
        ["stop_loss", "#e17f73", "SL"],
        ["take_profit", "#6fc6a1", "TP"],
      ]) {
        const price = Number(draftPrices.get(`${position.id}:${field}`) ?? position[field]);
        if (Number.isFinite(price) && price > 0) {
          desiredLines.set(`${position.id}:${field}`, {
            price,
            color,
            lineStyle: 2,
            title,
          });
        }
      }
    }

    for (const [key, existing] of positionPriceLines.current) {
      if (!desiredLines.has(key)) {
        series.removePriceLine(existing.line);
        positionPriceLines.current.delete(key);
      }
    }
    for (const [key, options] of desiredLines) {
      const existing = positionPriceLines.current.get(key);
      if (!existing) {
        positionPriceLines.current.set(key, {
          line: series.createPriceLine({
            price: options.price,
            color: options.color,
            lineWidth: 1,
            lineStyle: options.lineStyle,
            axisLabelVisible: true,
            title: options.title,
          }),
          price: options.price,
        });
      } else if (existing.price !== options.price) {
        existing.line.applyOptions({ price: options.price });
        existing.price = options.price;
      }
    }
  }, [draftPrices, positions, symbol]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const tickAgeMs = latestTickTimestampMs === null ? Infinity : clockNow - latestTickTimestampMs;
  const countdownLive = Boolean(
    candleBucketTime !== null &&
    quote &&
    quote.stale !== true &&
    tickAgeMs >= 0 &&
    tickAgeMs <= QUOTE_FALLBACK_MS
  );
  const intervalSeconds = INTERVAL_SECONDS[interval];
  const currentCandleStart = Math.floor(clockNow / (intervalSeconds * 1000)) * intervalSeconds;
  const candleEndMs = (currentCandleStart + intervalSeconds) * 1000;
  const remainingSeconds = Math.max(0, Math.ceil((candleEndMs - clockNow) / 1000));
  const countdownText = remainingSeconds >= 3600
      ? `${String(Math.floor(remainingSeconds / 3600)).padStart(2, "0")}:${String(Math.floor((remainingSeconds % 3600) / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`
      : `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`;

  async function closeChartPosition(position) {
    if (closingIds.has(position.id) || !canTrade) return;
    setClosingIds((current) => new Set(current).add(position.id));
    setControlError("");
    try {
      const result = await onClosePosition(position);
      if (result === false) setControlError("The server did not confirm closing this position.");
    } catch (error) {
      setControlError(error.message || "The server did not confirm closing this position.");
    } finally {
      setClosingIds((current) => {
        const next = new Set(current);
        next.delete(position.id);
        return next;
      });
    }
  }

  function priceFromPointer(event) {
    const rect = chartHost.current?.getBoundingClientRect();
    if (!rect || !candleSeries.current) return null;
    const price = candleSeries.current.coordinateToPrice(event.clientY - rect.top);
    if (price === null || price === undefined || !Number.isFinite(Number(price))) return null;
    return Number(price);
  }

  function handleProtectionPointerDown(event, position, field) {
    if (
      event.button !== 0 ||
      !canTrade ||
      modifyingIds.has(position.id) ||
      !Number.isFinite(Number(position.pnl_metadata?.price_decimals))
    ) return;
    event.preventDefault();
    event.stopPropagation();
    const currentPrice = Number(position[field]);
    const price = Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : Number(position.open_price);
    if (!Number.isFinite(price) || price <= 0) return;
    dragRef.current = {
      id: position.id,
      field,
      pointerId: event.pointerId,
      price,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setControlError("");
  }

  function handleProtectionPointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const position = positions.find((item) => item.id === drag.id);
    const rawPrice = priceFromPointer(event);
    const price = position && rawPrice !== null
      ? snapPriceToPositionPrecision(rawPrice, position)
      : null;
    if (price === null) return;
    drag.price = price;
    drag.moved = true;
    setDraftPrices((current) => new Map(current).set(`${drag.id}:${drag.field}`, price));
    setLayoutVersion((version) => version + 1);
  }

  async function finishProtectionDrag(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!drag.moved) {
      dragRef.current = null;
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(`${drag.id}:${drag.field}`);
        return next;
      });
      return;
    }
    const finalRawPrice = priceFromPointer(event);
    const position = positions.find((item) => item.id === drag.id);
    const finalPrice = position && finalRawPrice !== null
      ? snapPriceToPositionPrecision(finalRawPrice, position)
      : drag.price;
    dragRef.current = null;
    const draftKey = `${drag.id}:${drag.field}`;
    if (!position || finalPrice === null) {
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
      return;
    }
    setDraftPrices((current) => new Map(current).set(draftKey, finalPrice));
    const markPrice = position.side === "BUY" ? Number(quote?.bid) : Number(quote?.ask);
    const quoteIsLive = quote?.stale !== true &&
      Number.isFinite(markPrice) &&
      markPrice > 0 &&
      latestTickTimestampMs !== null &&
      clockNow - latestTickTimestampMs >= 0 &&
      clockNow - latestTickTimestampMs <= QUOTE_FALLBACK_MS;
    const validLevel = drag.field === "stop_loss"
      ? (position.side === "BUY" ? finalPrice < markPrice : finalPrice > markPrice)
      : (position.side === "BUY" ? finalPrice > markPrice : finalPrice < markPrice);
    if (!quoteIsLive || !validLevel) {
      setControlError(!quoteIsLive
        ? "Protection levels cannot be changed while the real market quote is stale or unavailable."
        : "The level must remain on the valid side of the current executable price.");
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
      return;
    }

    setModifyingIds((current) => new Set(current).add(position.id));
    setControlError("");
    try {
      const result = await onModifyPosition(position, { [drag.field]: finalPrice });
      if (result === false) throw new Error("The server did not confirm the protection-level update.");
    } catch (requestError) {
      setControlError(requestError.message || "The server rejected the protection-level update.");
    } finally {
      setDraftPrices((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
      setModifyingIds((current) => {
        const next = new Set(current);
        next.delete(position.id);
        return next;
      });
    }
  }

  const marketState = getMarketState(quote, quoteError);
  const highLow = candles.length ? candles.reduce((range, candle) => ({
    high: Math.max(range.high, candle.high),
    low: Math.min(range.low, candle.low),
  }), { high: -Infinity, low: Infinity }) : null;
  const visiblePositions = positions.filter((position) =>
    position.status === "open" && position.symbol?.toUpperCase() === symbol
  );
  const latestCandle = candleDataRef.current[candleDataRef.current.length - 1]
    || candles[candles.length - 1];
  const historyStartTimestampMs = candles[0]?.timestampMs ?? null;
  const latestCandleTimestampMs = latestCandle?.timestampMs ?? (
    Number.isFinite(latestCandle?.time) ? latestCandle.time * 1000 : null
  );
  const displayTimeZone = chartTimeZoneRef.current;
  const hasLivePrice = quote?.mid !== null
    && quote?.mid !== undefined
    && Number.isFinite(Number(quote.mid));
  const livePrice = hasLivePrice ? Number(quote.mid) : null;
  const displayedPrice = livePrice ?? (Number.isFinite(Number(latestCandle?.close))
    ? Number(latestCandle.close)
    : null);
  const priceCoordinate = displayedPrice === null
    ? null
    : candleSeries.current?.priceToCoordinate(displayedPrice);
  const chartHeight = chartHost.current?.clientHeight ?? 0;
  const livePriceY = Number.isFinite(priceCoordinate)
    ? Math.max(16, Math.min(priceCoordinate, chartHeight - 16))
    : chartHeight > 0 ? chartHeight / 2 : null;
  const priceDirection = latestCandle && latestCandle.close >= latestCandle.open
    ? "price-up"
    : "price-down";

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
      <div className="chart-canvas-wrap" data-layout-version={layoutVersion} onWheelCapture={() => setLayoutVersion((version) => version + 1)}>
        <div className="chart-canvas" ref={chartHost} aria-label={`${symbol} candlestick chart`} />
        <div className="chart-position-controls" aria-label="Open position chart controls">
          {Number.isFinite(livePriceY) && <div
            className={`live-price-countdown ${priceDirection}`}
            style={{ top: `${livePriceY}px` }}
            aria-label={`Current price ${displayedPrice === null ? "unavailable" : formatPrice(displayedPrice, digits)}, candle closes in ${countdownText}`}
          >
            <strong>{displayedPrice === null ? "--" : formatPrice(displayedPrice, digits)}</strong>
            <span>{countdownText}</span>
          </div>}
          {visiblePositions.map((position) => {
            const entryY = candleSeries.current?.priceToCoordinate(Number(position.open_price));
            const digitsForPosition = getPositionPriceDigits(position);
            const stalePnl = !countdownLive || position.live_tick_at == null;
            const pnlValue = position.live_tick_at == null ? null : position.floating_pnl;
            return (
              <React.Fragment key={position.id}>
                {Number.isFinite(entryY) && <div
                  className={`position-line-label ${position.side === "BUY" ? "position-line-buy" : "position-line-sell"}`}
                  style={{ top: `${entryY}px` }}
                  title={position.live_tick_at == null
                    ? "Waiting for the next accepted real market tick."
                    : stalePnl
                      ? "Last display P&L; market data is not currently live."
                      : "Display-only P&L from the latest accepted real market tick."}
                >
                  <span>{position.side} {Number(position.volume).toFixed(2)}</span>
                  <strong className={
                    pnlValue == null
                      ? "position-pnl-neutral"
                      : Number(pnlValue) >= 0
                        ? "position-pnl-positive"
                        : "position-pnl-negative"
                  }>{formatSignedMoney(pnlValue)}</strong>
                  {[
                    ["take_profit", "TP", "position-level-tp"],
                    ["stop_loss", "SL", "position-level-sl"],
                  ].map(([field, label, className]) => (
                    <button
                      key={field}
                      type="button"
                      className={`position-protection-chip ${className} ${Number(position[field]) > 0 ? "protection-set" : "protection-unset"}`}
                      aria-label={`Drag to ${position[field] == null ? "set" : "change"} ${label} for ${position.side} ${position.symbol} position ${position.id}${position[field] == null ? "" : ` at ${formatPrice(position[field], digitsForPosition)}`}`}
                      title={position[field] == null
                        ? `Drag to set ${label}`
                        : `Drag to change ${label} ${formatPrice(position[field], digitsForPosition)}`}
                      disabled={!canTrade || modifyingIds.has(position.id)}
                      onPointerDown={(event) => handleProtectionPointerDown(event, position, field)}
                      onPointerMove={handleProtectionPointerMove}
                      onPointerUp={(event) => void finishProtectionDrag(event)}
                      onPointerCancel={() => {
                        const drag = dragRef.current;
                        if (!drag || drag.id !== position.id || drag.field !== field) return;
                        dragRef.current = null;
                        setDraftPrices((current) => {
                          const next = new Map(current);
                          next.delete(`${position.id}:${field}`);
                          return next;
                        });
                      }}
                    >{label}</button>
                  ))}
                  <button
                    type="button"
                    className="position-line-close"
                    aria-label={`Close ${position.side} ${position.symbol} position ${position.id}`}
                    title={`Close position ${position.id}`}
                    disabled={!canTrade || closingIds.has(position.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeChartPosition(position);
                    }}
                  >{closingIds.has(position.id) ? "…" : "×"}</button>
                </div>}
                {[
                  ["stop_loss", "SL", "position-level-sl"],
                  ["take_profit", "TP", "position-level-tp"],
                ].map(([field, label, className]) => {
                  const draftKey = `${position.id}:${field}`;
                  const rawPrice = draftPrices.has(draftKey) ? draftPrices.get(draftKey) : position[field];
                  if (rawPrice === null || rawPrice === undefined) return null;
                  const price = Number(rawPrice);
                  const y = candleSeries.current?.priceToCoordinate(price);
                  if (!Number.isFinite(price) || !Number.isFinite(y)) return null;
                  return (
                    <React.Fragment key={`${position.id}:${field}`}>
                      <button
                        type="button"
                        className={`position-level-hitarea ${className} ${modifyingIds.has(position.id) ? "position-level-busy" : ""}`}
                        style={{ top: `${y}px` }}
                        aria-label={`Drag ${label} for ${position.side} ${position.symbol} position ${position.id}; price ${formatPrice(price, digitsForPosition)}`}
                        title={`${label} ${formatPrice(price, digitsForPosition)} · drag to modify`}
                        disabled={!canTrade || modifyingIds.has(position.id)}
                        onPointerDown={(event) => handleProtectionPointerDown(event, position, field)}
                        onPointerMove={handleProtectionPointerMove}
                        onPointerUp={(event) => void finishProtectionDrag(event)}
                        onPointerCancel={() => {
                          const drag = dragRef.current;
                          if (!drag || drag.id !== position.id || drag.field !== field) return;
                          dragRef.current = null;
                          setDraftPrices((current) => {
                            const next = new Map(current);
                            next.delete(`${position.id}:${field}`);
                            return next;
                          });
                        }}
                      />
                      <span className={`position-level-label ${className}`} style={{ top: `${y}px` }}>
                        {label} {formatPrice(price, digitsForPosition)}
                      </span>
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
        {controlError && <div className="chart-control-error" role="alert">{controlError}</div>}
        {state !== "ready" && !hasLiveCandle && <div className="chart-overlay">
          {state === "loading" && <><span className="chart-loader" /><strong>Loading {symbol} candles</strong><span>Requesting {interval} market history</span></>}
          {state === "empty" && <><span className="empty-chart-icon"><BarChart3 size={22} /></span><strong>History unavailable</strong><span>No {interval} candles were returned for {symbol}.</span></>}
          {state === "error" && <><span className="empty-chart-icon error-icon"><Activity size={22} /></span><strong>Chart data unavailable</strong><span>{error || "The market service could not return candles."}</span></>}
        </div>}
        {(state === "ready" || hasLiveCandle) && <div className="chart-legend"><span className="legend-dot legend-up" />Up <span className="legend-dot legend-down" />Down <span className="legend-divider" />{candleCount} bars</div>}
      </div>
      <div className="chart-footer">
        <span><Activity size={13} /> Market data only</span>
        <div className="chart-history-range" aria-label="Chart candle timestamps">
          <span>
            <b>Start</b>
            {historyStartTimestampMs === null ? "—" : <time
              dateTime={new Date(historyStartTimestampMs).toISOString()}
              title={`UTC ${new Date(historyStartTimestampMs).toISOString()}`}
            >{formatChartRangeTimestamp(historyStartTimestampMs, displayTimeZone)}</time>}
          </span>
          <span>
            <b>Latest Candle</b>
            {latestCandleTimestampMs === null ? "—" : <time
              dateTime={new Date(latestCandleTimestampMs).toISOString()}
              title={`UTC ${new Date(latestCandleTimestampMs).toISOString()}`}
            >{formatChartRangeTimestamp(latestCandleTimestampMs, displayTimeZone)}</time>}
          </span>
          <span>
            <b>Latest Real Tick</b>
            {latestTickTimestampMs === null ? "—" : <time
              dateTime={new Date(latestTickTimestampMs).toISOString()}
              title={`UTC ${new Date(latestTickTimestampMs).toISOString()}`}
            >{formatChartRangeTimestamp(latestTickTimestampMs, displayTimeZone)}</time>}
          </span>
        </div>
        {(loadingMore || (error && candleCount > 0)) && <span
          className={error && candleCount > 0 ? "chart-history-error" : "chart-history-loading"}
          role="status"
          aria-label={error && candleCount > 0 ? `History incomplete: ${error}` : "Loading older provider candles"}
          title={error || "Loading older provider candles"}
        >{error && candleCount > 0 ? "History incomplete" : "Loading older history…"}</span>}
        <ChartTimezonePicker
          timeZone={chartTimeZone}
          exchangeTimeZone={getExchangeTimeZone(symbol)}
          now={clockNow}
          onSelect={setChartTimeZone}
        />
      </div>
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

function OrderPanel({
  symbol,
  quote,
  quoteError,
  orderOpen,
  onClose,
  account,
  rules,
  canTrade,
  onExecute,
}) {
  const [side, setSide] = useState("BUY");
  const [orderType, setOrderType] = useState("MARKET");
  const [volume, setVolume] = useState(0.1);
  const [oneClick, setOneClick] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const digits = getPriceDigits(symbol);
  const marketState = getMarketState(quote, quoteError);
  const quoteSidePrice = side === "BUY" ? quote?.ask : quote?.bid;

  async function submitOrder() {
    if (!canTrade || submitting) return;
    setSubmitting(true);
    setNotice("");
    try {
      await onExecute({
        symbol,
        side,
        volume,
        order_type: orderType,
        take_profit: takeProfit === "" ? null : (Number.isFinite(Number(takeProfit)) ? Number(takeProfit) : takeProfit),
        stop_loss: stopLoss === "" ? null : (Number.isFinite(Number(stopLoss)) ? Number(stopLoss) : stopLoss),
      });
      setNotice(`${side} ${symbol} market order filled.`);
      setConfirming(false);
      setTakeProfit("");
      setStopLoss("");
    } catch (error) {
      setNotice(error.message || TRADING_ERROR_MESSAGES.server_error);
    } finally {
      setSubmitting(false);
    }
  }

  function startOrder() {
    if (!canTrade) {
      setNotice(TRADING_ERROR_MESSAGES.trading_disabled);
      return;
    }
    if (oneClick) {
      submitOrder();
    } else {
      setConfirming(true);
      setNotice("");
    }
  }

  return (
    <>
      <button className={`drawer-scrim order-scrim ${orderOpen ? "scrim-visible" : ""}`} type="button" aria-label="Close order panel" onClick={onClose} />
      <aside className={`order-panel ${orderOpen ? "order-open" : ""}`}>
        <div className="panel-heading order-heading">
          <div><span className="eyebrow">SERVER-VALIDATED EXECUTION</span><h2>New order <span className="stage-chip">MARKET</span></h2></div>
          <button className="icon-button mobile-only" type="button" aria-label="Close order panel" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="order-symbol-select">
          <InstrumentMark symbol={symbol} />
          <div><strong>{symbol || "No market selected"}</strong><small>{SHORT_NAMES[symbol] || "Select from watchlist"}</small></div>
          <span className={`market-state state-text-${marketState.tone}`}>{marketState.label}</span>
        </div>
        <div className="side-switch" role="tablist" aria-label="Order side">
          <button type="button" role="tab" aria-selected={side === "BUY"} className={side === "BUY" ? "side-buy-active" : ""} onClick={() => setSide("BUY")}><span className="side-arrow">↗</span> Buy</button>
          <button type="button" role="tab" aria-selected={side === "SELL"} className={side === "SELL" ? "side-sell-active" : ""} onClick={() => setSide("SELL")}><span className="side-arrow">↘</span> Sell</button>
        </div>
        <label className="field-label">Order type</label>
        <div className="select-wrap">
          <select value={orderType} onChange={(event) => setOrderType(event.target.value)} aria-label="Order type">
            <option value="MARKET">Market Order</option>
            <option value="LIMIT" disabled>Limit Order — unavailable</option>
          </select><ChevronDown size={15} />
        </div>
        <label className="field-label volume-label">Volume <span>Lots</span></label>
        <Stepper value={volume} onChange={setVolume} label="Order volume" />
        <div className="optional-fields-heading"><span>Risk controls</span><span>Validated by server</span></div>
        <PriceField label={`Take Profit${Number(rules?.take_profit_required) === 1 ? " · Required" : ""}`} placeholder="Price level" value={takeProfit} onChange={setTakeProfit} />
        <PriceField label={`Stop Loss${Number(rules?.stop_loss_required) === 1 ? " · Required" : ""}`} placeholder="Price level" value={stopLoss} onChange={setStopLoss} />
        <button className={`one-click-row ${oneClick ? "one-click-enabled" : ""}`} type="button" role="switch" aria-checked={oneClick} onClick={() => setOneClick((current) => !current)}>
          <span><strong>One-Click Trading</strong><small>{oneClick ? "Executes without the review step" : "Review and confirm before sending"}</small></span><span className="switch-track"><span /></span>
        </button>
        <div className="order-preview">
          <div><span>{side === "BUY" ? "Ask" : "Bid"} · display only</span><strong>{quote?.stale || quoteSidePrice == null ? "--" : formatPrice(quoteSidePrice, digits)}</strong></div>
          <div><span>Bid</span><strong>{quote?.bid == null ? "--" : formatPrice(quote.bid, digits)}</strong></div>
          <div><span>Ask</span><strong>{quote?.ask == null ? "--" : formatPrice(quote.ask, digits)}</strong></div>
          <div><span>Volume</span><strong>{volume.toFixed(2)} lots</strong></div>
        </div>
        {rules && <div className="rule-summary">
          <span>Phase {rules.phase_number ?? account?.phase_number ?? "—"}</span>
          {rules.max_lot_size != null && <span>Max lot {rules.max_lot_size}</span>}
          {rules.max_open_positions != null && <span>Max positions {rules.max_open_positions}</span>}
        </div>}
        <div className="order-actions">
          {confirming && <div className="order-confirmation" role="group" aria-label="Confirm market order">
            <span>Confirm {side} {volume.toFixed(2)} {symbol} at the current server Ask/Bid? Price will be revalidated by the Worker.</span>
            <div><button type="button" onClick={() => setConfirming(false)} disabled={submitting}>Cancel</button><button type="button" onClick={submitOrder} disabled={submitting}>{submitting ? "Sending…" : "Confirm order"}</button></div>
          </div>}
          {!confirming && <button className={`submit-order submit-${side.toLowerCase()}`} type="button" onClick={startOrder} disabled={!canTrade || submitting || !symbol} title={canTrade ? "Send a server-validated market order" : "An approved active account is required"}>
            <span>{submitting ? "Sending order…" : `${oneClick ? "Execute" : "Review"} ${side} ${symbol || "market"}`}</span>
            <strong>{quote?.stale || quoteSidePrice == null ? "--" : formatPrice(quoteSidePrice, digits)}</strong>
          </button>}
          <span className="execution-note"><Shield size={13} /> Server sets the fill price and enforces account rules.</span>
        </div>
        {notice && <div className={`order-notice ${notice.includes("filled") ? "order-notice-success" : ""}`} role="status">{notice}</div>}
      </aside>
    </>
  );
}

function PriceField({ label, placeholder, value, onChange }) {
  return (
    <label className="price-field"><span>{label}</span><input type="number" min="0" step="any" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>
  );
}

function TradingPanel({ open, onToggle, positions, trades, loading, error, canTrade, onClosePosition }) {
  const [tab, setTab] = useState("Positions");
  const [closingId, setClosingId] = useState("");

  async function closePosition(position) {
    if (!window.confirm(`Close ${position.side} ${Number(position.volume).toFixed(2)} ${position.symbol} at the current market price?`)) return;
    setClosingId(position.id);
    try {
      await onClosePosition(position);
    } finally {
      setClosingId("");
    }
  }

  return (
    <section className={`trading-panel ${open ? "trading-panel-open" : "trading-panel-closed"}`}>
      <div className="trading-panel-header">
        <div className="trading-tabs" role="tablist" aria-label="Trading activity">
          {["Positions", "Orders", "History"].map((value) => {
            const count = value === "Positions" ? positions.length : value === "History" ? trades.length : null;
            return <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "trading-tab-active" : ""} onClick={() => setTab(value)}>{value}<span className="tab-count">{count ?? "—"}</span></button>;
          })}
        </div>
        <button className="collapse-button" type="button" onClick={onToggle} aria-label={open ? "Collapse activity panel" : "Expand activity panel"} title={open ? "Collapse panel" : "Expand panel"}>{open ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button>
      </div>
      {open && <div className="trading-content">
        {error && <div className="trading-alert" role="alert">{error}</div>}
        {tab === "Positions" && <>
          <div className="table-header position-grid">
            <span>SYMBOL</span><span>TYPE</span><span>VOLUME (LOTS)</span><span>OPEN PRICE</span>
            <span>CURRENT PRICE</span><span>T/P</span><span>S/L</span><span>P/L · USD</span><span>ACTION</span>
          </div>
          {positions.map((position) => <div className="position-row position-grid" key={position.id}>
            <strong className="position-symbol"><InstrumentMark symbol={position.symbol} />{position.symbol}</strong>
            <span className={`position-type ${position.side === "BUY" ? "direction-buy" : "direction-sell"}`}>
              <span aria-hidden="true" />{position.side === "BUY" ? "Buy" : "Sell"}
            </span>
            <span>{position.volume ?? "--"}</span>
            <span>{formatPrice(position.open_price, getPriceDigits(position.symbol))}</span>
            <span>{formatPrice(position.current_price, getPriceDigits(position.symbol))}</span>
            <span className={position.take_profit == null ? "protection-add" : "protection-value"} title={position.take_profit == null ? "Drag the TP chip on the chart to add take profit." : undefined}>
              {position.take_profit == null ? "Add" : formatPrice(position.take_profit, getPriceDigits(position.symbol))}
            </span>
            <span className={position.stop_loss == null ? "protection-add" : "protection-value"} title={position.stop_loss == null ? "Drag the SL chip on the chart to add stop loss." : undefined}>
              {position.stop_loss == null ? "Add" : formatPrice(position.stop_loss, getPriceDigits(position.symbol))}
            </span>
            <span className={`position-pnl ${Number(position.floating_pnl) >= 0 ? "position-pnl-positive" : "position-pnl-negative"}`}>
              {formatMoney(position.floating_pnl)}
            </span>
            <div className="position-actions">
              <button type="button" className="close-position-button" aria-label={`Close ${position.side} ${position.symbol} position`} onClick={() => closePosition(position)} disabled={!canTrade || closingId === position.id}>
                {closingId === position.id ? "Closing…" : "Close"}
              </button>
            </div>
          </div>)}
          {!loading && !positions.length && <div className="trading-empty"><span className="empty-table-icon"><PanelBottomClose size={18} /></span><strong>No open positions</strong><span>Positions will appear here after a server-accepted market order.</span></div>}
          {loading && !positions.length && <div className="trading-empty"><strong>Loading positions…</strong></div>}
        </>}
        {tab === "History" && <>
          <div className="table-header history-grid"><span>SYMBOL</span><span>DIRECTION</span><span>VOLUME</span><span>ENTRY</span><span>EXIT</span><span>REALIZED P&amp;L</span><span>OPENED</span><span>CLOSED</span><span>STATUS</span></div>
          {trades.map((trade) => <div className="position-row history-grid" key={trade.id}>
            <strong>{trade.symbol}</strong>
            <span>{trade.side === "BUY" ? "BUY / LONG" : "SELL / SHORT"}</span>
            <span>{trade.volume ?? "--"}</span>
            <span>{formatPrice(trade.open_price, getPriceDigits(trade.symbol))}</span>
            <span>{formatPrice(trade.close_price, getPriceDigits(trade.symbol))}</span>
            <span>{formatMoney(trade.realized_pnl)}</span>
            <span>{formatDate(trade.opened_at)}</span>
            <span>{formatDate(trade.closed_at)}</span>
            <span>Closed</span>
          </div>)}
          {!loading && !trades.length && <div className="trading-empty"><strong>No trade history</strong><span>Completed trades from this account will appear here.</span></div>}
        </>}
        {tab === "Orders" && <div className="trading-empty"><strong>Market order list unavailable</strong><span>The Worker currently exposes positions and completed trades, not a separate orders history route.</span></div>}
      </div>}
    </section>
  );
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "--";
}

function App() {
  const trading = useTradingSession();
  const liveTickHandler = useRef(null);
  const onAcceptedTick = useCallback(
    (tick) => trading.applyLiveTickToPositions(tick),
    [trading.applyLiveTickToPositions]
  );
  const { symbols, symbolState, symbolError, quotes, quoteErrors } = useMarketData(liveTickHandler, onAcceptedTick);
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
  const [actionError, setActionError] = useState("");
  const selected = symbols.find((item) => item.symbol === selectedSymbol) || null;
  const quote = quotes[selectedSymbol] || null;
  const quoteError = quoteErrors[selectedSymbol] || null;
  const {
    candles,
    state: candleState,
    error: candleError,
    dataKey: candleDataKey,
    loadingMore: candleHistoryLoading,
    hasMoreHistory: candleHasMoreHistory,
    loadOlderHistory,
  } = useCandles(selected ? selectedSymbol : "", interval);
  const liveOpenPnl = trading.positions
    .filter((position) => position.status === "open")
    .reduce((total, position) => {
      if (position.floating_pnl == null) return total;
      const value = Number(position.floating_pnl);
      return Number.isFinite(value) ? total + value : total;
    }, 0);
  const accountOpenPnl = Number(trading.account?.open_pnl);
  const livePnlDelta = Number.isFinite(accountOpenPnl)
    ? liveOpenPnl - accountOpenPnl
    : 0;
  const adjustAccountMetric = (value) => {
    if (value == null || !Number.isFinite(Number(value))) return value;
    return Number(value) + livePnlDelta;
  };
  const openPnl = trading.account ? liveOpenPnl : trading.selectedAccount?.open_pnl;
  const equity = adjustAccountMetric((trading.account || trading.selectedAccount)?.equity);
  const freeMargin = adjustAccountMetric(
    (trading.account || trading.selectedAccount)?.free_margin ??
    (trading.account || trading.selectedAccount)?.available_margin
  );

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

  async function executeOrder(order) {
    if (!trading.canTrade || !trading.selectedAccount) {
      throw new TradingRequestError("trading_disabled", 409);
    }
    const result = await getTradingJson("/trading/positions", trading.user, {
      method: "POST",
      body: JSON.stringify({
        account_id: trading.selectedAccount.id,
        ...order,
      }),
    });
    trading.addConfirmedPosition(result.position);
    setActionError("");
    trading.refresh();
  }

  async function closePosition(position) {
    if (!trading.canTrade || !trading.selectedAccount) return false;
    try {
      await getTradingJson("/trading/positions/close", trading.user, {
        method: "POST",
        body: JSON.stringify({ position_id: position.id }),
      });
      trading.removeClosedPosition(position.id);
      setActionError("");
      trading.refresh();
      return true;
    } catch (error) {
      setActionError(error.message || TRADING_ERROR_MESSAGES.server_error);
      return false;
    }
  }

  async function modifyPosition(position, changes) {
    if (!trading.canTrade || !trading.selectedAccount) {
      throw new TradingRequestError("trading_disabled", 409);
    }
    try {
      const result = await getTradingJson("/trading/positions/modify", trading.user, {
        method: "POST",
        body: JSON.stringify({
          position_id: position.id,
          ...changes,
        }),
      });
      if (result.position?.id !== position.id || result.position.status !== "open") {
        throw new TradingRequestError("server_response_invalid", 502);
      }
      trading.addConfirmedPosition(result.position);
      setActionError("");
      trading.refresh();
      return true;
    } catch (error) {
      setActionError(error.message || TRADING_ERROR_MESSAGES.server_error);
      throw error;
    }
  }

  const tradingError = actionError || trading.error ||
    (trading.authStatus === "signed-out" ? TRADING_ERROR_MESSAGES.authentication_required : "");

  if (trading.authStatus === "signed-out" || trading.authStatus === "unavailable") {
    return (
      <main className="auth-required-screen">
        <section className="auth-required-card">
          <h1>Please sign in to Daily Funded to trade</h1>
          <p>Your existing Daily Funded session will be used here.</p>
          <a href="/">Return to Daily Funded</a>
        </section>
      </main>
    );
  }

  return (
    <div className="terminal-shell">
      <TopBar
        symbol={selectedSymbol}
        selected={selected}
        quote={quote}
        quoteError={quoteError}
        watchOpen={watchOpen}
        onToggleWatch={() => setWatchOpen((current) => !current)}
        onToggleOrder={() => setOrderOpen(true)}
        account={trading.account || trading.selectedAccount}
        equity={equity}
        freeMargin={freeMargin}
        openPnl={openPnl}
        accounts={trading.accounts}
        accountsLoading={trading.accountsLoading}
        selectedAccountId={trading.selectedAccountId}
        onAccountChange={trading.setSelectedAccountId}
        authStatus={trading.authStatus}
        accountStatus={trading.account?.status || trading.selectedAccount?.status}
        selectedAccount={trading.selectedAccount}
      />
      <div className={`terminal-workspace ${watchCollapsed ? "workspace-watchlist-collapsed" : ""}`}>
        <Watchlist symbols={symbols} quotes={quotes} quoteErrors={quoteErrors} selectedSymbol={selectedSymbol} favorites={favorites} onSelect={selectSymbol} onFavorite={toggleFavorite} loading={symbolState === "loading"} error={symbolState === "error" ? symbolError : ""} collapsed={watchCollapsed} onToggleCollapse={() => setWatchCollapsed((current) => !current)} open={watchOpen} onClose={() => setWatchOpen(false)} />
        <main className="terminal-main">
          <ChartView
            symbol={selectedSymbol}
            selected={selected}
            quote={quote}
            quoteError={quoteError}
            candles={candles}
            candleDataKey={candleDataKey}
            state={selected ? candleState : symbolState === "loading" ? "loading" : "empty"}
            error={candleError || symbolError}
            loadingMore={candleHistoryLoading}
            hasMoreHistory={candleHasMoreHistory}
            loadOlderHistory={loadOlderHistory}
            interval={interval}
            onIntervalChange={setInterval}
            onOpenWatchlist={() => setWatchOpen(true)}
            liveTickHandler={liveTickHandler}
            positions={trading.positions}
            canTrade={trading.canTrade}
            onClosePosition={closePosition}
            onModifyPosition={modifyPosition}
          />
          <TradingPanel
            open={activityOpen}
            onToggle={() => setActivityOpen((current) => !current)}
            positions={trading.positions}
            trades={trading.trades}
            loading={trading.accountsLoading || trading.dataLoading || trading.authStatus === "loading"}
            error={tradingError}
            canTrade={trading.canTrade}
            onClosePosition={closePosition}
          />
        </main>
        <OrderPanel
          symbol={selectedSymbol}
          quote={quote}
          quoteError={quoteError}
          orderOpen={orderOpen}
          onClose={() => setOrderOpen(false)}
          account={trading.account}
          rules={trading.rules}
          canTrade={trading.canTrade}
          onExecute={executeOrder}
        />
      </div>
      <nav className="mobile-bottom-nav" aria-label="Terminal panels">
        <button type="button" onClick={() => setWatchOpen(true)}><Menu size={17} /><span>Markets</span></button>
        <button type="button" onClick={() => setActivityOpen((current) => !current)}><BarChart3 size={17} /><span>Activity</span></button>
        <button type="button" onClick={() => setOrderOpen(true)}><Activity size={17} /><span>Order</span></button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);