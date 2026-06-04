const state = {
  network: "testnet",
  data: null,
  loading: false,
  query: "",
  filter: "all"
};

const elements = {
  tabs: [...document.querySelectorAll(".tab")],
  refresh: document.querySelector("#refresh"),
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

async function loadNetwork(network = state.network) {
  state.network = network;
  state.loading = true;
  renderLoading();
  try {
    const response = await fetch(`/api/readiness/${network}?t=${Date.now()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    state.data = payload;
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    renderError(error);
  }
}

function renderLoading() {
  elements.statusBand.innerHTML = `
    <div>
      <p class="label">Overall</p>
      <div class="status-title skeleton">Checking ${escapeHtml(state.network)}</div>
    </div>
    <div class="status-meta">Fetching live RPC, schedule, finalizer tables, and BP metadata</div>
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
  const overall = data.overallStatus;
  elements.statusBand.innerHTML = `
    <div>
      <p class="label">${escapeHtml(data.network.label)}</p>
      <div class="status-title ${overall}">${escapeHtml(statusText[overall] || overall)}</div>
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
  elements.metrics.innerHTML = [
    metric("Active BPs", data.counts.scheduled),
    metric("Ready rows", data.counts.ready, "ok"),
    metric("Blocked rows", data.counts.blocked, "blocker"),
    metric("Finalizers", `${data.counts.finalizersActive}/${data.counts.scheduled}`),
    metric("Spring-compatible active BPs", `${springCompatible}/${data.counts.scheduled}`)
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
  const rows = data.producers.filter(producerMatchesFilters);
  elements.caption.textContent = `${rows.length} of ${data.producers.length} scheduled producers shown`;
  elements.rows.innerHTML = rows.map((producer) => {
    const finalizerLabel = !data.finalizerTables.every((table) => table.ok)
      ? "Table unavailable"
      : producer.finalizer.active
        ? "Active"
        : producer.finalizer.registered
          ? "Registered"
          : "Missing";
    const finalizerStatus = !data.finalizerTables.every((table) => table.ok)
      ? "blocker"
      : producer.finalizer.active
        ? "ok"
        : "blocker";
    const apiEndpoint = producer.api.endpoint ? link(producer.api.endpoint, producer.api.endpoint.replace(/^https?:\/\//, "")) : "";
    const rowNotes = [...producer.blockers, ...producer.warnings]
      .slice(0, 4)
      .map((note) => `<div>${escapeHtml(note)}</div>`)
      .join("");
    return `
      <tr>
        <td>
          <div class="bp-name">${escapeHtml(producer.name)}</div>
          <span class="bp-url">${producer.url ? link(producer.url, producer.url) : "No BP URL"}</span>
        </td>
        <td>#${escapeHtml(producer.schedulePosition)}</td>
        <td>${escapeHtml(producer.votesCompact)}</td>
        <td>
          ${statusPill(finalizerStatus, finalizerLabel)}
          <span class="small-note">${escapeHtml(producer.finalizer.tables.join(", ") || "No table row")}</span>
        </td>
        <td>
          ${statusPill(producer.api.status, producer.api.label)}
          <span class="small-note">${escapeHtml(producer.api.version || "")}</span>
          <span class="small-note">${apiEndpoint}</span>
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
  }).join("");
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
  tab.addEventListener("click", () => loadNetwork(tab.dataset.network));
});

elements.refresh.addEventListener("click", () => loadNetwork(state.network));

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

loadNetwork("testnet");
