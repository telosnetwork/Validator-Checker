const AUTO_REFRESH_MS = 5 * 60 * 1000;
const SNAPSHOT_URL = "/validation/ifchecker/latest.json";
const PRODUCER_TABLE_COLUMNS = 7;

const state = {
  network: "testnet",
  data: null,
  results: {},
  loading: false,
  requestId: 0,
  refreshTimer: null,
  nextRefreshAt: null,
  lastRefreshError: "",
  query: "",
  filter: "all"
};

const elements = {
  tabs: [...document.querySelectorAll(".tab")],
  refresh: document.querySelector("#refresh"),
  refreshStatus: document.querySelector("#refresh-status"),
  statusBand: document.querySelector("#status-band"),
  statusMeta: document.querySelector("#status-meta"),
  metrics: document.querySelector("#metrics-grid"),
  gates: document.querySelector("#gates"),
  features: document.querySelector("#features"),
  rows: document.querySelector("#producer-rows"),
  caption: document.querySelector("#table-caption"),
  search: document.querySelector("#search"),
  filter: document.querySelector("#status-filter"),
  evidence: document.querySelector("#evidence"),
  copyJson: document.querySelector("#copy-json")
};

const statusText = {
  ok: "Ready",
  review: "Review",
  blocker: "Blocked",
  manual: "Manual",
  unknown: "Unknown"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function statusPill(status, label) {
  const normalized = status || "unknown";
  return `<span class="pill ${normalized}">${escapeHtml(label || statusText[normalized] || normalized)}</span>`;
}

function link(url, label) {
  if (!url) return "";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label || url)}</a>`;
}

async function loadNetwork(network = state.network, options = {}) {
  const { showLoading = true, reason = "manual" } = options;
  const requestId = state.requestId + 1;
  state.requestId = requestId;
  state.network = network;
  state.loading = true;
  updateRefreshUi(reason);
  if (showLoading || !state.data || state.data.network?.key !== network) {
    renderLoading("Fetching live RPC, schedule, finalizer tables, and BP metadata");
  }
  try {
    const response = await fetch(`/api/readiness/${network}?t=${Date.now()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    if (requestId !== state.requestId) return;
    state.data = payload;
    state.results[network] = payload;
    state.loading = false;
    state.lastRefreshError = "";
    scheduleAutoRefresh();
    render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.loading = false;
    if (!showLoading && state.data?.network?.key === network) {
      state.lastRefreshError = error.message;
      scheduleAutoRefresh();
      render();
      updateRefreshUi("error");
      return;
    }
    scheduleAutoRefresh();
    renderError(error);
  }
}

async function loadSnapshot() {
  state.loading = true;
  updateRefreshUi("snapshot");
  renderLoading("Loading latest readiness snapshot");
  try {
    const response = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`);
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || response.statusText);
    const networks = snapshot.networks || {};
    state.results = Object.fromEntries(
      Object.entries(networks).filter(([, result]) => result?.network?.key)
    );
    state.data = state.results[state.network] || Object.values(state.results)[0] || null;
    if (state.data) state.network = state.data.network.key;
    if (!state.data) throw new Error("Snapshot did not include IF checker results");
    state.loading = false;
    state.lastRefreshError = "";
    render();
    scheduleAutoRefresh();
  } catch (error) {
    state.loading = false;
    await loadNetwork(state.network, { showLoading: true, reason: "manual" });
  }
}

function selectNetwork(network) {
  state.network = network;
  if (state.results[network]) {
    state.data = state.results[network];
    render();
    updateRefreshUi();
    return;
  }
  loadNetwork(network, { showLoading: true, reason: "manual" });
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  state.refreshTimer = setTimeout(() => {
    if (document.hidden) {
      state.refreshTimer = null;
      state.nextRefreshAt = Date.now();
      updateRefreshUi();
      return;
    }
    loadNetwork(state.network, { showLoading: false, reason: "auto" });
  }, AUTO_REFRESH_MS);
  updateRefreshUi();
}

function updateRefreshUi(reason = "") {
  elements.refresh.disabled = state.loading;
  elements.refresh.textContent = state.loading ? "Refreshing" : "Refresh";
  if (!elements.refreshStatus) return;
  if (state.loading) {
    elements.refreshStatus.textContent = reason === "auto" ? "Auto updating" : "Updating";
    return;
  }
  if (reason === "error" || state.lastRefreshError) {
    elements.refreshStatus.textContent = "Last update failed";
    return;
  }
  if (!state.nextRefreshAt) {
    elements.refreshStatus.textContent = "";
    return;
  }
  elements.refreshStatus.textContent = `Next auto ${formatTime(state.nextRefreshAt)}`;
}

function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderLoading(message = "Loading readiness data") {
  elements.statusBand.innerHTML = `
    <div>
      <p class="label">Overall</p>
      <div class="status-title skeleton">Checking ${escapeHtml(state.network)}</div>
    </div>
    <div class="status-meta">${escapeHtml(message)}</div>
  `;
  elements.metrics.innerHTML = "";
  elements.gates.innerHTML = "";
  elements.features.innerHTML = "";
  elements.rows.innerHTML = "";
  elements.caption.textContent = "";
  elements.evidence.textContent = "";
}

function renderError(error) {
  elements.statusBand.innerHTML = `
    <div>
      <p class="label">Overall</p>
      <div class="status-title blocker">Check failed</div>
    </div>
    <div class="status-meta">${escapeHtml(error.message)}</div>
  `;
  elements.metrics.innerHTML = "";
  elements.gates.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  elements.features.innerHTML = "";
  elements.rows.innerHTML = "";
  elements.evidence.textContent = "";
}

function render() {
  const data = state.data;
  if (!data) return;
  elements.tabs.forEach((tab) => {
    const active = tab.dataset.network === state.network;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  renderStatus(data);
  renderMetrics(data);
  renderGates(data);
  renderFeatures(data);
  renderProducerRows(data);
  renderEvidence(data);
}

function renderStatus(data) {
  const overall = getBannerStatus(data);
  elements.statusBand.innerHTML = `
    <div>
      <p class="label">${escapeHtml(data.network.label)}</p>
      <div class="status-title ${overall.tone}">${escapeHtml(overall.label)}</div>
    </div>
    <div class="status-meta" id="status-meta">
      <div>${escapeHtml(data.network.rpc)}</div>
      <div>Head ${escapeHtml(data.info.headBlockNum)} by ${escapeHtml(data.info.headBlockProducer)}</div>
      <div>LIB lag ${escapeHtml(data.info.libLagBlocks)} blocks</div>
      <div>Updated ${escapeHtml(formatDate(data.generatedAt))} in ${escapeHtml(data.durationMs)}ms</div>
    </div>
  `;
  elements.statusMeta = document.querySelector("#status-meta");
}

function getBannerStatus(data) {
  const savannaGate = data.gates?.find((gate) => gate.key === "savanna");
  if (savannaGate?.status === "ok") {
    return {
      label: "Live",
      tone: "ok"
    };
  }

  const status = data.overallStatus;
  return {
    label: statusText[status] || status,
    tone: status
  };
}

function metric(label, value, tone = "") {
  return `
    <div class="metric">
      <p class="label">${escapeHtml(label)}</p>
      <div class="metric-value ${tone}">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderMetrics(data) {
  const springCompatible = data.counts.activeSpringCompatible ?? data.counts.springCompatible ?? data.counts.bpApiSpring;
  const publicP2pOk = data.counts.publicP2pOk;
  elements.metrics.innerHTML = [
    metric("Active BPs", data.counts.scheduled),
    metric("Standby BPs", data.counts.standby ?? 0),
    metric("Ready scheduled", data.counts.ready, "ok"),
    metric("Review scheduled", data.counts.review, "review"),
    metric("Blocked scheduled", data.counts.blocked, "blocker"),
    metric("Finalizers", `${data.counts.finalizersActive}/${data.counts.scheduled}`),
    metric("Spring-compatible active BPs", `${springCompatible}/${data.counts.scheduled}`),
    metric("Public live P2P", Number.isFinite(publicP2pOk) ? `${publicP2pOk}/${data.counts.scheduled}` : "Not checked")
  ].join("");
}

function renderGates(data) {
  elements.gates.innerHTML = data.gates.map((gate) => `
    <article class="gate">
      <div class="gate-title">
        <span>${escapeHtml(gate.label)}</span>
        ${statusPill(gate.status)}
      </div>
      <div class="gate-value">${escapeHtml(gate.value)}</div>
      <div class="gate-detail">${escapeHtml(gate.detail)}</div>
    </article>
  `).join("");
}

function renderFeatures(data) {
  elements.features.innerHTML = data.features.map((feature) => `
    <div class="feature">
      <span class="feature-name">${escapeHtml(feature.name)}</span>
      ${statusPill(feature.active ? "ok" : feature.name === "SAVANNA" ? "manual" : "blocker", feature.active ? "Active" : feature.name === "SAVANNA" ? "Pending" : "Missing")}
    </div>
  `).join("");
}

function producerMatchesFilters(producer) {
  const query = state.query.trim().toLowerCase();
  const matchesQuery = !query || producer.name.toLowerCase().includes(query);
  const matchesFilter = state.filter === "all" || producer.status === state.filter;
  return matchesQuery && matchesFilter;
}

function renderProducerRows(data) {
  const rows = groupProducerRowsBySchedule(data.producers.filter(producerMatchesFilters));
  const scheduledCount = rows.filter((producer) => producer.scheduleType === "active").length;
  const standbyCount = rows.filter((producer) => producer.scheduleType === "standby").length;
  elements.caption.textContent = `${rows.length} of ${data.producers.length} producers shown - ${scheduledCount} scheduled, ${standbyCount} standby`;
  elements.rows.innerHTML = renderProducerTableRows(data, rows);
}

function groupProducerRowsBySchedule(rows) {
  const sortedRows = [...rows].sort(compareByVoteRank);
  if (!shouldShowStandbyDivider(sortedRows)) return sortedRows;
  const scheduledRows = sortedRows.filter((producer) => producer.scheduleType === "active");
  const standbyRows = sortedRows.filter((producer) => producer.scheduleType === "standby");
  const otherRows = sortedRows.filter((producer) => !["active", "standby"].includes(producer.scheduleType));
  return [...scheduledRows, ...otherRows, ...standbyRows];
}

function compareByVoteRank(a, b) {
  const aRank = Number(a.rank);
  const bRank = Number(b.rank);
  const aValue = Number.isFinite(aRank) ? aRank : Number.MAX_SAFE_INTEGER;
  const bValue = Number.isFinite(bRank) ? bRank : Number.MAX_SAFE_INTEGER;
  if (aValue !== bValue) return aValue - bValue;
  return String(a.name || "").localeCompare(String(b.name || ""));
}

function shouldShowStandbyDivider(rows) {
  return rows.some((producer) => producer.scheduleType === "active")
    && rows.some((producer) => producer.scheduleType === "standby");
}

function renderProducerTableRows(data, rows) {
  let standbyDividerRendered = false;
  const hasDivider = shouldShowStandbyDivider(rows);
  return rows.map((producer) => {
    const needsDivider = hasDivider && !standbyDividerRendered && producer.scheduleType === "standby";
    standbyDividerRendered = standbyDividerRendered || needsDivider;
    return `${needsDivider ? renderStandbyDivider(rows) : ""}${renderProducerRow(data, producer)}`;
  }).join("");
}

function renderStandbyDivider(rows) {
  const standbyCount = rows.filter((producer) => producer.scheduleType === "standby").length;
  return `
    <tr class="schedule-divider">
      <td colspan="${PRODUCER_TABLE_COLUMNS}">
        <span class="schedule-divider-label">${escapeHtml(`Standby producers (${standbyCount})`)}</span>
      </td>
    </tr>
  `;
}

function renderProducerRow(data, producer) {
  const scheduled = producer.scheduleType !== "standby";
  const finalizerDisplay = getFinalizerDisplay(data, producer);
  const apiEndpoint = producer.api.endpoint ? link(producer.api.endpoint, producer.api.endpoint.replace(/^https?:\/\//, "")) : "";
  const p2p = producer.p2p || { status: "unknown", label: "Not checked", endpoint: "" };
  const p2pEndpoint = p2p.endpoint || (Array.isArray(p2p.endpoints) ? p2p.endpoints[0] : "");
  const rowNotes = [...producer.blockers, ...producer.warnings]
    .slice(0, 4)
    .map((note) => `<div>${escapeHtml(note)}</div>`)
    .join("");
  const voteRank = producer.rank || producer.schedulePosition || "-";
  const voteNote = producer.votesCompact ? `<span class="small-note">votes ${escapeHtml(producer.votesCompact)}</span>` : "";
  const scheduleLabel = scheduled
    ? `<span class="standby-rank">#${escapeHtml(voteRank)}</span>${voteNote}`
    : `<span class="standby-rank">Standby</span><span class="small-note">rank ${escapeHtml(voteRank)}</span>${voteNote}`;

  return `
      <tr>
        <td>
          <div class="bp-name">${escapeHtml(producer.name)}</div>
          <span class="bp-url">${producer.url ? link(producer.url, producer.url) : "No BP URL"}</span>
        </td>
        <td>${scheduleLabel}</td>
        <td>
          ${statusPill(finalizerDisplay.status, finalizerDisplay.label)}
          <span class="small-note">${escapeHtml(producer.finalizer.tables.join(", ") || "No table row")}</span>
        </td>
        <td>
          ${statusPill(producer.api.status, producer.api.label)}
          <span class="small-note">${escapeHtml(producer.api.version || "")}</span>
          <span class="small-note">${apiEndpoint}</span>
        </td>
        <td>
          ${statusPill(p2p.status, p2p.label)}
          <span class="small-note">${escapeHtml(p2pEndpoint || "")}</span>
        </td>
        <td>
          ${escapeHtml(producer.missedBlocksPerRotation)}
          <span class="small-note">life ${escapeHtml(producer.lifetimeMissedBlocks)}</span>
        </td>
        <td>
          ${statusPill(producer.status)}
          <div class="row-notes">${rowNotes}</div>
        </td>
      </tr>
    `;
}

function getFinalizerDisplay(data, producer) {
  const scheduled = producer.scheduleType !== "standby";
  const tablesAvailable = data.finalizerTables.every((table) => table.ok);

  if (!tablesAvailable) {
    return {
      label: "Table unavailable",
      status: scheduled ? "blocker" : "unknown"
    };
  }

  if (producer.finalizer.active) {
    return {
      label: "Active",
      status: "ok"
    };
  }

  if (producer.finalizer.registered) {
    return {
      label: "Registered",
      status: scheduled ? "blocker" : "review"
    };
  }

  return {
    label: "Missing",
    status: scheduled ? "blocker" : "manual"
  };
}

function renderEvidence(data) {
  const slim = {
    network: data.network,
    generatedAt: data.generatedAt,
    overallStatus: data.overallStatus,
    info: data.info,
    counts: data.counts,
    gates: data.gates,
    finalizerTables: data.finalizerTables,
    sourceNotes: data.sourceNotes
  };
  elements.evidence.textContent = JSON.stringify(slim, null, 2);
}

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => selectNetwork(tab.dataset.network));
});

elements.refresh.addEventListener("click", () => loadNetwork(state.network, { showLoading: false, reason: "manual" }));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.nextRefreshAt && Date.now() >= state.nextRefreshAt) {
    loadNetwork(state.network, { showLoading: false, reason: "auto" });
  }
});

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  if (state.data) renderProducerRows(state.data);
});

elements.filter.addEventListener("change", (event) => {
  state.filter = event.target.value;
  if (state.data) renderProducerRows(state.data);
});

elements.copyJson.addEventListener("click", async () => {
  if (!state.data) return;
  await navigator.clipboard.writeText(JSON.stringify(state.data, null, 2));
  elements.copyJson.textContent = "Copied";
  setTimeout(() => {
    elements.copyJson.textContent = "Copy JSON";
  }, 1200);
});

loadSnapshot();
