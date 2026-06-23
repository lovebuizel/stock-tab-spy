const DEFAULT_SYMBOLS = ["2330.TW", "NVDA"];

// ── TWSE Session ───────────────────────────────────────────────────────────
// 需先拜訪主頁取得 JSESSIONID cookie；每 5 分鐘強制重建
let twseSessionReady  = false;
let twseSessionExpiry = 0;

async function ensureTWSESession() {
  const now = Date.now();
  if (twseSessionReady && now < twseSessionExpiry) return;
  twseSessionReady = false;
  try {
    await fetch("https://mis.twse.com.tw/stock/", { credentials: "include", cache: "no-store" });
    twseSessionReady  = true;
    twseSessionExpiry = now + 5 * 60 * 1000;
  } catch {}
}

// ── 台股 10 秒快速更新 ────────────────────────────────────────────────────
let twTimer = null;

function startTWTimer() {
  if (twTimer) return;
  twTimer = setInterval(fetchTWOnly, 10_000);
}
function stopTWTimer() {
  if (twTimer) { clearInterval(twTimer); twTimer = null; }
}

async function fetchTWOnly() {
  const enabledTabs = await getEnabledTabs();
  if (!enabledTabs.length) { stopTWTimer(); return; }

  const { symbols = DEFAULT_SYMBOLS, stocks: existing = {} } =
    await chrome.storage.local.get(["symbols", "stocks"]);

  const twSymbols = symbols.filter((s) => s.endsWith(".TW"));
  if (!twSymbols.length) return;

  const results = await Promise.allSettled(twSymbols.map(fetchSymbol));
  const stocks = { ...existing };
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) stocks[twSymbols[i]] = r.value;
  });

  await chrome.storage.local.set({ stocks, lastUpdated: Date.now() });
  for (const tabId of enabledTabs) {
    chrome.tabs.sendMessage(tabId, { type: "stockUpdate", stocks, symbols }).catch(() => {});
  }
}

// ── 啟動 ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const { symbols } = await chrome.storage.local.get("symbols");
  if (!symbols) await chrome.storage.local.set({ symbols: DEFAULT_SYMBOLS });
  chrome.alarms.create("fetchStocks", { periodInMinutes: 1 });
  fetchAll();
});

chrome.runtime.onStartup.addListener(() => { fetchAll(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "fetchStocks") return;
  fetchAll();
  startTWTimer();
});

// ── 已啟用分頁管理 ────────────────────────────────────────────────────────
async function getEnabledTabs() {
  const { enabledTabs = [] } = await chrome.storage.session.get("enabledTabs");
  return enabledTabs;
}
async function setEnabledTabs(list) {
  await chrome.storage.session.set({ enabledTabs: list });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await getEnabledTabs();
  await setEnabledTabs(tabs.filter((id) => id !== tabId));
  await chrome.storage.session.remove(`tabSettings_${tabId}`);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const tabs = await getEnabledTabs();
  if (tabs.includes(tabId)) await setEnabledTabs(tabs.filter((id) => id !== tabId));
});

// ── 訊息處理 ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "isTabEnabled") {
    (async () => {
      const tabId = sender.tab?.id;
      const tabs  = await getEnabledTabs();
      const enabled = tabs.includes(tabId);
      let settings = { marqueeEnabled: true, singleSymbol: null };
      if (enabled && tabId) {
        const key    = `tabSettings_${tabId}`;
        const stored = await chrome.storage.session.get(key);
        settings = stored[key] ?? settings;
      }
      const { rotateSeconds = 3 } = await chrome.storage.local.get("rotateSeconds");
      sendResponse({ enabled, tabId, settings: { ...settings, rotateSeconds } });
    })();
    return true;
  }

  if (msg.type === "isTabEnabledById") {
    getEnabledTabs().then((tabs) =>
      sendResponse({ enabled: tabs.includes(msg.tabId) })
    );
    return true;
  }

  if (msg.type === "enableTab") {
    (async () => {
      const tabs = await getEnabledTabs();
      if (!tabs.includes(msg.tabId)) await setEnabledTabs([...tabs, msg.tabId]);

      const { stocks = {} } = await chrome.storage.local.get("stocks");
      const settingsKey = `tabSettings_${msg.tabId}`;
      const stored = await chrome.storage.session.get(settingsKey);
      const tabSettings = stored[settingsKey] ?? { marqueeEnabled: true, singleSymbol: null };
      const { rotateSeconds = 3 } = await chrome.storage.local.get("rotateSeconds");

      chrome.tabs.sendMessage(msg.tabId, {
        type: "tabEnabled", stocks, tabId: msg.tabId,
        settings: { ...tabSettings, rotateSeconds },
      }).catch(() => {});
      startTWTimer();
      fetchAll();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "disableTab") {
    (async () => {
      const tabs = await getEnabledTabs();
      await setEnabledTabs(tabs.filter((id) => id !== msg.tabId));
      chrome.tabs.sendMessage(msg.tabId, { type: "tabDisabled" }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "getStocks") {
    chrome.storage.local.get(["stocks", "symbols", "lastUpdated"], sendResponse);
    return true;
  }

  if (msg.type === "saveSymbols") {
    chrome.storage.local.set({ symbols: msg.symbols }, () => {
      fetchAll();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "saveOrder") {
    chrome.storage.local.set({ symbols: msg.symbols }, () => sendResponse({ ok: true }));
    return true;
  }
});

// ── 全量抓取（所有股票，1 分鐘一次）─────────────────────────────────────
async function fetchAll() {
  const enabledTabs = await getEnabledTabs();
  if (!enabledTabs.length) return;

  const { symbols = DEFAULT_SYMBOLS } = await chrome.storage.local.get("symbols");
  const results = await Promise.allSettled(symbols.map(fetchSymbol));

  const stocks = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) stocks[symbols[i]] = r.value;
  });

  await chrome.storage.local.set({ stocks, lastUpdated: Date.now() });
  for (const tabId of enabledTabs) {
    chrome.tabs.sendMessage(tabId, { type: "stockUpdate", stocks, symbols }).catch(() => {});
  }
}

// ── 主入口：台股用 TWSE，其他用 Yahoo ────────────────────────────────────
async function fetchSymbol(symbol) {
  const result = symbol.endsWith(".TW")
    ? await fetchTWStock(symbol)
    : await fetchYahooStock(symbol);

  if (result) {
    const { price, changePct, dayHigh, dayLow, sessionRatio, tradeTime, dataSource } = result;
    const arrow = changePct >= 0 ? "▲" : "▼";
    const time  = tradeTime ? `  @ ${tradeTime}` : "";
    console.log(
      `[StockTabSpy] ${symbol.padEnd(10)} ${price.toFixed(2).padStart(8)}` +
      `  ${arrow}${Math.abs(changePct).toFixed(2)}%` +
      `  H:${dayHigh?.toFixed(2) ?? "-"}  L:${dayLow?.toFixed(2) ?? "-"}` +
      `  session:${(sessionRatio * 100).toFixed(0)}%  src:${dataSource ?? "?"}${time}`
    );
  } else {
    console.warn(`[StockTabSpy] ${symbol} 取得失敗`);
  }
  return result;
}

// ── 台股：TWSE 即時價 + Yahoo 走勢圖 ─────────────────────────────────────
async function fetchTWStock(symbol) {
  const code = symbol.replace(".TW", "");
  const [twseRes, yahooRes] = await Promise.allSettled([
    fetchTWSEPrice(code),
    fetchYahooHistory(symbol),
  ]);
  const twse  = twseRes.status  === "fulfilled" ? twseRes.value  : null;
  const yahoo = yahooRes.status === "fulfilled" ? yahooRes.value : null;

  if (!twse) {
    const fallback = await fetchYahooStock(symbol);
    if (fallback) fallback.dataSource = "Yahoo(fallback)";
    return fallback;
  }

  // TWSE 中文名稱 → 自動寫入別名（若尚未設定）
  if (twse.stockName) {
    chrome.storage.local.get("aliases", ({ aliases = {} }) => {
      if (!aliases[symbol]) chrome.storage.local.set({ aliases: { ...aliases, [symbol]: twse.stockName } });
    });
  }

  let history = yahoo?.history ?? [];
  if (history.length < 2) {
    // Yahoo 尚無當日資料（開盤初期），用昨收→現價畫最簡基線
    history = [twse.prevClose ?? twse.price, twse.price];
  } else {
    history[history.length - 1] = twse.price;
  }

  return {
    symbol,
    price:        twse.price,
    change:       twse.change,
    changePct:    twse.changePct,
    prevClose:    twse.prevClose,
    dayHigh:      twse.dayHigh,
    dayLow:       twse.dayLow,
    tradeTime:    twse.tradeTime ?? null,
    dataSource:   "TWSE",
    history,
    sessionRatio: yahoo?.sessionRatio ?? 1,
  };
}

// ── TWSE MIS 即時報價（上市/上櫃自動偵測）───────────────────────────────
async function fetchTWSEPrice(code) {
  await ensureTWSESession();
  for (const ex of ["tse", "otc"]) {
    try {
      const url  = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code}.tw&json=1&delay=0`;
      const resp = await fetch(url, { cache: "no-store", credentials: "include" });
      if (!resp.ok) continue;
      const data = await resp.json();
      const msg  = data.msgArray?.[0];
      if (!msg) { twseSessionReady = false; continue; }

      // z = 最後成交價；為 "-" 時改用買一價（0.0000 = 市價單，須跳過）
      let price;
      if (msg.z && msg.z !== "-") {
        price = parseFloat(msg.z);
      } else {
        const firstBid = (msg.b ?? "").split("_").find((v) => v && v !== "-" && parseFloat(v) > 0);
        if (!firstBid) continue;
        price = parseFloat(firstBid);
      }

      const prevClose = msg.y && msg.y !== "-" && parseFloat(msg.y) > 0 ? parseFloat(msg.y) : NaN;
      if (isNaN(price) || isNaN(prevClose)) continue;

      const change    = price - prevClose;
      const changePct = (change / prevClose) * 100;
      const dayHigh   = msg.h && msg.h !== "-" ? parseFloat(msg.h) : price;
      const dayLow    = msg.l && msg.l !== "-" ? parseFloat(msg.l) : price;
      const tradeTime = (msg.d && msg.t && msg.t !== "-")
        ? `${msg.d.slice(0,4)}/${msg.d.slice(4,6)}/${msg.d.slice(6,8)} ${msg.t}`
        : null;
      const stockName = msg.n && msg.n !== "-" ? msg.n : null;

      return { price, prevClose, change, changePct, dayHigh, dayLow, tradeTime, stockName };
    } catch { continue; }
  }
  return null;
}

// ── Yahoo Finance：歷史走勢（台股用）────────────────────────────────────
async function fetchYahooHistory(symbol) {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data   = await resp.json();
    const result = data.chart.result[0];
    const closes = (result.indicators.quote[0].close ?? []).filter((v) => v != null);
    const session      = result.meta.currentTradingPeriod?.regular ?? null;
    const sessionRatio = calcSessionRatio(session);
    return { history: sampleArray(closes, 20), session, sessionRatio };
  } catch { return null; }
}

// ── Yahoo Finance：完整報價（美股 / TWSE fallback）───────────────────────
async function fetchYahooStock(symbol) {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(resp.statusText);
    const data   = await resp.json();
    const result = data.chart.result[0];
    const meta   = result.meta;
    const quote  = result.indicators.quote[0];

    const closes = quote.close.filter((v) => v != null);
    const highs  = quote.high.filter((v)  => v != null);
    const lows   = quote.low.filter((v)   => v != null);

    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? closes[0] ?? price;
    const change    = price - prevClose;
    const changePct = (change / prevClose) * 100;
    const dayHigh   = Math.max(...highs, price);
    const dayLow    = Math.min(...lows,  price);
    const session      = meta.currentTradingPeriod?.regular ?? null;
    const sessionRatio = calcSessionRatio(session);
    let history = sampleArray(closes, 20);
    if (history.length < 2) {
      // Yahoo 尚無當日 K 線（開盤初期），用昨收→現價畫最簡基線
      history = [prevClose, price];
    } else {
      history[history.length - 1] = price;
    }

    const tradeTime = meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toLocaleString("zh-TW", {
          timeZone: "Asia/Taipei",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false,
        })
      : null;

    return { symbol, price, change, changePct, prevClose, dayHigh, dayLow, history, sessionRatio, tradeTime, dataSource: "Yahoo" };
  } catch { return null; }
}

// ── 工具 ──────────────────────────────────────────────────────────────────
function calcSessionRatio(session) {
  if (!session) return 1;
  const now = Math.floor(Date.now() / 1000);
  if (now >= session.end)   return 1; // 已收盤
  if (now <  session.start) return 1; // 尚未開盤（回傳前一交易日完整資料）
  return (now - session.start) / (session.end - session.start);
}

function sampleArray(arr, maxLen) {
  if (!arr.length) return [];
  if (arr.length <= maxLen) return [...arr];
  const step = (arr.length - 1) / (maxLen - 1);
  return Array.from({ length: maxLen }, (_, i) => arr[Math.round(i * step)]);
}
