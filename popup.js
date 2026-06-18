// ── DOM refs ──────────────────────────────────────────────────────────────
const toggleTab      = document.getElementById("toggle-tab");
const tabHint        = document.getElementById("tab-hint");
const disabledHint   = document.getElementById("disabled-hint");
const mainBody       = document.getElementById("main-body");

const statusBar      = document.getElementById("status-bar");
const toggleMarq     = document.getElementById("toggle-marquee");
const marqueeHint    = document.getElementById("marquee-hint");
const rotateSec      = document.getElementById("rotate-section");
const inputRotateSec = document.getElementById("input-rotate-sec");
const singleSec      = document.getElementById("single-section");
const singleSelect   = document.getElementById("single-select");
const stockList      = document.getElementById("stock-list");
const inputSymbol    = document.getElementById("input-symbol");
const btnAdd         = document.getElementById("btn-add");

const MIN_SEC = 1;

let currentTabId   = null;
let tabEnabled     = false;
let symbols        = [];
let stocks         = {};
let aliases        = {}; // { "2330.TW": "台積電", ... }
let marqueeEnabled = true;
let singleSymbol   = "";
let rotateSeconds  = 3;

// ── 初始化 ────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  // 查詢這個分頁是否已啟用
  chrome.runtime.sendMessage({ type: "isTabEnabledById", tabId: currentTabId }, (res) => {
    tabEnabled = res?.enabled ?? false;
    toggleTab.checked = tabEnabled;
    renderTabState();
    if (tabEnabled) loadStocks();
  });
}

// ── 分頁啟用狀態 UI ───────────────────────────────────────────────────────
function renderTabState() {
  if (tabEnabled) {
    tabHint.textContent  = "已啟用";
    disabledHint.style.display = "none";
    mainBody.classList.add("visible");
  } else {
    tabHint.textContent  = "目前未啟用";
    disabledHint.style.display = "block";
    mainBody.classList.remove("visible");
  }
}

toggleTab.addEventListener("change", () => {
  tabEnabled = toggleTab.checked;
  renderTabState();

  const type = tabEnabled ? "enableTab" : "disableTab";
  chrome.runtime.sendMessage({ type, tabId: currentTabId }, () => {
    if (tabEnabled) loadStocks();
  });
});

// ── 載入股票資料 + 該分頁自己的設定 ─────────────────────────────────────
function loadStocks() {
  chrome.runtime.sendMessage({ type: "getStocks" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusBar.textContent = "⚠ 無法取得資料";
      return;
    }
    stocks  = res.stocks  ?? {};
    symbols = res.symbols ?? Object.keys(stocks);

    const settingsKey = `tabSettings_${currentTabId}`;
    chrome.storage.session.get(settingsKey, (sessionStored) => {
      // rotateSeconds 存 local（全域共用、持久）
      chrome.storage.local.get(["rotateSeconds", "aliases"], (localStored) => {
        const tabSettings    = sessionStored[settingsKey] ?? {};
        marqueeEnabled       = tabSettings.marqueeEnabled !== false;
        singleSymbol         = tabSettings.singleSymbol ?? symbols[0] ?? "";
        rotateSeconds        = localStored.rotateSeconds ?? 3;
        aliases              = localStored.aliases ?? {};
        toggleMarq.checked   = marqueeEnabled;
        inputRotateSec.value = rotateSeconds;
        renderAll();

        if (res.lastUpdated) {
          statusBar.textContent = `最後更新：${new Date(res.lastUpdated).toLocaleTimeString("zh-TW")}`;
        } else {
          statusBar.textContent = "資料更新中…";
        }
      });
    });
  });
}

// ── 渲染主體 UI ───────────────────────────────────────────────────────────
function renderAll() {
  renderList();
  renderSingleSelect();
  renderMarqueeToggle();
}

function renderMarqueeToggle() {
  if (marqueeEnabled) {
    rotateSec.style.display  = "flex";
    singleSec.style.display  = "none";
    marqueeHint.textContent  = "全部輪播";
  } else {
    rotateSec.style.display  = "none";
    singleSec.style.display  = "block";
    marqueeHint.textContent  = "靜態顯示";
  }
}

function renderList() {
  stockList.innerHTML = "";
  if (!symbols.length) {
    stockList.innerHTML = '<div class="stock-row loading">尚無自選股，請新增</div>';
    return;
  }
  symbols.forEach((sym) => {
    const s   = stocks[sym];
    const row = document.createElement("div");
    row.className = "stock-row";

    let priceText = "—", changeText = "—", cls = "flat";
    if (s) {
      priceText  = s.price.toFixed(2);
      const arrow = s.changePct >= 0 ? "▲" : "▼";
      changeText = `${arrow}${Math.abs(s.changePct).toFixed(2)}%`;
      cls = s.changePct > 0 ? "up" : s.changePct < 0 ? "down" : "flat";
    }

    const aliasVal = aliases[sym] ?? "";
    const code     = sym.replace(".TW", "");

    row.draggable = true;
    row.dataset.sym = sym;
    row.innerHTML = `
      <span class="drag-handle" title="拖拉排序">⠿</span>
      <div class="sym-group">
        <span class="sym-code">${code}</span>
        <input class="alias-input" type="text"
               value="${aliasVal}" placeholder="${code}"
               maxlength="12" data-sym="${sym}" title="點擊設定別名" />
      </div>
      <span class="price ${cls}">${priceText}</span>
      <span class="change ${cls}">${changeText}</span>
      <button class="btn-remove" data-sym="${sym}" title="移除">✕</button>
    `;
    stockList.appendChild(row);
  });

  // 別名儲存：blur 或 Enter
  stockList.querySelectorAll(".alias-input").forEach((input) => {
    const save = () => saveAlias(input.dataset.sym, input.value.trim());
    input.addEventListener("blur",    save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { save(); input.blur(); } });
  });

  stockList.querySelectorAll(".btn-remove").forEach((btn) =>
    btn.addEventListener("click", () => removeSymbol(btn.dataset.sym))
  );

  // ── 拖拉排序 ──────────────────────────────────────────────────────────────
  let dragSym = null;
  let autoScrollTimer = null;

  function stopAutoScroll() {
    if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; }
  }
  document.addEventListener("dragend", stopAutoScroll);
  document.addEventListener("drop",    stopAutoScroll);

  // dragenter 也要 preventDefault，否則進入元素的瞬間會閃禁止圖示
  stockList.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  // 拖曳在 stockList 上移動時，靠近上下邊緣就自動滾動（越靠邊越快）
  stockList.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = stockList.getBoundingClientRect();
    const threshold = 40;
    const distBottom = rect.bottom - e.clientY;
    const distTop    = e.clientY - rect.top;
    if (distBottom < threshold) {
      const speed = Math.ceil((1 - distBottom / threshold) * 6); // 1~6 px
      stopAutoScroll();
      autoScrollTimer = setInterval(() => { stockList.scrollTop += speed; }, 40);
    } else if (distTop < threshold) {
      const speed = Math.ceil((1 - distTop / threshold) * 6);
      stopAutoScroll();
      autoScrollTimer = setInterval(() => { stockList.scrollTop -= speed; }, 40);
    } else {
      stopAutoScroll();
    }
  });
  stockList.addEventListener("dragleave", stopAutoScroll);

  stockList.querySelectorAll(".stock-row").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragSym = row.dataset.sym;
      row.classList.add("dragging");
      stockList.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      stopAutoScroll();
      stockList.classList.remove("is-dragging");
      row.classList.remove("dragging");
      stockList.querySelectorAll(".stock-row").forEach((r) => r.classList.remove("drag-over"));
    });
    row.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      stockList.querySelectorAll(".stock-row").forEach((r) => r.classList.remove("drag-over"));
      if (row.dataset.sym !== dragSym) row.classList.add("drag-over");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      stopAutoScroll();
      stockList.classList.remove("is-dragging");
      row.classList.remove("drag-over");
      if (!dragSym || dragSym === row.dataset.sym) return;
      const fromIdx = symbols.indexOf(dragSym);
      const toIdx   = symbols.indexOf(row.dataset.sym);
      if (fromIdx < 0 || toIdx < 0) return;
      symbols.splice(fromIdx, 1);
      symbols.splice(toIdx, 0, dragSym);
      renderAll();
      chrome.runtime.sendMessage({ type: "saveOrder", symbols });
    });
  });
}

function saveAlias(sym, value) {
  if (value) aliases[sym] = value;
  else delete aliases[sym];
  chrome.storage.local.set({ aliases });
}

function renderSingleSelect() {
  singleSelect.innerHTML = "";
  symbols.forEach((sym) => {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = aliases[sym] ? `${sym} (${aliases[sym]})` : sym;
    if (sym === singleSymbol) opt.selected = true;
    singleSelect.appendChild(opt);
  });
}

// ── 儲存設定並推給 content script ────────────────────────────────────────
function saveTabSettings() {
  // per-tab 設定（session）
  const tabSettings = { marqueeEnabled, singleSymbol };
  chrome.storage.session.set({ [`tabSettings_${currentTabId}`]: tabSettings });
  // rotateSeconds 全域共用（local，持久）
  chrome.storage.local.set({ rotateSeconds });
  // 直接推給 content script
  chrome.tabs.sendMessage(currentTabId, {
    type: "applySettings",
    settings: { ...tabSettings, rotateSeconds },
  }).catch(() => {});
}

toggleMarq.addEventListener("change", () => {
  marqueeEnabled = toggleMarq.checked;
  renderMarqueeToggle();
  saveTabSettings();
});

singleSelect.addEventListener("change", () => {
  singleSymbol = singleSelect.value;
  saveTabSettings();
});

inputRotateSec.addEventListener("change", () => {
  const val = parseInt(inputRotateSec.value, 10);
  rotateSeconds = Math.max(MIN_SEC, isNaN(val) ? 3 : val);
  inputRotateSec.value = rotateSeconds; // 若低於最小值，自動修正顯示
  saveTabSettings();
});

// ── 新增 / 移除股票 ───────────────────────────────────────────────────────
function addSymbol() {
  const val = inputSymbol.value.trim().toUpperCase();
  if (!val) return;
  if (symbols.includes(val)) { statusBar.textContent = `${val} 已在清單中`; return; }
  symbols.push(val);
  inputSymbol.value = "";
  saveSymbols();
}

function removeSymbol(sym) {
  symbols = symbols.filter((s) => s !== sym);
  if (singleSymbol === sym) singleSymbol = symbols[0] ?? "";
  saveSymbols();
}

function saveSymbols() {
  statusBar.textContent = "更新中…";
  chrome.runtime.sendMessage({ type: "saveSymbols", symbols }, () => {
    setTimeout(loadStocks, 1500);
  });
}

btnAdd.addEventListener("click", addSymbol);
inputSymbol.addEventListener("keydown", (e) => { if (e.key === "Enter") addSymbol(); });

// ── 匯出設定 ──────────────────────────────────────────────────────────────
document.getElementById("btn-export").addEventListener("click", () => {
  chrome.storage.local.get(["symbols", "aliases", "rotateSeconds"], (data) => {
    const payload = {
      version:       1,
      symbols:       data.symbols       ?? [],
      aliases:       data.aliases       ?? {},
      rotateSeconds: data.rotateSeconds ?? 3,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `stock-tab-spy-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// ── 匯入設定 ──────────────────────────────────────────────────────────────
document.getElementById("input-import").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data.symbols)) throw new Error("格式錯誤");
      const toSave = {
        symbols:       data.symbols,
        aliases:       data.aliases       ?? {},
        rotateSeconds: data.rotateSeconds ?? 3,
      };
      chrome.storage.local.set(toSave, () => {
        statusBar.textContent = "✓ 匯入成功，更新中…";
        symbols = toSave.symbols;
        aliases = toSave.aliases;
        rotateSeconds = toSave.rotateSeconds;
        chrome.runtime.sendMessage({ type: "saveSymbols", symbols }, () => {
          setTimeout(loadStocks, 1500);
        });
      });
    } catch {
      statusBar.textContent = "⚠ 匯入失敗：檔案格式不正確";
    }
  };
  reader.readAsText(file);
  e.target.value = ""; // 允許重複選同一個檔
});

// ── 監聽 stocks 更新（background fetch 後寫入 local storage）────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !tabEnabled) return;
  if (changes.stocks) {
    stocks = changes.stocks.newValue ?? {};
    renderList();
  }
  if (changes.lastUpdated) {
    const t = changes.lastUpdated.newValue;
    statusBar.textContent = t
      ? `最後更新：${new Date(t).toLocaleTimeString("zh-TW")}`
      : "資料更新中…";
  }
  if (changes.aliases) {
    aliases = changes.aliases.newValue ?? {};
    renderList();
    renderSingleSelect();
  }
});

// ── 啟動 ──────────────────────────────────────────────────────────────────
init();
