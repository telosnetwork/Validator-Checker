const DATA_SOURCES = {
  latest: [
    "validation/latest.json",
    "data/latest.json",
    "https://infinitybloc.io/validation/latest.json",
  ],
  history: [
    "validation/history.json",
    "data/history.json",
  ],
  legacyCpuHistory: [
    "https://infinitybloc.io/validation/history.json",
  ],
};

const MAX_MERGED_HISTORY_RUNS = 112;

const PALETTE = [
  "#1f6fb2",
  "#177245",
  "#b3261e",
  "#8a5d00",
  "#5b52a3",
  "#c24a1f",
  "#0c7f83",
  "#6b5b2a",
  "#8d3c7a",
  "#2c6e49",
  "#a44200",
  "#4b6d9b",
  "#7c4f9e",
  "#0077b6",
  "#6a994e",
  "#bc4749",
  "#386641",
  "#6d597a",
  "#355070",
  "#9a031e",
  "#005f73",
  "#7f5539",
  "#3a0ca3",
  "#588157",
];

const state = {
  latest: null,
  producers: [],
  historyRuns: [],
  chartMode: "cpu",
  hiddenSeries: new Set(),
  filter: "all",
  query: "",
  sortKey: null,
  sortAsc: true,
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  await loadData();
}

function cacheElements() {
  els.statusLine = document.getElementById("statusLine");
  els.metrics = document.getElementById("metrics");
  els.chartHeading = document.getElementById("chartHeading");
  els.chartSubhead = document.getElementById("chartSubhead");
  els.chartArea = document.getElementById("chartArea");
  els.chartEmpty = document.getElementById("chartEmpty");
  els.historyChart = document.getElementById("historyChart");
  els.chartTooltip = document.getElementById("chartTooltip");
  els.chartLegend = document.getElementById("chartLegend");
  els.producerSearch = document.getElementById("producerSearch");
  els.tableSummary = document.getElementById("tableSummary");
  els.producerRows = document.getElementById("producerRows");
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartMode = button.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((modeButton) => {
        const active = modeButton.dataset.mode === state.chartMode;
        modeButton.classList.toggle("is-active", active);
        modeButton.setAttribute("aria-pressed", String(active));
      });
      renderChart();
    });
  });

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((filterButton) => {
        filterButton.classList.toggle("is-active", filterButton.dataset.filter === state.filter);
      });
      renderTable();
    });
  });

  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextKey = button.dataset.sort;
      state.sortAsc = state.sortKey === nextKey ? !state.sortAsc : true;
      state.sortKey = nextKey;
      renderTable();
    });
  });

  els.producerSearch.addEventListener("input", () => {
    state.query = els.producerSearch.value.trim().toLowerCase();
    renderTable();
  });

  document.getElementById("showTableButton").addEventListener("click", () => setTab("producers"));

  document.getElementById("selectAllSeries").addEventListener("click", () => {
    state.hiddenSeries.clear();
    renderChart();
  });

  document.getElementById("deselectAllSeries").addEventListener("click", () => {
    getCurrentSeriesNames().forEach((name) => state.hiddenSeries.add(name));
    renderChart();
  });

  els.chartLegend.addEventListener("click", (event) => {
    const button = event.target.closest("[data-series]");
    if (!button) return;
    const name = button.dataset.series;
    if (state.hiddenSeries.has(name)) {
      state.hiddenSeries.delete(name);
    } else {
      state.hiddenSeries.add(name);
    }
    renderChart();
  });
}

async function loadData() {
  try {
    state.latest = await fetchJsonFromSources(DATA_SOURCES.latest, "latest snapshot");
    state.producers = Array.isArray(state.latest.producers) ? state.latest.producers : [];
  } catch (error) {
    renderLoadError(error);
    return;
  }

  const history = await fetchOptionalJsonFromSources(DATA_SOURCES.history);
  const legacyCpuHistory = await fetchOptionalJsonFromSources(DATA_SOURCES.legacyCpuHistory);
  state.historyRuns = mergeHistoryRuns(
    Array.isArray(history && history.runs) ? history.runs : [],
    Array.isArray(legacyCpuHistory && legacyCpuHistory.runs) ? legacyCpuHistory.runs : [],
  );

  renderStatus();
  renderMetrics();
  renderChart();
  renderTable();
}

async function fetchJsonFromSources(urls, label) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`${label} could not be loaded (${errors.join("; ")})`);
}

async function fetchOptionalJsonFromSources(urls) {
  try {
    return await fetchJsonFromSources(urls, "optional history snapshot");
  } catch (error) {
    return null;
  }
}

function mergeHistoryRuns(primaryRuns, legacyCpuRuns) {
  const byTime = new Map();

  primaryRuns.forEach((run) => {
    if (!run || !run.t) return;
    byTime.set(run.t, { ...run });
  });

  legacyCpuRuns.forEach((run) => {
    if (!run || !run.t || !run.cpu) return;
    const existing = byTime.get(run.t) || { t: run.t };
    existing.cpu = { ...run.cpu, ...(existing.cpu || {}) };
    byTime.set(run.t, existing);
  });

  return Array.from(byTime.values())
    .sort((a, b) => new Date(a.t) - new Date(b.t))
    .slice(-MAX_MERGED_HISTORY_RUNS);
}

function renderLoadError(error) {
  hideChartTooltip();
  els.statusLine.textContent = `Unable to load validator data: ${error.message}`;
  els.metrics.innerHTML = "";
  els.chartArea.hidden = true;
  els.chartEmpty.hidden = false;
  els.chartEmpty.textContent = "Latest validation data could not be loaded.";
  els.producerRows.innerHTML = `<tr><td colspan="10" class="table-empty">Latest validation data could not be loaded.</td></tr>`;
  els.tableSummary.textContent = "No producer data available.";
}

function renderStatus() {
  if (!state.producers.length) {
    els.statusLine.textContent = "No producers were found in the latest snapshot.";
    return;
  }

  const generatedAt = formatDateTime(state.latest.generatedAt);
  els.statusLine.textContent = `Updated ${generatedAt} - ${state.producers.length} producers`;
}

function renderMetrics() {
  const total = state.producers.length;
  const passing = state.producers.filter(isMainnetPassing).length;
  const testnetPassing = state.producers.filter(isTestnetPassing).length;
  const active = state.producers.filter((producer) => producer.scheduleType === "active").length;
  const validLatency = state.producers
    .map((producer) => Number(producer.apiResponseMs))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  const averageLatency = validLatency.length
    ? Math.round(validLatency.reduce((sum, value) => sum + value, 0) / validLatency.length)
    : null;

  const metrics = [
    { label: "Registered BPs", value: total, tone: "" },
    { label: "Mainnet Passing", value: passing, tone: "good" },
    { label: "Mainnet Failing", value: total - passing, tone: "bad" },
    { label: "Testnet Passing", value: testnetPassing, tone: "" },
    { label: "Avg Latency", value: averageLatency === null ? "N/A" : `${averageLatency} ms`, tone: "info" },
    { label: "Active Schedule", value: active, tone: "" },
  ];

  els.metrics.innerHTML = metrics
    .map((metric) => `
      <article class="metric">
        <span class="metric-value ${metric.tone}">${escapeHtml(String(metric.value))}</span>
        <span class="metric-label">${escapeHtml(metric.label)}</span>
      </article>
    `)
    .join("");
}

function setTab(tabName) {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  document.querySelectorAll(".panel").forEach((panel) => {
    const active = panel.id === `panel-${tabName}`;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

function renderChart() {
  const config = getChartConfig();
  const runs = state.historyRuns;
  const seriesNames = getCurrentSeriesNames();
  const visibleNames = seriesNames.filter((name) => !state.hiddenSeries.has(name));

  hideChartTooltip();
  els.chartHeading.textContent = config.heading;
  els.chartSubhead.textContent = `${runs.length} history runs - ${seriesNames.length} producers tracked`;
  els.chartLegend.innerHTML = renderLegend(seriesNames);

  if (runs.length < 2 || !seriesNames.length) {
    els.chartArea.hidden = true;
    els.chartEmpty.hidden = false;
    els.chartEmpty.textContent = `Not enough ${config.emptyLabel} history is available yet.`;
    return;
  }

  els.chartArea.hidden = false;
  els.chartEmpty.hidden = true;
  drawChart(runs, visibleNames, config);
}

function getChartConfig() {
  if (state.chartMode === "api") {
    return {
      field: "bps",
      heading: "API Latency",
      unit: "ms",
      yLabel: "Milliseconds",
      emptyLabel: "API latency",
      spanGaps: true,
      pointRadius: 2.5,
    };
  }

  if (state.chartMode === "missed") {
    return {
      field: "missed",
      heading: "Missed Blocks",
      unit: "missed",
      yLabel: "Blocks missed",
      emptyLabel: "missed block",
      spanGaps: true,
      pointRadius: 2.5,
    };
  }

  return {
    field: "cpu",
    heading: "CPU Time",
    unit: "us",
    yLabel: "Microseconds",
    emptyLabel: "CPU timing",
    spanGaps: true,
    pointRadius: 3.5,
  };
}

function getCurrentSeriesNames() {
  const field = getChartConfig().field;
  return Array.from(
    new Set(state.historyRuns.flatMap((run) => Object.keys(run[field] || {})))
  ).sort((a, b) => a.localeCompare(b));
}

function renderLegend(seriesNames) {
  return seriesNames
    .map((name, index) => {
      const hidden = state.hiddenSeries.has(name);
      const color = colorFor(index);
      return `
        <button type="button" class="legend-item ${hidden ? "is-hidden" : ""}" data-series="${escapeAttribute(name)}" aria-pressed="${String(!hidden)}">
          <span class="legend-swatch" style="background:${color}"></span>
          <span>${escapeHtml(name)}</span>
        </button>
      `;
    })
    .join("");
}

function drawChart(runs, visibleNames, config) {
  const width = 1080;
  const height = 430;
  const margin = { top: 34, right: 26, bottom: 62, left: 82 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const values = [];
  const hoverTargets = new Map();
  const nameIndex = new Map(getCurrentSeriesNames().map((name, index) => [name, index]));
  let hoverId = 0;

  visibleNames.forEach((name) => {
    runs.forEach((run) => {
      const value = getRunValue(run, name, config.field);
      if (value !== null) values.push(value);
    });
  });

  const maxValue = Math.max(1, ...values);
  const yMax = niceMax(maxValue);
  const yTicks = makeTicks(yMax, 5);
  const xFor = (index) => margin.left + (runs.length === 1 ? 0 : (index / (runs.length - 1)) * innerWidth);
  const yFor = (value) => margin.top + innerHeight - (value / yMax) * innerHeight;
  const labelStep = Math.max(1, Math.ceil(runs.length / 8));

  const grid = yTicks
    .map((tick) => {
      const y = yFor(tick);
      return `
        <line class="grid-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
        <text class="axis-text" x="${margin.left - 12}" y="${y + 4}" text-anchor="end">${formatNumber(tick)}</text>
      `;
    })
    .join("");

  const xLabels = runs
    .map((run, index) => {
      if (index % labelStep !== 0 && index !== runs.length - 1) return "";
      const x = xFor(index);
      return `<text class="axis-text" x="${x}" y="${height - 22}" text-anchor="middle">${escapeHtml(formatShortDate(run.t))}</text>`;
    })
    .join("");

  const lines = visibleNames
    .map((name) => {
      const index = nameIndex.get(name) || 0;
      const color = colorFor(index);
      const points = runs.map((run, runIndex) => {
        const value = getRunValue(run, name, config.field);
        return value === null ? null : { x: xFor(runIndex), y: yFor(value), value, run };
      });
      const segments = makePaths(points, config.spanGaps);
      const pathMarkup = segments
        .map((segment) => {
          const key = `hover-${hoverId++}`;
          hoverTargets.set(key, { name, points: segment });
          const path = pathFromPoints(segment);
          return `
            <path class="chart-line" d="${path}" stroke="${color}"></path>
            ${segment.length > 1 ? `<path class="chart-hit" d="${path}" data-hover-key="${key}"></path>` : ""}
          `;
        })
        .join("");
      const pointMarkup = points
        .filter(Boolean)
        .map((point) => {
          const key = `hover-${hoverId++}`;
          hoverTargets.set(key, { name, points: [point] });
          return `
            <circle class="chart-point" cx="${point.x}" cy="${point.y}" r="${config.pointRadius}" fill="${color}"></circle>
            <circle class="chart-point-hit" cx="${point.x}" cy="${point.y}" r="${Math.max(config.pointRadius + 4, 7)}" data-hover-key="${key}"></circle>
          `;
        })
        .join("");
      return `
        <g class="chart-series" data-series="${escapeAttribute(name)}">
          ${pathMarkup}
          ${pointMarkup}
        </g>
      `;
    })
    .join("");

  els.historyChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.historyChart.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" fill="#fbfcfd"></rect>
    ${grid}
    <line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"></line>
    <line class="axis-line" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
    <text class="axis-text" x="${margin.left}" y="18">${escapeHtml(config.yLabel)}</text>
    ${xLabels}
    ${lines}
  `;
  bindChartInteractions(hoverTargets, width, config);
}

function getRunValue(run, producerName, field) {
  const raw = run[field] ? run[field][producerName] : null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function makePaths(points, spanGaps) {
  const paths = [];
  let current = [];

  points.forEach((point) => {
    if (point) {
      current.push(point);
      return;
    }

    if (!spanGaps && current.length) {
      paths.push(current);
      current = [];
    }
  });

  if (current.length) {
    paths.push(current);
  }

  return paths.filter((path) => path.length);
}

function pathFromPoints(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function bindChartInteractions(hoverTargets, viewBoxWidth, config) {
  const hoverables = els.historyChart.querySelectorAll("[data-hover-key]");
  hoverables.forEach((element) => {
    const hoverData = hoverTargets.get(element.dataset.hoverKey);
    if (!hoverData) return;

    element.addEventListener("pointermove", (event) => {
      const point = getNearestPoint(hoverData.points, getSvgPointerX(event, viewBoxWidth));
      if (!point) return;
      setHoveredSeries(hoverData.name);
      showChartTooltip(
        `
          <div class="chart-tooltip-name">${escapeHtml(hoverData.name)}</div>
          <div class="chart-tooltip-meta">${escapeHtml(`${formatNumber(point.value)} ${config.unit}`)}<br>${escapeHtml(formatDateTime(point.run.t))}</div>
        `,
        event.clientX,
        event.clientY,
      );
    });
  });

  els.historyChart.onpointermove = (event) => {
    if (!event.target.closest("[data-hover-key]")) {
      clearHoveredSeries();
      hideChartTooltip();
    }
  };

  els.chartArea.onpointerleave = () => {
    clearHoveredSeries();
    hideChartTooltip();
  };
}

function getSvgPointerX(event, viewBoxWidth) {
  const rect = els.historyChart.getBoundingClientRect();
  if (!rect.width) return 0;
  const percent = (event.clientX - rect.left) / rect.width;
  return percent * viewBoxWidth;
}

function getNearestPoint(points, x) {
  if (!points.length) return null;
  return points.reduce((closest, point) => {
    if (!closest) return point;
    return Math.abs(point.x - x) < Math.abs(closest.x - x) ? point : closest;
  }, null);
}

function setHoveredSeries(name) {
  els.historyChart.querySelectorAll(".chart-series").forEach((group) => {
    group.classList.toggle("is-hovered", group.dataset.series === name);
  });
}

function clearHoveredSeries() {
  els.historyChart.querySelectorAll(".chart-series.is-hovered").forEach((group) => {
    group.classList.remove("is-hovered");
  });
}

function showChartTooltip(content, clientX, clientY) {
  els.chartTooltip.innerHTML = content;
  els.chartTooltip.hidden = false;

  const bounds = els.chartArea.getBoundingClientRect();
  const tooltipBounds = els.chartTooltip.getBoundingClientRect();
  const gap = 14;
  let left = clientX - bounds.left + gap;
  let top = clientY - bounds.top + gap;

  if (left + tooltipBounds.width > bounds.width - 8) {
    left = Math.max(8, clientX - bounds.left - tooltipBounds.width - gap);
  }
  if (top + tooltipBounds.height > bounds.height - 8) {
    top = Math.max(8, clientY - bounds.top - tooltipBounds.height - gap);
  }

  els.chartTooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideChartTooltip() {
  if (!els.chartTooltip) return;
  els.chartTooltip.hidden = true;
}

function renderTable() {
  let rows = state.producers.filter(matchesQuery).filter(matchesFilter);

  if (state.sortKey) {
    rows = [...rows].sort((a, b) => compareProducerValues(a, b, state.sortKey, state.sortAsc));
  }

  updateSortButtons();
  els.tableSummary.textContent = `${rows.length} of ${state.producers.length} producers shown`;

  if (!rows.length) {
    els.producerRows.innerHTML = `<tr><td colspan="10" class="table-empty">No producers match the current view.</td></tr>`;
    return;
  }

  els.producerRows.innerHTML = rows.map(renderProducerRow).join("");
}

function renderProducerRow(producer, index) {
  const org = producer.org || {};
  const candidate = org.candidate_name && org.candidate_name !== producer.owner
    ? `<span class="producer-meta">${escapeHtml(org.candidate_name)}</span>`
    : "";
  const country = org.location && org.location.country ? String(org.location.country) : "";
  const site = getSafeUrl(org.website || producer.url || "");
  const hasTestnet = hasTestnetData(producer);
  const errors = Array.isArray(producer.validationErrors) ? producer.validationErrors : [];
  const errorText = errors.length ? escapeHtml(errors.join(" | ")) : "";
  const missed = Number(producer.missedBlocksPerRotation);
  const cpuUs = latestHistoryValue(producer.owner, "cpu");

  return `
    <tr>
      <td class="rank-cell">${index + 1}</td>
      <td>${scheduleBadge(producer.scheduleType)}</td>
      <td>
        <span class="producer-name">${escapeHtml(producer.owner || "")}</span>
        ${candidate}
        ${country ? `<span class="producer-meta">${escapeHtml(country)}</span>` : ""}
        ${site ? `<span class="producer-meta"><a href="${escapeAttribute(site)}" target="_blank" rel="noopener noreferrer">${escapeHtml(stripProtocol(site))}</a></span>` : ""}
      </td>
      <td>${statusPill(Boolean(producer.sslVerified), true)}</td>
      <td>${statusPill(Boolean(producer.apiVerified), true)}</td>
      <td>${timing(cpuUs, "us")}</td>
      <td>${hasTestnet ? statusPill(Boolean(producer.sslVerifiedTestNet), true) : statusPill(false, false)}</td>
      <td>${hasTestnet ? statusPill(Boolean(producer.apiVerifiedTestNet), true) : statusPill(false, false)}</td>
      <td class="numeric">${Number.isFinite(missed) ? missed : 0}</td>
      <td class="error-list">${errorText}</td>
    </tr>
  `;
}

function matchesQuery(producer) {
  if (!state.query) return true;
  const org = producer.org || {};
  const fields = [
    producer.owner,
    org.candidate_name,
    org.website,
    producer.url,
    org.location && org.location.country,
    ...(Array.isArray(producer.validationErrors) ? producer.validationErrors : []),
  ];
  return fields.filter(Boolean).some((field) => String(field).toLowerCase().includes(state.query));
}

function matchesFilter(producer) {
  if (state.filter === "passing") return isMainnetPassing(producer);
  if (state.filter === "failing") return !isMainnetPassing(producer);
  if (state.filter === "testnet") return isTestnetPassing(producer);
  if (state.filter === "active") return producer.scheduleType === "active";
  if (state.filter === "standby") return producer.scheduleType === "standby";
  return true;
}

function compareProducerValues(a, b, key, ascending) {
  const direction = ascending ? 1 : -1;
  const aValue = producerSortValue(a, key);
  const bValue = producerSortValue(b, key);

  if (typeof aValue === "boolean" || typeof bValue === "boolean") {
    return (Number(Boolean(aValue)) - Number(Boolean(bValue))) * direction;
  }

  const aNumber = Number(aValue);
  const bNumber = Number(bValue);
  const aHasNumber = Number.isFinite(aNumber);
  const bHasNumber = Number.isFinite(bNumber);
  if (aHasNumber || bHasNumber) {
    if (aHasNumber && bHasNumber) return (aNumber - bNumber) * direction;
    return aHasNumber ? -1 : 1;
  }

  return String(aValue || "").localeCompare(String(bValue || "")) * direction;
}

function producerSortValue(producer, key) {
  if (key === "cpuUs") return latestHistoryValue(producer.owner, "cpu");
  return producer[key];
}

function latestHistoryValue(producerName, field) {
  for (let index = state.historyRuns.length - 1; index >= 0; index -= 1) {
    const value = state.historyRuns[index] && state.historyRuns[index][field]
      ? state.historyRuns[index][field][producerName]
      : null;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function updateSortButtons() {
  document.querySelectorAll("[data-sort]").forEach((button) => {
    const active = button.dataset.sort === state.sortKey;
    button.classList.toggle("is-sorted", active);
    button.dataset.direction = active ? (state.sortAsc ? "up" : "down") : "";
  });
}

function scheduleBadge(type) {
  const active = type === "active";
  return `<span class="badge ${active ? "active" : "standby"}">${active ? "Active" : "Standby"}</span>`;
}

function statusPill(value, available) {
  if (!available) return `<span class="status-pill none">None</span>`;
  return value
    ? `<span class="status-pill pass">Pass</span>`
    : `<span class="status-pill fail">Fail</span>`;
}

function latency(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return `<span class="latency none">-</span>`;
  const className = ms < 300 ? "fast" : ms >= 800 ? "slow" : "";
  return `<span class="latency ${className}">${ms} ms</span>`;
}

function timing(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return `<span class="timing none">-</span>`;
  return `<span class="timing">${number} ${escapeHtml(unit)}</span>`;
}

function hasTestnetData(producer) {
  if (producer.sslVerifiedTestNet || producer.apiVerifiedTestNet) return true;
  return (producer.validationErrors || []).some((error) => /testnet/i.test(String(error)));
}

function isMainnetPassing(producer) {
  return Boolean(producer.sslVerified && producer.apiVerified);
}

function isTestnetPassing(producer) {
  return Boolean(producer.sslVerifiedTestNet && producer.apiVerifiedTestNet);
}

function formatDateTime(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function niceMax(value) {
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  let niceFraction = 1;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * base;
}

function makeTicks(max, count) {
  const ticks = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Math.round((max / count) * index));
  }
  return ticks;
}

function colorFor(index) {
  return PALETTE[index % PALETTE.length];
}

function getSafeUrl(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch (error) {
    return "";
  }
}

function stripProtocol(value) {
  return String(value).replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
