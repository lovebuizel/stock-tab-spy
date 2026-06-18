// ── 狀態 ──────────────────────────────────────────────────────────────────
let stocks  = {};
let symbols = [];
let active  = false;
let myTabId = null;
let aliases = {};

// 目前套用的顯示模式（stockUpdate 時直接用，不需重讀 storage）
let _marqueeEnabled = true;
let _singleSymbol   = null;

// 啟動時讀一次別名
try {
  chrome.storage.local.get("aliases", (result) => {
    if (chrome.runtime.lastError) return;
    aliases = result?.aliases ?? {};
  });
} catch {}

// 別名更新 → 立即刷新顯示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.aliases) return;
  aliases = changes.aliases.newValue ?? {};
  if (active) refreshDisplay();
});

const originalTitle   = document.title;
const originalFavicon = document.querySelector("link[rel*='icon']")?.href ?? null;

// 輪播
let rotateTimer = null;
let rotateIndex = 0;
let rotateMsec  = 3000;

// Favicon
const faviconUrls     = {};
let currentFaviconSym = null;
let faviconLink       = null;
let faviconRefreshId  = null;
let headObserver      = null;
let faviconGuard      = false;

// Title 保護
let titleEl       = null;
let titleObserver = null;
let pendingTitle  = "";

// ── 初始化：詢問 background 是否已啟用 ───────────────────────────────────
chrome.runtime.sendMessage({ type: "isTabEnabled" }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.enabled) {
    myTabId = res.tabId;
    start(res.settings);
  }
});

// ── 接收 background 訊息 ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "tabEnabled") {
    myTabId = msg.tabId;
    stocks  = msg.stocks ?? {};
    symbols = Object.keys(stocks);
    start(msg.settings);
  }
  if (msg.type === "tabDisabled") {
    stop();
  }
  if (msg.type === "applySettings" && active) {
    applySettings(msg.settings ?? {});
  }
  if (msg.type === "stockUpdate" && active) {
    stocks  = msg.stocks;
    // 使用 background 傳來的順序；沒有時 fallback 到 Object.keys
    if (msg.symbols?.length) symbols = msg.symbols;
    else symbols = Object.keys(stocks);
    preRenderFavicons().then(() => {
      currentFaviconSym = null;
      refreshDisplayUpdate(); // 更新資料，但不重設輪播計時器
    });
  }
});

// ── 啟動 / 停用 ───────────────────────────────────────────────────────────
async function start(settings) {
  if (active) return;
  active = true;
  await preRenderFavicons();
  setupFaviconProtection();
  applySettings(settings ?? {});
}

function stop() {
  active = false;
  stopRotate();
  stopFaviconRefresh();
  if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
  if (headObserver)  { headObserver.disconnect();  headObserver  = null; }
  pendingTitle = "";
  document.title = originalTitle;
  if (faviconLink) { faviconLink.remove(); faviconLink = null; }
  if (originalFavicon) {
    const link = document.createElement("link");
    link.rel = "icon"; link.href = originalFavicon;
    document.head.appendChild(link);
  }
  currentFaviconSym = null;
}

// ── 設定 ──────────────────────────────────────────────────────────────────
function applySettings(s) {
  if (!active) return;
  _marqueeEnabled = s.marqueeEnabled !== false;
  _singleSymbol   = s.singleSymbol ?? symbols[0] ?? null;
  rotateMsec      = Math.max(1, s.rotateSeconds ?? 3) * 1000;
  setupTitleProtection();
  refreshDisplay();
}

function refreshDisplay() {
  if (!active) return;
  if (_marqueeEnabled) {
    stopFaviconRefresh();
    startRotate(); // 設定變更時完整重啟
  } else {
    stopRotate();
    setTitle(buildTitle(_singleSymbol));
    swapFavicon(_singleSymbol);
    startFaviconRefresh(_singleSymbol);
  }
}

// 資料更新時用：保留現有計時器，只刷新當前畫面
function refreshDisplayUpdate() {
  if (!active) return;
  if (_marqueeEnabled) {
    stopFaviconRefresh();
    if (rotateTimer) {
      showCurrent(); // 計時器繼續跑，只更新當前那筆的顯示
    } else {
      startRotate(); // 計時器不存在才重啟
    }
  } else {
    setTitle(buildTitle(_singleSymbol));
    swapFavicon(_singleSymbol);
  }
}

// ── 輪播 ──────────────────────────────────────────────────────────────────
function startRotate() {
  stopRotate();
  if (!symbols.length) return;
  rotateIndex = 0;
  showCurrent();
  rotateTimer = setInterval(() => {
    rotateIndex = (rotateIndex + 1) % symbols.filter((s) => stocks[s]).length;
    showCurrent();
  }, rotateMsec);
}

function showCurrent() {
  const valid = symbols.filter((s) => stocks[s]);
  if (!valid.length) return;
  const sym = valid[rotateIndex % valid.length];
  setTitle(buildTitle(sym));
  currentFaviconSym = null; // 強制重插，對抗頁面覆蓋
  swapFavicon(sym);
}

function stopRotate() {
  if (rotateTimer !== null) { clearInterval(rotateTimer); rotateTimer = null; }
}

// ── Title ─────────────────────────────────────────────────────────────────
function buildTitle(sym) {
  if (!sym || !stocks[sym]) return "";
  const { price, changePct } = stocks[sym];
  const arrow = changePct >= 0 ? "▲" : "▼";
  const name  = aliases[sym] || sym.replace(".TW", "");
  return `${name} ${price.toFixed(2)} ${arrow}${Math.abs(changePct).toFixed(2)}%`;
}

function setupTitleProtection() {
  if (titleObserver) return;
  titleEl = document.querySelector("title");
  if (!titleEl) { titleEl = document.createElement("title"); document.head.appendChild(titleEl); }
  let ignoreNext = false;
  titleObserver = new MutationObserver(() => {
    if (ignoreNext) { ignoreNext = false; return; }
    if (pendingTitle) { ignoreNext = true; titleEl.textContent = pendingTitle; }
  });
  titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
}

function setTitle(text) {
  pendingTitle = text;
  if (titleEl) titleEl.textContent = text;
  else document.title = text;
}

// ── Favicon ───────────────────────────────────────────────────────────────
function preRenderFavicons() {
  return Promise.all(
    symbols.filter((s) => stocks[s]).map((sym) =>
      renderFaviconBlob(sym).then((url) => {
        if (faviconUrls[sym]) URL.revokeObjectURL(faviconUrls[sym]);
        faviconUrls[sym] = url;
      })
    )
  );
}

function renderFaviconBlob(sym) {
  return new Promise((resolve) => {
    const stock = stocks[sym] ?? {};
    const { history, changePct, sessionRatio = 1 } = stock;
    if (!history || history.length < 2) { resolve(null); return; }

    const SIZE = 32;
    const cv   = document.createElement("canvas");
    cv.width = cv.height = SIZE;
    const ctx = cv.getContext("2d");
    const PAD = 3, W = SIZE - PAD * 2, H = SIZE - PAD * 2;

    let minP, maxP;
    if (stock.dayHigh != null && stock.dayLow != null && stock.dayHigh > stock.dayLow) {
      const pad = (stock.dayHigh - stock.dayLow) * 0.08;
      minP = stock.dayLow  - pad;
      maxP = stock.dayHigh + pad;
    } else {
      minP = Math.min(...history);
      maxP = Math.max(...history);
    }
    const range = maxP - minP || 1;
    const lineW = sessionRatio * W;
    const color = changePct >= 0 ? "#ef4444" : "#22c55e";

    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.8;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    history.forEach((p, i) => {
      const x = PAD + (i / (history.length - 1)) * lineW;
      const y = PAD + H - ((p - minP) / range) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    const lx = PAD + lineW;
    const ly = PAD + H - ((history[history.length - 1] - minP) / range) * H;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fill();

    cv.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/png");
  });
}

function swapFavicon(sym) {
  if (!sym) return;
  const url = faviconUrls[sym];
  if (!url) return;

  // faviconLink 若被頁面 JS 移除則重建
  if (faviconLink && !document.head.contains(faviconLink)) {
    faviconLink = null;
    currentFaviconSym = null;
  }

  if (!faviconLink) {
    faviconGuard = true;
    document.querySelectorAll("link[rel*='icon']").forEach((l) => l.remove());
    faviconLink = document.createElement("link");
    faviconLink.rel = "icon"; faviconLink.type = "image/png";
    document.head.appendChild(faviconLink);
    faviconGuard = false;
  }

  if (sym === currentFaviconSym) return;
  faviconGuard = true;
  faviconLink.href = url;
  faviconGuard = false;
  currentFaviconSym = sym;
}

// 監控 <head>，阻止網站插入 favicon 覆蓋我們的
function setupFaviconProtection() {
  if (headObserver) return;
  headObserver = new MutationObserver((mutations) => {
    if (faviconGuard || !active || !currentFaviconSym) return;
    let intruder = false;
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1 || node === faviconLink) continue;
        if (/icon/i.test(node.getAttribute?.("rel") ?? "")) {
          faviconGuard = true; node.remove(); faviconGuard = false;
          intruder = true;
        }
      }
    }
    if (intruder) {
      faviconGuard = true;
      document.head.appendChild(faviconLink); // 移到最後（瀏覽器用最後一個 icon）
      faviconGuard = false;
    }
  });
  headObserver.observe(document.head, { childList: true });
}

function startFaviconRefresh(sym) {
  stopFaviconRefresh();
  faviconRefreshId = setInterval(() => {
    currentFaviconSym = null; // 強制重插
    swapFavicon(sym);
  }, 10_000);
}
function stopFaviconRefresh() {
  if (faviconRefreshId !== null) { clearInterval(faviconRefreshId); faviconRefreshId = null; }
}
