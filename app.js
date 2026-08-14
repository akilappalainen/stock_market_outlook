/* ==========================================================================
   Market Return Outlook — app.js
   --------------------------------------------------------------------------
   This file reads the plain-text data files in /data at runtime (no build
   step). To publish new numbers, replace a file in /data with a new export
   in the exact same column layout and the site picks it up automatically.
   ========================================================================== */

const FILES = {
  summaryEquity: "data/Estimated_annualized_total_return_of_equity.txt",
  summaryIndices: "data/Estimated_annualized_total_return_of_indices.txt",
  historyEquity: "data/FData_Equity.txt",
  historyEquityDiv: "data/FData_DIC_Dividend.txt",
  historyIndex: "data/FData.txt",
  historyIndexDiv: "data/FData_Index_Dividend.txt",
};

// Friendly display names for asset codes that are abbreviations.
const DISPLAY_NAMES = {
  OMXH: "OMXH (Finland)",
  HDAX: "HDAX (Germany)",
  Stoxx600: "Stoxx 600 (Europe)",
  Russell3000: "Russell 3000 (USA)",
  CAC: "CAC 40 (France)",
  FTSE: "FTSE (UK)",
  AEX: "AEX (Netherlands)",
  OMXS: "OMXS (Sweden)",
  World: "MSCI World",
  NL: "Netherlands",
  USA: "United States",
};

function displayName(code) {
  return DISPLAY_NAMES[code] || code;
}

// A muted, distinguishable categorical palette (not neon, reads on paper bg).
const PALETTE = [
  "#146452", "#1d6fa5", "#99432b", "#b8801f", "#5b3e8a",
  "#3e7c8c", "#8a5b3e", "#5c6b23", "#a5334d", "#2b5d6a",
];

function colorFor(index) {
  return PALETTE[index % PALETTE.length];
}

/* ---------------------------- generic parser ---------------------------- */

function tokenize(line) {
  const re = /"([^"]*)"|(\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

function parseTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = tokenize(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cleaned = tokenize(lines[i]);
    if (cleaned.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => {
      const v = cleaned[idx];
      if (v === undefined || v === "NA") row[h] = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) row[h] = v;
      else row[h] = parseFloat(v);
    });
    rows.push(row);
  }
  return { headers, rows };
}

// Groups the wide "Asset_metric" columns produced by the R export into
// { assetName: { metricName: originalColumnHeader } }. Handles the
// occasional duplicated column ("Spain_forecasted_value.1") by keeping it
// as a separate, later-deduped asset key.
function groupByAsset(headers) {
  const metrics = ["forecasted_value", "realized_value", "error_term", "plus_stdev", "minus_stdev"];
  for (let n = 2; n <= 10; n++) {
    metrics.push(`forecasted_${n}year_return`);
    metrics.push(`realized_${n}year_return`);
  }
  metrics.sort((a, b) => b.length - a.length);

  const assets = {};
  headers.forEach((hRaw) => {
    if (hRaw === "Date" || hRaw === "Horizon") return;
    const dupMatch = hRaw.match(/\.(\d+)$/);
    const dupSuffix = dupMatch ? dupMatch[0] : "";
    const h = dupSuffix ? hRaw.slice(0, -dupSuffix.length) : hRaw;
    for (const m of metrics) {
      if (h.endsWith("_" + m)) {
        const assetBase = h.slice(0, h.length - m.length - 1);
        const asset = assetBase + dupSuffix;
        if (!assets[asset]) assets[asset] = {};
        assets[asset][m] = hRaw;
        return;
      }
    }
  });
  return assets;
}

// Drops exact-duplicate columns (e.g. "Spain.1") from a dropdown list.
function dedupedAssetNames(assets) {
  return Object.keys(assets).filter((k) => !/\.\d+$/.test(k));
}

async function loadTable(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const text = await res.text();
  return parseTable(text);
}

/* ------------------------------ formatting ------------------------------- */

const pctFmt = new Intl.NumberFormat("en-GB", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compactFmt = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });

function fmtPct(v) {
  return v === null || v === undefined || isNaN(v) ? "–" : pctFmt.format(v);
}
function fmtCompact(v) {
  return v === null || v === undefined || isNaN(v) ? "–" : compactFmt.format(v);
}
function fmtDate(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" });
}

/* ------------------------------ chart helpers ----------------------------- */

const GRID_COLOR = "#e2e8e6";
const AXIS_COLOR = "#5b6b76";
const FONT_SANS = "IBM Plex Sans";
const FONT_MONO = "IBM Plex Mono";

function baseScales(yTickFormatter) {
  return {
    x: {
      grid: { color: GRID_COLOR, drawTicks: false },
      ticks: { color: AXIS_COLOR, font: { family: FONT_MONO, size: 11 }, autoSkip: true, maxTicksLimit: 12, maxRotation: 0 },
      border: { color: GRID_COLOR },
    },
    y: {
      grid: { color: GRID_COLOR, drawTicks: false },
      ticks: {
        color: AXIS_COLOR,
        font: { family: FONT_MONO, size: 11 },
        callback: yTickFormatter,
      },
      border: { display: false },
    },
  };
}

function baseTooltip(valueFormatter) {
  return {
    backgroundColor: "#10151c",
    titleFont: { family: FONT_MONO, size: 11.5 },
    bodyFont: { family: FONT_SANS, size: 12.5 },
    padding: 10,
    cornerRadius: 6,
    displayColors: true,
    callbacks: {
      label: (ctx) => {
        const v = ctx.parsed.y;
        return ` ${ctx.dataset.label}: ${valueFormatter(v)}`;
      },
    },
  };
}

/* ============================ SECTION A: OUTLOOK ========================== */

const outlookState = { assetClass: "equity", hiddenAssets: new Set() };
let outlookChart = null;
let outlookData = { equity: null, indices: null };

async function initOutlook() {
  const [eq, idx] = await Promise.all([loadTable(FILES.summaryEquity), loadTable(FILES.summaryIndices)]);
  outlookData.equity = eq;
  outlookData.indices = idx;
  document.querySelectorAll("#outlookToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      outlookState.assetClass = btn.dataset.value;
      outlookState.hiddenAssets = new Set();
      document.querySelectorAll("#outlookToggle button").forEach((b) => b.classList.toggle("active", b === btn));
      renderOutlook();
    });
  });
  renderOutlook();
}

function renderOutlook() {
  const table = outlookState.assetClass === "equity" ? outlookData.equity : outlookData.indices;
  const assets = table.headers.filter((h) => h !== "Horizon" && h !== "Date");
  const horizons = table.rows.map((r) => r.Horizon);
  const snapshotDate = table.rows[0] ? table.rows[0].Date : null;

  document.getElementById("outlookSnapshotDate").textContent = fmtDate(snapshotDate);

  const datasets = assets.map((asset, i) => ({
    label: displayName(asset),
    data: table.rows.map((r) => (r[asset] === null ? null : r[asset])),
    borderColor: colorFor(i),
    backgroundColor: colorFor(i),
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.25,
    spanGaps: true,
    hidden: outlookState.hiddenAssets.has(asset),
    _asset: asset,
  }));

  const ctx = document.getElementById("outlookCanvas").getContext("2d");
  if (outlookChart) outlookChart.destroy();
  outlookChart = new Chart(ctx, {
    type: "line",
    data: { labels: horizons.map((h) => `${h}y`), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: baseTooltip(fmtPct),
      },
      scales: baseScales((v) => fmtPct(v)),
    },
  });

  renderLegend("outlookLegend", assets, outlookState.hiddenAssets, () => renderOutlook(), () => outlookChart);
}

function renderLegend(containerId, assets, hiddenSet, onToggle) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  assets.forEach((asset, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item" + (hiddenSet.has(asset) ? " off" : "");
    item.innerHTML = `<span class="legend-swatch" style="background:${colorFor(i)}"></span>${displayName(asset)}`;
    item.addEventListener("click", () => {
      if (hiddenSet.has(asset)) hiddenSet.delete(asset);
      else hiddenSet.add(asset);
      onToggle();
    });
    el.appendChild(item);
  });
}

/* ========================= SECTION B: TRACK RECORD ========================= */

const historyState = {
  assetClass: "equity", // 'equity' | 'indices'
  dividend: false,
  asset: null,
  horizon: 6,
  view: "return", // 'return' | 'level'
};

let historyTables = { equity: null, equityDiv: null, indices: null, indicesDiv: null };
let historyChart = null;

async function initHistory() {
  const [eq, eqDiv, idx, idxDiv] = await Promise.all([
    loadTable(FILES.historyEquity),
    loadTable(FILES.historyEquityDiv),
    loadTable(FILES.historyIndex),
    loadTable(FILES.historyIndexDiv),
  ]);
  historyTables = { equity: eq, equityDiv: eqDiv, indices: idx, indicesDiv: idxDiv };

  document.querySelectorAll("#historyAssetClassToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      historyState.assetClass = btn.dataset.value;
      document.querySelectorAll("#historyAssetClassToggle button").forEach((b) => b.classList.toggle("active", b === btn));
      refreshAssetDropdown();
      renderHistory();
    });
  });

  const divSwitch = document.getElementById("dividendSwitch");
  divSwitch.addEventListener("click", () => {
    historyState.dividend = !historyState.dividend;
    divSwitch.classList.toggle("on", historyState.dividend);
    refreshAssetDropdown();
    renderHistory();
  });

  document.getElementById("assetSelect").addEventListener("change", (e) => {
    historyState.asset = e.target.value;
    renderHistory();
  });

  const ruler = document.getElementById("horizonRuler");
  ruler.addEventListener("input", (e) => {
    historyState.horizon = parseInt(e.target.value, 10);
    document.getElementById("horizonReadout").textContent = historyState.horizon;
    renderHistory();
  });

  document.querySelectorAll("#historyTabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      historyState.view = btn.dataset.value;
      document.querySelectorAll("#historyTabs button").forEach((b) => b.classList.toggle("active", b === btn));
      document.getElementById("rulerWrap").style.display = historyState.view === "return" ? "" : "none";
      renderHistory();
    });
  });

  refreshAssetDropdown();
  renderHistory();
}

function currentHistoryTable() {
  if (historyState.assetClass === "equity") {
    return historyState.dividend ? historyTables.equityDiv : historyTables.equity;
  }
  return historyState.dividend ? historyTables.indicesDiv : historyTables.indices;
}

function refreshAssetDropdown() {
  const table = currentHistoryTable();
  const assets = dedupedAssetNames(groupByAsset(table.headers));
  const select = document.getElementById("assetSelect");
  const previous = historyState.asset;
  select.innerHTML = "";
  assets.forEach((asset) => {
    const opt = document.createElement("option");
    opt.value = asset;
    opt.textContent = displayName(asset);
    select.appendChild(opt);
  });
  historyState.asset = assets.includes(previous) ? previous : assets[0];
  select.value = historyState.asset;
}

function renderHistory() {
  const table = currentHistoryTable();
  const assets = groupByAsset(table.headers);
  const cols = assets[historyState.asset];
  if (!cols) return;

  const dates = table.rows.map((r) => r.Date);
  let datasets = [];
  let yFormatter = fmtPct;

  if (historyState.view === "return") {
    const h = historyState.horizon;
    const fCol = cols[`forecasted_${h}year_return`];
    const rCol = cols[`realized_${h}year_return`];
    datasets = [
      {
        label: `Model forecast (${h}y annualised)`,
        data: table.rows.map((r) => r[fCol]),
        borderColor: "#b8801f",
        backgroundColor: "#b8801f",
        borderDash: [5, 3],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
        spanGaps: true,
      },
      {
        label: `Actually realised (${h}y annualised)`,
        data: table.rows.map((r) => r[rCol]),
        borderColor: "#146452",
        backgroundColor: "#146452",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
        spanGaps: true,
      },
    ];
    yFormatter = fmtPct;
  } else {
    datasets = [
      {
        label: "Lower estimate (-1 st.dev.)",
        data: table.rows.map((r) => r[cols.minus_stdev]),
        borderColor: "rgba(91,107,118,0.35)",
        backgroundColor: "rgba(91,107,118,0.08)",
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        tension: 0.15,
        spanGaps: true,
      },
      {
        label: "Upper estimate (+1 st.dev.)",
        data: table.rows.map((r) => r[cols.plus_stdev]),
        borderColor: "rgba(91,107,118,0.35)",
        backgroundColor: "rgba(91,107,118,0.08)",
        borderWidth: 1,
        pointRadius: 0,
        fill: "-1",
        tension: 0.15,
        spanGaps: true,
      },
      {
        label: "Model value (forecast)",
        data: table.rows.map((r) => r[cols.forecasted_value]),
        borderColor: "#b8801f",
        backgroundColor: "#b8801f",
        borderDash: [5, 3],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.15,
        spanGaps: true,
      },
      {
        label: "Realised value",
        data: table.rows.map((r) => r[cols.realized_value]),
        borderColor: "#146452",
        backgroundColor: "#146452",
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.15,
        spanGaps: true,
      },
    ];
    yFormatter = fmtCompact;
  }

  const ctx = document.getElementById("historyCanvas").getContext("2d");
  if (historyChart) historyChart.destroy();
  historyChart = new Chart(ctx, {
    type: "line",
    data: { labels: dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: { color: AXIS_COLOR, font: { family: FONT_SANS, size: 12.5 }, boxWidth: 14, boxHeight: 8, usePointStyle: false, filter: (item) => !item.text.includes("estimate") },
        },
        tooltip: baseTooltip(yFormatter),
      },
      scales: baseScales((v) => yFormatter(v)),
    },
  });

  // caption
  const withF = table.rows.filter((r) => r[cols.forecasted_value] !== null);
  const withR = table.rows.filter((r) => r[cols.realized_value] !== null);
  const caption = document.getElementById("historyCaption");
  const fRange = withF.length ? `${fmtDate(withF[0].Date)} – ${fmtDate(withF[withF.length - 1].Date)}` : "n/a";
  const rRange = withR.length ? `${fmtDate(withR[0].Date)} – ${fmtDate(withR[withR.length - 1].Date)}` : "n/a";
  caption.innerHTML = `<span>Model forecast span: ${fRange}</span><span>Realised data span: ${rRange}</span>`;
}

/* --------------------------------- init ---------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  initOutlook().catch((err) => showLoadError(err));
  initHistory().catch((err) => showLoadError(err));
});

function showLoadError(err) {
  console.error(err);
  document.querySelectorAll(".chart-holder").forEach((el) => {
    if (!el.querySelector(".state-msg")) {
      const msg = document.createElement("div");
      msg.className = "state-msg";
      msg.textContent = "Could not load the data files. If you are viewing this from your computer, the /data files must be served over http(s) — try the published GitHub Pages link instead of opening index.html directly.";
      el.appendChild(msg);
    }
  });
}
