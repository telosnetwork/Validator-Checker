const LIVE_ENDPOINT = "/api/readiness/mainnet";
const SNAPSHOT_ENDPOINT = "/validation/ifchecker/latest.json";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const elements = {
  dataState: document.querySelector("#dataState"),
  dataStateText: document.querySelector("#dataStateText"),
  heroPhase: document.querySelector("#heroPhase"),
  progressPercent: document.querySelector("#progressPercent"),
  progressTrack: document.querySelector("#progressTrack"),
  progressFill: document.querySelector("#progressFill"),
  stepsComplete: document.querySelector("#stepsComplete"),
  updatedAt: document.querySelector("#updatedAt"),
  foundationStatus: document.querySelector("#foundationStatus"),
  foundationEvidence: document.querySelector("#foundationEvidence"),
  contractStatus: document.querySelector("#contractStatus"),
  contractEvidence: document.querySelector("#contractEvidence"),
  finalizerStatus: document.querySelector("#finalizerStatus"),
  finalizerEvidence: document.querySelector("#finalizerEvidence"),
  activationStatus: document.querySelector("#activationStatus"),
  activationEvidence: document.querySelector("#activationEvidence"),
  activeCount: document.querySelector("#activeCount"),
  scheduledCount: document.querySelector("#scheduledCount"),
  registeredCount: document.querySelector("#registeredCount"),
  activeStatCount: document.querySelector("#activeStatCount"),
  networkState: document.querySelector("#networkState"),
  finalizerMeter: document.querySelector("#finalizerMeter"),
  finalizerSummary: document.querySelector("#finalizerSummary"),
  footerUpdate: document.querySelector("#footerUpdate")
};

function getGate(data, key) {
  return data.gates?.find((gate) => gate.key === key);
}

function isGateReady(data, key) {
  return getGate(data, key)?.status === "ok";
}

function formatUpdatedAt(value, source) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return source === "live" ? "Live mainnet data" : "Recent mainnet snapshot";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${source === "live" ? "Live refresh" : "Snapshot"} ${time}`;
}

function setDataState(source, isRefreshing = false) {
  elements.dataState.classList.toggle("is-live", source === "live" && !isRefreshing);
  elements.dataState.classList.toggle("is-error", source === "error");
  if (source === "error") {
    elements.dataStateText.textContent = "Live data unavailable";
  } else if (isRefreshing) {
    elements.dataStateText.textContent = "Refreshing mainnet";
  } else {
    elements.dataStateText.textContent = source === "live" ? "Live mainnet data" : "Recent mainnet snapshot";
  }
}

function setMilestone(id, status, label, evidence) {
  const milestone = document.querySelector(`#step-${id}`);
  milestone.classList.remove("is-complete", "is-active", "is-waiting", "is-live");
  milestone.classList.add(`is-${status}`);
  elements[`${id}Status`].textContent = label;
  elements[`${id}Evidence`].textContent = evidence;
}

function renderMeter(scheduled, registered, active) {
  const safeScheduled = Math.max(0, Math.min(40, scheduled));
  elements.finalizerMeter.style.setProperty("--segments", String(Math.max(1, safeScheduled)));
  elements.finalizerMeter.innerHTML = Array.from({ length: safeScheduled }, (_, index) => {
    const state = index < active ? "is-active" : index < registered ? "is-registered" : "is-pending";
    const label = index < active ? "Active finalizer" : index < registered ? "Registered finalizer" : "Pending finalizer";
    return `<span class="meter-segment ${state}" title="${label}" aria-label="${label}"></span>`;
  }).join("");
}

function render(data, source) {
  const scheduled = Number(data.counts?.scheduled) || 0;
  const registered = Math.min(scheduled, Number(data.counts?.finalizersRegistered) || 0);
  const active = Math.min(scheduled, Number(data.counts?.finalizersActive) || 0);

  const foundationComplete = isGateReady(data, "public-rpc")
    && isGateReady(data, "features")
    && isGateReady(data, "bls");
  const contractComplete = isGateReady(data, "contract") && isGateReady(data, "tables");
  const finalizersComplete = scheduled > 0 && active === scheduled;
  const protocolReady = isGateReady(data, "savanna");
  const finalityLag = Number(data.info?.libLagBlocks);
  const lightspeedLive = finalizersComplete
    && protocolReady
    && Number.isFinite(finalityLag)
    && finalityLag <= 12;

  const activeRatio = scheduled > 0 ? active / scheduled : 0;
  const progressPoints = Number(foundationComplete)
    + Number(contractComplete)
    + activeRatio
    + Number(lightspeedLive);
  const progress = Math.max(0, Math.min(100, Math.round((progressPoints / 4) * 100)));
  const completeSteps = [foundationComplete, contractComplete, finalizersComplete, lightspeedLive].filter(Boolean).length;

  let phase = "Preparing network foundation";
  if (foundationComplete) phase = "Upgrading the system contract";
  if (contractComplete) phase = active > 0 ? "Finalizers are coming online" : "Finalizer registration is next";
  if (finalizersComplete) phase = "Ready for final activation";
  if (lightspeedLive) phase = "Lightspeed is live";

  elements.heroPhase.textContent = phase;
  elements.progressPercent.textContent = String(progress);
  elements.progressFill.style.width = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(progress));
  elements.stepsComplete.textContent = String(completeSteps);
  elements.updatedAt.textContent = formatUpdatedAt(data.generatedAt, source);

  setMilestone(
    "foundation",
    foundationComplete ? "complete" : "active",
    foundationComplete ? "Complete" : "In progress",
    foundationComplete ? "Required software and protocol features are active" : "Network prerequisites are still being verified"
  );
  setMilestone(
    "contract",
    contractComplete ? "complete" : foundationComplete ? "active" : "waiting",
    contractComplete ? "Complete" : foundationComplete ? "In progress" : "Waiting",
    contractComplete ? "Finalizer actions and tables are available on mainnet" : "Waiting for the system contract checkpoint"
  );
  setMilestone(
    "finalizer",
    finalizersComplete ? "complete" : contractComplete ? "active" : "waiting",
    finalizersComplete ? "Complete" : contractComplete ? (registered > 0 ? "In progress" : "Next") : "Waiting",
    scheduled > 0 ? `${registered}/${scheduled} registered - ${active}/${scheduled} active` : "Waiting for the active schedule"
  );
  setMilestone(
    "activation",
    lightspeedLive ? "live" : finalizersComplete ? "active" : "waiting",
    lightspeedLive ? "Live" : finalizersComplete ? "Ready" : "Waiting",
    lightspeedLive ? "Mainnet is operating with near-instant finality" : finalizersComplete ? "Final network checks can now complete" : "Begins after scheduled finalizers are active"
  );

  elements.activeCount.textContent = String(active);
  elements.scheduledCount.textContent = String(scheduled || "--");
  elements.registeredCount.textContent = scheduled ? `${registered}/${scheduled}` : "--";
  elements.activeStatCount.textContent = scheduled ? `${active}/${scheduled}` : "--";
  elements.networkState.textContent = data.info?.headBlockNum ? (source === "live" ? "Online" : "Last seen") : "Checking";
  elements.finalizerSummary.textContent = finalizersComplete
    ? "Scheduled finalizers are active. The rollout is moving through final activation checks."
    : "Every scheduled producer needs an active finalizer before the final switch.";
  elements.footerUpdate.textContent = `${formatUpdatedAt(data.generatedAt, source)} - refreshes automatically`;
  renderMeter(scheduled, registered, active);
  setDataState(source);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function loadSnapshot() {
  const snapshot = await fetchJson(SNAPSHOT_ENDPOINT, 12000);
  const mainnet = snapshot.networks?.mainnet;
  if (!mainnet) throw new Error("Mainnet snapshot unavailable");
  render(mainnet, "snapshot");
}

async function refreshLive() {
  setDataState("snapshot", true);
  try {
    const data = await fetchJson(LIVE_ENDPOINT, 90000);
    render(data, "live");
  } catch (error) {
    if (!elements.progressTrack.getAttribute("aria-valuenow") || elements.progressTrack.getAttribute("aria-valuenow") === "0") {
      setDataState("error");
      elements.heroPhase.textContent = "Live checkpoint unavailable";
      elements.updatedAt.textContent = "Please check again shortly";
    } else {
      setDataState("snapshot");
    }
  }
}

async function start() {
  try {
    await loadSnapshot();
  } catch (error) {
    setDataState("snapshot", true);
  }
  await refreshLive();
  setInterval(refreshLive, REFRESH_INTERVAL_MS);
}

start();
