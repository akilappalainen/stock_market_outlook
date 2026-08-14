/* ==========================================================================
   Market Return Outlook — app.js
   --------------------------------------------------------------------------
   This file reads the plain-text data files in /data at runtime (no build
   step). To publish new numbers, replace a file in /data with a new export
   in the exact same column layout and the site picks it up automatically.
   ========================================================================== */

const FILES = {
  summaryIndices: "data/Estimated_annualized_total_return_of_indices.txt",
  summaryEquity: "data/Estimated_annualized_total_return_of_equity.txt",
  priceIndex: "data/FData.txt",
  priceEquity: "data/FData_Equity.txt",
  dividendIndex: "data/FData_Index_Dividend.txt",
  dividendEquity: "data/FData_DIC_Dividend.txt",
};

// Friendly display names for asset codes that are abbreviations.
const DISPLAY_NAMES = {
  OMXH: "OMXH (Finland)",
  HDAX: "HDAX (Germany)",
  Stoxx600: "Stoxx 600 (Europe)",
  Russell3000: "Russell 3000 (USA)",
  CAC: "CAC (France)",
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
      ticks: { color: AXIS_COLOR, font: { family: FONT_MONO, size: 11 }, autoSkip: true, maxTicksLimit: 10, maxRotation: 0 },
      border: { color: GRID_COLOR },
    },
    y: {
      grid: { color: GRID_COLOR, drawTicks: false },
      ticks: { color: AXIS_COLOR, font: { family: FONT_MONO, size: 11 }, callback: yTickFormatter },
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
      label: (ctx) => ` ${ctx.dataset.label}: ${valueFormatter(ctx.parsed.y)}`,
    },
  };
}

// Draws a solid horizontal line at y=0 so it's obvious which curves sit
// above vs below break-even.
const zeroLinePlugin = {
  id: "zeroLine",
  afterDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const y = scales.y;
    if (!y) return;
    const yZero = y.getPixelForValue(0);
    if (yZero < chartArea.top || yZero > chartArea.bottom) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yZero);
    ctx.lineTo(chartArea.right, yZero);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#2b3540";
    ctx.stroke();
    ctx.restore();
  },
};

function wireSegmented(containerId, onChange) {
  const buttons = document.querySelectorAll(`#${containerId} button`);
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      onChange(btn.dataset.value);
    });
  });
}

/* ------------------------------- fullscreen -------------------------------- */

function toggleFullscreen(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isFs = el.classList.toggle("is-fullscreen");
  document.body.classList.toggle("fs-lock", isFs);
  const btn = el.querySelector(".expand-btn");
  if (btn) {
    btn.textContent = isFs ? "✕" : "⤢";
    btn.setAttribute("aria-label", isFs ? "Exit fullscreen" : "Expand to fullscreen");
  }
  resizeLiveCharts();
}

function exitAllFullscreen() {
  document.querySelectorAll(".is-fullscreen").forEach((el) => {
    el.classList.remove("is-fullscreen");
    const btn = el.querySelector(".expand-btn");
    if (btn) {
      btn.textContent = "⤢";
      btn.setAttribute("aria-label", "Expand to fullscreen");
    }
  });
  document.body.classList.remove("fs-lock");
  resizeLiveCharts();
}

function resizeLiveCharts() {
  requestAnimationFrame(() => {
    if (curveChart) curveChart.resize();
    if (levelChart) levelChart.resize();
  });
  setTimeout(() => {
    if (curveChart) curveChart.resize();
    if (levelChart) levelChart.resize();
  }, 150);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") exitAllFullscreen();
});

/* ========================= CHART 1: RETURN CURVE ========================== */
/* "Forecasted total return curve of stock markets"                          */

const curveState = { group: "indices", isolated: null, view: "chart" };
let curveChart = null;
let curveData = { indices: null, equity: null };

async function initCurve() {
  const [idx, eq] = await Promise.all([loadTable(FILES.summaryIndices), loadTable(FILES.summaryEquity)]);
  curveData.indices = idx;
  curveData.equity = eq;

  wireSegmented("curveGroupToggle", (val) => {
    curveState.group = val;
    curveState.isolated = null;
    renderCurve();
  });

  wireSegmented("curveViewToggle", (val) => {
    curveState.view = val;
    renderCurve();
  });

  document.getElementById("curveExpandBtn").addEventListener("click", () => toggleFullscreen("curveVisual"));

  renderCurve();
}

function renderCurve() {
  const table = curveState.group === "indices" ? curveData.indices : curveData.equity;
  const assets = table.headers.filter((h) => h !== "Horizon" && h !== "Date");
  const horizons = table.rows.map((r) => r.Horizon);
  const snapshotDate = table.rows[0] ? table.rows[0].Date : null;

  document.getElementById("curveSnapshotDate").textContent = fmtDate(snapshotDate);

  const isChartView = curveState.view === "chart";
  document.getElementById("curveChartHolder").style.display = isChartView ? "" : "none";
  document.getElementById("curveLegendWrap").style.display = isChartView ? "" : "none";
  document.getElementById("curveCaption").style.display = isChartView ? "" : "none";
  document.getElementById("curveTableHolder").style.display = isChartView ? "none" : "";

  if (isChartView) {
    const datasets = assets.map((asset, i) => ({
      label: displayName(asset),
      data: table.rows.map((r) => r[asset]),
      borderColor: colorFor(i),
      backgroundColor: colorFor(i),
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      tension: 0.25,
      spanGaps: true,
      hidden: curveState.isolated !== null && curveState.isolated !== asset,
    }));

    const ctx = document.getElementById("curveCanvas").getContext("2d");
    if (curveChart) curveChart.destroy();
    curveChart = new Chart(ctx, {
      type: "line",
      data: { labels: horizons.map((h) => `${h}y`), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: baseTooltip(fmtPct) },
        scales: baseScales((v) => fmtPct(v)),
      },
      plugins: [zeroLinePlugin],
    });

    renderCurveLegend(assets);
  } else {
    renderCurveTable(table, assets);
  }
}

function renderCurveLegend(assets) {
  const el = document.getElementById("curveLegend");
  el.innerHTML = "";
  assets.forEach((asset, i) => {
    const isolated = curveState.isolated === asset;
    const dimmed = curveState.isolated !== null && !isolated;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item" + (dimmed ? " off" : "") + (isolated ? " isolated" : "");
    item.innerHTML = `<span class="legend-swatch" style="background:${colorFor(i)}"></span>${displayName(asset)}`;
    item.addEventListener("click", () => {
      curveState.isolated = isolated ? null : asset;
      renderCurve();
    });
    el.appendChild(item);
  });
}

function renderCurveTable(table, assets) {
  const container = document.getElementById("curveTableHolder");
  let html = '<table class="data-table"><thead><tr><th>Holding period</th>';
  assets.forEach((a) => (html += `<th>${displayName(a)}</th>`));
  html += "</tr></thead><tbody>";
  table.rows.forEach((r) => {
    html += `<tr><td>${r.Horizon}y</td>`;
    assets.forEach((a) => (html += `<td>${fmtPct(r[a])}</td>`));
    html += "</tr>";
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

/* ===================== CHART 2: PRICE / DIVIDEND LEVELS ==================== */
/* "Forecasted price or dividends of stock markets"                          */

// Some markets are labelled with a ticker in the price files but with a
// plain country/region name in the dividend files (e.g. index price file
// uses "OMXH" for Finland, but the index dividend file uses "Finland").
// This map lets the selected market survive toggling between the two.
const INDEX_MARKET_MAP = {
  Finland: { price: "OMXH", dividend: "Finland" },
  Germany: { price: "HDAX", dividend: "Germany" },
  Europe: { price: "Stoxx600", dividend: "Europe" },
  USA: { price: "Russell3000", dividend: "USA" },
  France: { price: "CAC", dividend: "France" },
  UK: { price: "FTSE", dividend: null },
  NL: { price: "AEX", dividend: "NL" },
  Sweden: { price: "OMXS", dividend: "Sweden" },
  World: { price: "World", dividend: null },
  Italy: { price: null, dividend: "Italy" },
  Spain: { price: null, dividend: "Spain" },
};

// Equity files already use plain, matching country/region names in both
// the price and dividend versions, so the canonical market name doubles
// as the raw column key directly (identity mapping).
function rawKeyFor(market, group, series) {
  if (group === "equity") return market;
  const entry = INDEX_MARKET_MAP[market];
  return entry ? entry[series] : null;
}

function marketFromRawKey(rawKey, group, series) {
  if (group === "equity") return rawKey;
  for (const [market, entry] of Object.entries(INDEX_MARKET_MAP)) {
    if (entry[series] === rawKey) return market;
  }
  return rawKey;
}

const levelState = {
  group: "indices", // 'indices' | 'equity'
  series: "price", // 'price' | 'dividend'
  market: "Finland", // canonical market name, stable across group/series toggles
  from: null,
  to: null,
};

let levelTables = { priceIndex: null, priceEquity: null, dividendIndex: null, dividendEquity: null };
let levelChart = null;

async function initLevel() {
  const [pIdx, pEq, dIdx, dEq] = await Promise.all([
    loadTable(FILES.priceIndex),
    loadTable(FILES.priceEquity),
    loadTable(FILES.dividendIndex),
    loadTable(FILES.dividendEquity),
  ]);
  levelTables = { priceIndex: pIdx, priceEquity: pEq, dividendIndex: dIdx, dividendEquity: dEq };

  wireSegmented("levelGroupToggle", (val) => {
    levelState.group = val;
    refreshAssetDropdown();
    resetRangeToDefault();
    renderLevel();
  });

  wireSegmented("levelSeriesToggle", (val) => {
    levelState.series = val;
    refreshAssetDropdown();
    resetRangeToDefault();
    renderLevel();
  });

  document.getElementById("levelAssetSelect").addEventListener("change", (e) => {
    levelState.market = marketFromRawKey(e.target.value, levelState.group, levelState.series);
    resetRangeToDefault();
    renderLevel();
  });

  document.getElementById("rangeFrom").addEventListener("change", (e) => {
    levelState.from = e.target.value;
    renderLevel();
  });
  document.getElementById("rangeTo").addEventListener("change", (e) => {
    levelState.to = e.target.value;
    renderLevel();
  });

  document.querySelector('.range-preset[data-preset="forecast"]').addEventListener("click", () => {
    resetRangeToDefault();
    renderLevel();
  });

  document.getElementById("levelExpandBtn").addEventListener("click", () => toggleFullscreen("levelVisual"));

  refreshAssetDropdown();
  resetRangeToDefault();
  renderLevel();
}

function currentLevelTable() {
  if (levelState.group === "indices") {
    return levelState.series === "price" ? levelTables.priceIndex : levelTables.dividendIndex;
  }
  return levelState.series === "price" ? levelTables.priceEquity : levelTables.dividendEquity;
}

function refreshAssetDropdown() {
  const table = currentLevelTable();
  const assets = dedupedAssetNames(groupByAsset(table.headers));
  const select = document.getElementById("levelAssetSelect");
  select.innerHTML = "";
  assets.forEach((asset) => {
    const opt = document.createElement("option");
    opt.value = asset;
    opt.textContent = displayName(asset);
    select.appendChild(opt);
  });

  const desiredRaw = rawKeyFor(levelState.market, levelState.group, levelState.series);
  const rawKey = assets.includes(desiredRaw) ? desiredRaw : assets[0];
  select.value = rawKey;
  levelState.market = marketFromRawKey(rawKey, levelState.group, levelState.series);
}

// First row where the model has *any* forward-looking figure for this asset.
function forecastStartIndex(rows, cols) {
  return rows.findIndex(
    (r) => r[cols.forecasted_value] !== null || r[cols.plus_stdev] !== null || r[cols.minus_stdev] !== null
  );
}

function currentCols() {
  const table = currentLevelTable();
  const rawKey = rawKeyFor(levelState.market, levelState.group, levelState.series);
  return groupByAsset(table.headers)[rawKey];
}

function resetRangeToDefault() {
  const table = currentLevelTable();
  const cols = currentCols();
  if (!cols) return;
  const startIdx = forecastStartIndex(table.rows, cols);
  const fromRow = startIdx === -1 ? table.rows[0] : table.rows[startIdx];
  levelState.from = fromRow.Date;
  levelState.to = table.rows[table.rows.length - 1].Date;
  syncRangeInputs();
}

function syncRangeInputs() {
  const table = currentLevelTable();
  const min = table.rows[0].Date;
  const max = table.rows[table.rows.length - 1].Date;
  const fromInput = document.getElementById("rangeFrom");
  const toInput = document.getElementById("rangeTo");
  fromInput.min = min;
  fromInput.max = max;
  toInput.min = min;
  toInput.max = max;
  fromInput.value = levelState.from;
  toInput.value = levelState.to;
}

function renderLevel() {
  const table = currentLevelTable();
  const cols = currentCols();
  if (!cols) return;

  const rows = table.rows.filter((r) => r.Date >= levelState.from && r.Date <= levelState.to);
  const dates = rows.map((r) => r.Date);
  const seriesWord = levelState.series === "price" ? "price index" : "dividend level";

  const datasets = [
    {
      label: "Lower estimate (-1 st.dev.)",
      data: rows.map((r) => r[cols.minus_stdev]),
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
      data: rows.map((r) => r[cols.plus_stdev]),
      borderColor: "rgba(91,107,118,0.35)",
      backgroundColor: "rgba(91,107,118,0.08)",
      borderWidth: 1,
      pointRadius: 0,
      fill: "-1",
      tension: 0.15,
      spanGaps: true,
    },
    {
      label: `Forecast (${seriesWord})`,
      data: rows.map((r) => r[cols.forecasted_value]),
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
      label: `Realised (${seriesWord})`,
      data: rows.map((r) => r[cols.realized_value]),
      borderColor: "#146452",
      backgroundColor: "#146452",
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.15,
      spanGaps: true,
    },
  ];

  const ctx = document.getElementById("levelCanvas").getContext("2d");
  if (levelChart) levelChart.destroy();
  levelChart = new Chart(ctx, {
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
          labels: {
            color: AXIS_COLOR,
            font: { family: FONT_SANS, size: 12.5 },
            boxWidth: 14,
            boxHeight: 8,
            filter: (item) => !item.text.includes("estimate"),
          },
        },
        tooltip: baseTooltip(fmtCompact),
      },
      scales: baseScales((v) => fmtCompact(v)),
    },
  });

  const badge = document.getElementById("levelBadge");
  badge.textContent = levelState.series === "price" ? "Showing: price index (excl. dividends)" : "Showing: dividend level";
  badge.className = "series-badge " + (levelState.series === "price" ? "badge-price" : "badge-dividend");

  document.getElementById("levelCaption").textContent = `Showing ${fmtDate(levelState.from)} – ${fmtDate(levelState.to)}`;
}

/* --------------------------------- init ---------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  initCurve().catch(showLoadError);
  initLevel().catch(showLoadError);
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
