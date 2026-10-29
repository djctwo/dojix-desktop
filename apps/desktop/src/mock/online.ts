// The online commands of docs/ONLINE.md in the mock IPC: same names, arguments, results and error
// codes as the shell, over fictional data and no network. They let Pulse, Browse/Watchlist,
// Settings → online sections and the AI card be built in a plain browser.
//
// Defaults match the app (AI off, no live source, Finnhub off, calendar on, no keys); the mock
// URL parameter `?online=on` starts with everything switched on and every key stored.

import type {
  AiReport,
  BrandId,
  CalendarWeek,
  EconomicEvent,
  OnlineSettingsView,
  PriceTick,
  QuotesStatus,
  SecretAccount,
  StreamStatus,
  TestProvider,
} from "@dojix-desktop/core";
import { DOJIX_SECRET_ACCOUNTS, GREENWICK_SECRET_ACCOUNTS } from "@dojix-desktop/core";
import type { CallArgs, CommandName, EventName, Events, ResultOf } from "../ipc/contract";

export type OnlineHandlers = { [K in CommandName]?: (args: CallArgs<K>[0]) => ResultOf<K> };

export interface OnlineMockContext {
  brand: BrandId;
  now: number;
  /** Start with every switch on and every key stored (`?online=on`). */
  enabled: boolean;
  /** Throws `{ code: "locked" }` unless the journal is unlocked. */
  requireUnlocked: () => void;
  emit: <E extends EventName>(event: E, payload: Events[E]) => void;
}

const fail = (code: string, message: string): never => {
  throw { code, message };
};

/** FNV-1a as hex: a stand-in for the shell's SHA-256 (the mock has no sync crypto). */
export function mockDigest(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `mock-${h.toString(16).padStart(8, "0")}`;
}

/** A fictional price for a symbol, stable per symbol. */
export function mockPrice(symbol: string): number {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return /^[A-Z]{3}\/?[A-Z]{3}$/.test(symbol) ? 0.6 + (h % 9000) / 10000 : 20 + (h % 40000) / 100;
}

const PROVIDER_ACCOUNT: Readonly<Record<TestProvider, SecretAccount | null>> = {
  anthropic: "anthropic_api_key",
  twelve_data: "twelve_data_api_key",
  polygon: "polygon_api_key",
  oanda_stream: "oanda_api_token",
  oanda_import: "oanda_api_token",
  finnhub: "finnhub_api_key",
  mt5_file: null,
};

export function createOnlineHandlers(ctx: OnlineMockContext): OnlineHandlers {
  const accounts = ctx.brand === "dojix" ? DOJIX_SECRET_ACCOUNTS : GREENWICK_SECRET_ACCOUNTS;
  const stored = new Set<SecretAccount>(ctx.enabled ? accounts : []);
  const defaultModel = ctx.brand === "dojix" ? "claude-opus-5-5" : "claude-sonnet-5-5";
  let settings: Omit<OnlineSettingsView, "keys"> = {
    brand: ctx.brand,
    aiEnabled: ctx.enabled,
    aiModel: defaultModel,
    aiDefaultModel: defaultModel,
    aiConsented: false,
    liveSource: ctx.enabled && ctx.brand === "dojix" ? "twelve_data_rest" : "off",
    oandaLive: false,
    finnhubEnabled: ctx.enabled && ctx.brand === "greenwick",
    calendarEnabled: true,
    calendarSource: "Fictional calendar (mock)",
    oandaImportDays: 90,
    keyringAvailable: true,
  };
  const view = (): OnlineSettingsView => ({
    ...settings,
    keys: Object.fromEntries(accounts.map((a) => [a, stored.has(a)])),
  });
  let reports: AiReport[] = [];
  let quotes: { symbols: string[]; status: StreamStatus; latest: PriceTick[] } = {
    symbols: [],
    status: { state: "disconnected" },
    latest: [],
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let step = 0;

  const tick = (symbol: string): PriceTick => {
    const mid = mockPrice(symbol) * (1 + Math.sin(step / 3 + symbol.length) / 1000);
    const spread = mid < 10 ? 0.0001 : 0.02;
    return {
      symbol,
      bid: mid - spread / 2,
      ask: mid + spread / 2,
      mid,
      spread,
      timestampMs: ctx.now + step * 2000,
      changePercent: Math.round(Math.sin(symbol.charCodeAt(0) + step) * 80) / 100,
    };
  };
  const status = (): QuotesStatus => ({
    source: settings.liveSource,
    sourceLabel: settings.liveSource === "off" ? "Off" : "Fictional prices (mock)",
    symbols: quotes.symbols,
    status: quotes.status,
    latest: quotes.latest,
    creditsLeftToday: 800,
  });
  const stopStream = () => {
    if (timer) clearInterval(timer);
    timer = null;
    quotes = { symbols: [], status: { state: "disconnected" }, latest: [] };
  };
  const needFinnhub = () => {
    if (ctx.brand !== "greenwick") fail("unsupported", "Finnhub is part of Greenwick.");
    if (!settings.finnhubEnabled) fail("off", "Live quotes are switched off in Settings.");
    if (!stored.has("finnhub_api_key")) fail("no_key", "Add your Finnhub key in Settings.");
  };
  const online = <A, R>(f: (args: A) => R) => (args: A): R => {
    ctx.requireUnlocked();
    return f(args);
  };

  const handlers: OnlineHandlers = {
    online_settings_get: online(() => view()),
    online_settings_set: online(({ patch }) => {
      if (patch.liveSource !== undefined && patch.liveSource !== settings.liveSource) stopStream();
      const { aiModel, ...rest } = patch;
      settings = {
        ...settings,
        ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
        ...(aiModel !== undefined ? { aiModel: aiModel === "" ? defaultModel : aiModel } : {}),
      };
      return view();
    }),
    set_secret: online(({ account, value }) => {
      if (!accounts.includes(account)) fail("invalid", "That key isn't used by this app.");
      if (!/^[\x21-\x7e]{1,512}$/.test(value.trim())) fail("invalid", "The key has characters a key can't contain.");
      stored.add(account);
      return null;
    }),
    has_secret: online(({ account }) => stored.has(account)),
    delete_secret: online(({ account }) => {
      stored.delete(account);
      return null;
    }),
    test_connection: online(({ provider }) => {
      const account = PROVIDER_ACCOUNT[provider];
      if (account !== null && !stored.has(account)) return { ok: false, message: "No key is stored for this provider." };
      return { ok: true, message: "Connected (fictional mock response)." };
    }),
    ai_models: online(() => [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
    ]),
    ai_preview: online(({ prompt }) => {
      const body = JSON.stringify({ model: settings.aiModel, max_tokens: 16000, messages: [{ role: "user", content: prompt }] });
      return {
        endpoint: "https://api.anthropic.com/v1/messages",
        model: settings.aiModel,
        headers: [
          ["x-api-key", "•••• (your stored key)"],
          ["anthropic-version", "2023-06-01"],
          ["content-type", "application/json"],
        ],
        body,
        bodyPretty: JSON.stringify(JSON.parse(body), null, 2),
        requestSha256: mockDigest(body),
        byteCount: new TextEncoder().encode(body).length,
      };
    }),
    ai_run: online(({ prompt, requestSha256, consent }) => {
      if (!settings.aiEnabled) fail("off", "AI analysis is switched off in Settings.");
      if (!stored.has("anthropic_api_key")) fail("no_key", "Add your Anthropic key in Settings.");
      const body = JSON.stringify({ model: settings.aiModel, max_tokens: 16000, messages: [{ role: "user", content: prompt }] });
      if (mockDigest(body) !== requestSha256) fail("preview_mismatch", "The request changed since the preview. Preview it again.");
      if (!settings.aiConsented && !consent) fail("consent_required", "Confirm what is sent before the first run.");
      settings = { ...settings, aiConsented: true };
      const report: AiReport = {
        id: reports.length + 1,
        createdAt: new Date(ctx.now).toISOString().replace("T", " ").replace("Z", ""),
        model: settings.aiModel,
        requestSha256,
        requestPreview: body,
        responseText:
          "## Fictional analysis (mock)\n\nThis text comes from the mock IPC, not from a model.\n\n- Your best session is the one with the highest expectancy.\n- Consider cutting the hours where you lose most.",
        inputTokens: Math.ceil(body.length / 4),
        outputTokens: 120,
      };
      reports = [report, ...reports];
      return report;
    }),
    ai_reports_list: online(({ limit }) => reports.slice(0, Math.max(0, Math.min(limit, 500)))),
    ai_report_delete: online(({ id }) => {
      reports = reports.filter((r) => r.id !== id);
      return null;
    }),
    quotes_start: online(({ symbols }) => {
      if (ctx.brand !== "dojix") fail("unsupported", "Live prices are part of Dojix.");
      if (settings.liveSource === "off") fail("off", "Pick a live price source in Settings.");
      stopStream();
      const normalised = symbols.slice(0, 32).map((s) => (s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3, 6)}`));
      quotes = { symbols: normalised, status: { state: "connected" }, latest: normalised.map(tick) };
      ctx.emit("quote_status", quotes.status);
      timer = setInterval(() => {
        step += 1;
        quotes = { ...quotes, latest: quotes.symbols.map(tick) };
        for (const t of quotes.latest) ctx.emit("quote_tick", t);
      }, 2000);
      return status();
    }),
    quotes_stop: online(() => {
      stopStream();
      ctx.emit("quote_status", { state: "disconnected" });
      return null;
    }),
    quotes_status: online(() => status()),
    calendar_week: online((): CalendarWeek => {
      if (!settings.calendarEnabled) fail("off", "The economic calendar is switched off in Settings.");
      const day = 86_400_000;
      const monday = ctx.now - (((new Date(ctx.now).getUTCDay() + 6) % 7) * day) - (ctx.now % day);
      const at = (d: number, h: number) => monday + d * day + h * 3_600_000;
      const events: EconomicEvent[] = [
        { title: "Fictional Jobs Report", country: "USD", timeMs: at(4, 12.5), impact: "high", forecast: "180K", previous: "165K" },
        { title: "Fictional Rate Decision", country: "EUR", timeMs: at(3, 12.25), impact: "high", forecast: "3.25%", previous: "3.25%" },
        { title: "Fictional Retail Sales", country: "GBP", timeMs: at(1, 6), impact: "medium", actual: "0.4%", forecast: "0.3%", previous: "0.1%" },
        { title: "Fictional Trade Balance", country: "JPY", timeMs: at(2, 23.5), impact: "low" },
      ];
      return { events, fetchedAtMs: ctx.now, source: settings.calendarSource, stale: false };
    }),
    finnhub_quote: online(({ symbol }) => {
      needFinnhub();
      const price = mockPrice(symbol);
      return {
        symbol,
        currentPrice: price,
        change: price * 0.012,
        percentChange: 1.2,
        high: price * 1.02,
        low: price * 0.98,
        open: price * 0.99,
        previousClose: price / 1.012,
        timestamp: Math.floor(ctx.now / 1000),
      };
    }),
    finnhub_profile: online(({ symbol }) => {
      needFinnhub();
      return {
        name: `${symbol} Fictional Corp.`,
        ticker: symbol,
        exchange: "FICTIONAL EXCHANGE",
        industry: "Software",
        marketCap: 12_345,
        sharesOutstanding: 321,
        ipo: "2010-01-04",
        country: "US",
      };
    }),
    finnhub_search: online(({ query }) => {
      needFinnhub();
      const q = query.trim().toUpperCase();
      if (q === "") return [];
      return ["FIXA", "FIXB", "FIXC", "FIXD", "FIXE", "FIX.B"]
        .filter((s) => s.includes(q))
        .slice(0, 10)
        .map((s) => ({ description: `${s} Fictional Corp.`, displaySymbol: s, symbol: s, type: "Common Stock" }));
    }),
    oanda_fetch_history: online(({ days }) => {
      if (ctx.brand !== "dojix") fail("unsupported", "OANDA import is part of Dojix.");
      if (!stored.has("oanda_api_token") || !stored.has("oanda_account_id")) fail("no_key", "Add your OANDA token and account ID in Settings.");
      const n = days ?? settings.oandaImportDays;
      return { transactions: [], pages: 0, from: new Date(ctx.now - n * 86_400_000).toISOString() };
    }),
  };
  return handlers;
}
