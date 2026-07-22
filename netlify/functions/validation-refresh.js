const DEFAULT_REPOSITORY = "telosnetwork/Validator-Checker";
const DEFAULT_WORKFLOW_ID = "validate.yml";
const DEFAULT_REF = "main";
const DEFAULT_MIN_INTERVAL_SECONDS = 300;

const repository = process.env.VALIDATION_REPOSITORY || process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
const workflowId = process.env.VALIDATION_WORKFLOW_ID || DEFAULT_WORKFLOW_ID;
const workflowRef = process.env.VALIDATION_WORKFLOW_REF || DEFAULT_REF;
const token = process.env.VALIDATION_WORKFLOW_TOKEN || process.env.GITHUB_TOKEN || "";
const minIntervalSeconds = Number.parseInt(
  process.env.VALIDATION_REFRESH_MIN_INTERVAL_SECONDS || String(DEFAULT_MIN_INTERVAL_SECONDS),
  10,
);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (!["GET", "POST"].includes(event.httpMethod)) {
    return json(405, {
      status: "method_not_allowed",
      error: "Use GET to inspect the latest validation run or POST to request a refresh.",
    });
  }

  if (!token) {
    return json(503, {
      status: "not_configured",
      error: "Manual refresh is not configured for this deployment.",
    });
  }

  try {
    const runs = await listWorkflowRuns();
    const latestRun = runs[0] || null;

    if (event.httpMethod === "GET") {
      return json(200, {
        status: publicRunStatus(latestRun),
        run: compactRun(latestRun),
      });
    }

    const activeRun = runs.find((run) => run.status && run.status !== "completed");
    if (activeRun) {
      return json(202, {
        status: publicRunStatus(activeRun),
        message: "A validation refresh is already running.",
        run: compactRun(activeRun),
      });
    }

    const recentRun = latestRun
      && latestRun.conclusion === "success"
      && secondsSince(latestRun.created_at) < safeMinIntervalSeconds();
    if (recentRun) {
      return json(200, {
        status: "recent",
        message: "Validation was refreshed recently.",
        cooldownSeconds: Math.max(0, safeMinIntervalSeconds() - secondsSince(latestRun.created_at)),
        run: compactRun(latestRun),
      });
    }

    const dispatchedAfter = Date.now();
    await dispatchWorkflow();
    await sleep(1200);

    const updatedRuns = await listWorkflowRuns();
    const dispatchedRun = updatedRuns.find((run) => (
      run.event === "workflow_dispatch"
      && new Date(run.created_at).getTime() >= dispatchedAfter - 10000
    )) || updatedRuns.find((run) => run.status && run.status !== "completed") || updatedRuns[0] || null;

    return json(202, {
      status: publicRunStatus(dispatchedRun) === "unknown" ? "queued" : publicRunStatus(dispatchedRun),
      message: "Validation refresh queued.",
      run: compactRun(dispatchedRun),
    });
  } catch (error) {
    return json(error.status || 500, {
      status: "error",
      error: error.message || "Unable to refresh validation results.",
    });
  }
};

async function listWorkflowRuns() {
  const params = new URLSearchParams({
    branch: workflowRef,
    per_page: "10",
  });
  const data = await github(`/actions/workflows/${encodeURIComponent(workflowId)}/runs?${params}`);
  return Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
}

async function dispatchWorkflow() {
  await github(`/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: workflowRef }),
  });
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "telos-validator-checker",
    },
    body: options.body,
  });

  if (response.status === 204) return null;

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { message: text };
  }

  if (!response.ok) {
    const error = new Error(data.message || `GitHub API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function publicRunStatus(run) {
  if (!run) return "unknown";
  if (run.status === "queued" || run.status === "waiting" || run.status === "requested") return "queued";
  if (run.status && run.status !== "completed") return "running";
  if (run.conclusion === "success") return "completed";
  if (run.conclusion) return "failed";
  return "unknown";
}

function compactRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    url: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function secondsSince(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - time) / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMinIntervalSeconds() {
  return Number.isFinite(minIntervalSeconds) && minIntervalSeconds >= 0
    ? minIntervalSeconds
    : DEFAULT_MIN_INTERVAL_SECONDS;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: statusCode === 204 ? "" : JSON.stringify(body),
  };
}
