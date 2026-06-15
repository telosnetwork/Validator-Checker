const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");

const NETWORKS = {
  testnet: {
    key: "testnet",
    label: "Testnet",
    rpc: process.env.TELOS_TESTNET_RPC || "https://testnet.telos.caleos.io",
    chainId: "1eaa0824707c8c16bd25145493bf062aecddfeb56c736f6ba6397f3195f33c9f"
  },
  mainnet: {
    key: "mainnet",
    label: "Mainnet",
    rpc: process.env.TELOS_MAINNET_RPC || "https://mainnet.telos.net",
    chainId: "4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11"
  }
};

const REQUIRED_FEATURES = [
  "DISABLE_DEFERRED_TRXS_STAGE_1",
  "DISABLE_DEFERRED_TRXS_STAGE_2",
  "WTMSIG_BLOCK_SIGNATURES",
  "BLS_PRIMITIVES2",
  "DISALLOW_EMPTY_PRODUCER_SCHEDULE",
  "ACTION_RETURN_VALUE",
  "ONLY_LINK_TO_EXISTING_PERMISSION",
  "FORWARD_SETCODE",
  "GET_BLOCK_NUM",
  "REPLACE_DEFERRED",
  "NO_DUPLICATE_DEFERRED_ID",
  "RAM_RESTRICTIONS",
  "WEBAUTHN_KEY",
  "BLOCKCHAIN_PARAMETERS",
  "CRYPTO_PRIMITIVES",
  "ONLY_BILL_FIRST_AUTHORIZER",
  "RESTRICT_ACTION_TO_SELF",
  "GET_CODE_HASH",
  "CONFIGURABLE_WASM_LIMITS2",
  "FIX_LINKAUTH_RESTRICTION",
  "GET_SENDER",
  "SAVANNA"
];

const FINALIZER_ACTIONS = ["regfinkey", "actfinkey", "delfinkey", "switchtosvnn"];
const FINALIZER_TABLES = ["finkeys", "finalizers"];
const PUBLIC_RPC_TIMEOUT_MS = 12_000;
const BP_METADATA_TIMEOUT_MS = 20_000;
const BP_API_TIMEOUT_MS = 4_000;
const BP_P2P_TIMEOUT_MS = 5_000;
const NET_VERSION_BASE = 0x04B5;
const NET_VERSION_MAX = 12;
const HANDSHAKE_MESSAGE_TYPE = 0;
const GO_AWAY_MESSAGE_TYPE = 2;
const MAX_P2P_MESSAGE_SIZE = 16 * 1024 * 1024;
const TEMP_TESTNET_ENDPOINTS = {
  tempbpfill11: { api: "http://38.49.217.195:8889", p2p: "38.49.217.195:9878" },
  tempbpfill22: { api: "http://38.49.217.195:8890", p2p: "38.49.217.195:9879" },
  tempbpfill33: { api: "http://38.49.217.195:8891", p2p: "38.49.217.195:9880" },
  tempbpfill44: { api: "http://38.49.217.195:8892", p2p: "38.49.217.195:9881" },
  tempbpfill55: { api: "http://38.49.217.195:8893", p2p: "38.49.217.195:9882" },
  tempbpfillaa: { api: "http://38.49.217.195:8894", p2p: "38.49.217.195:9883" },
  tempbpfillbb: { api: "http://38.49.217.195:8895", p2p: "38.49.217.195:9884" },
  tempbpfillcc: { api: "http://38.49.217.195:8896", p2p: "38.49.217.195:9885" },
  tempbpfilldd: { api: "http://38.49.217.195:8897", p2p: "38.49.217.195:9886" }
};

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PUBLIC_RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcPost(network, pathName, body = {}, timeoutMs = PUBLIC_RPC_TIMEOUT_MS) {
  const response = await fetchWithTimeout(`${network.rpc}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(body)
  }, timeoutMs);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error?.details?.[0]?.message || payload?.message || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function getAllTableRows(network, table, limit = 200) {
  const rows = [];
  let lowerBound = "";
  let previousNextKey = null;
  for (let page = 0; page < 50; page += 1) {
    const body = {
      json: true,
      code: "eosio",
      scope: "eosio",
      table,
      limit
    };
    if (lowerBound) body.lower_bound = lowerBound;
    const payload = await rpcPost(network, "/v1/chain/get_table_rows", body);
    rows.push(...(payload.rows || []));
    if (!payload.more || !payload.next_key || payload.next_key === previousNextKey) break;
    previousNextKey = payload.next_key;
    lowerBound = payload.next_key;
  }
  return rows;
}

async function safeTableRows(network, table) {
  try {
    return { table, ok: true, rows: await getAllTableRows(network, table) };
  } catch (error) {
    return {
      table,
      ok: false,
      rows: [],
      error: error.message,
      status: error.status || null
    };
  }
}

function producerKeyFromScheduleEntry(entry) {
  if (entry.block_signing_key) return entry.block_signing_key;
  const authorityKeys = entry.authority?.[1]?.keys;
  return Array.isArray(authorityKeys) && authorityKeys[0] ? authorityKeys[0].key : "";
}

function codenameFromFeature(feature) {
  const pair = feature.specification?.find((item) => item.name === "builtin_feature_codename");
  return pair?.value || "UNKNOWN";
}

function classifyVersion(info) {
  const version = String(info?.server_version_string || info?.server_full_version_string || "").trim();
  const fullVersion = String(info?.server_full_version_string || "").trim();
  const combined = `${version} ${fullVersion}`.toLowerCase();
  if (!version && !fullVersion) {
    return { status: "unknown", label: "Unknown", version: "" };
  }
  if (/spring/.test(combined) || /^v?1\./i.test(version)) {
    return { status: "ok", label: "Spring", version: version || fullVersion };
  }
  if (/^v?2\./i.test(version)) {
    return { status: "review", label: "Spring dev/review", version: version || fullVersion };
  }
  if (/^v?[45]\./i.test(version) || /leap/.test(combined)) {
    return { status: "blocker", label: "Leap or non-Spring", version: version || fullVersion };
  }
  return { status: "review", label: "Review version", version: version || fullVersion };
}

function getOriginPathUrl(rawValue) {
  if (!rawValue || typeof rawValue !== "string") return null;
  const trimmed = rawValue.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function metadataUrl(baseUrl, metadataPath) {
  const cleanPath = String(metadataPath || "").trim();
  if (!cleanPath) return baseUrl;
  try {
    const parsed = new URL(cleanPath);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    // Resolve relative paths below.
  }
  return `${baseUrl.replace(/\/+$/, "")}/${cleanPath.replace(/^\/+/, "")}`;
}

function metadataFallbackUrl(baseUrl, fileName) {
  const parsed = getOriginPathUrl(baseUrl);
  if (!parsed) return null;
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${fileName}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function metadataFallbackFileNames(network) {
  const fileNames = network.key === "testnet"
    ? ["testnet.json", "bp.json", "telos.json"]
    : ["bp.json", "mainnet.json", "telos.json"];
  return [...new Set(fileNames)];
}

function normalizeApiBase(rawUrl) {
  const parsed = getOriginPathUrl(rawUrl);
  if (!parsed) return null;
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname
    .replace(/\/v1\/chain\/get_info\/?$/i, "")
    .replace(/\/v1\/chain\/?$/i, "")
    .replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function addCandidate(candidates, rawUrl) {
  const normalized = normalizeApiBase(rawUrl);
  if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
}

function normalizeP2pEndpoint(rawValue) {
  if (!rawValue || typeof rawValue !== "string") return "";
  return rawValue
    .trim()
    .replace(/^p2p:\/\//i, "")
    .replace(/^tcp:\/\//i, "")
    .replace(/\/+$/, "");
}

function addP2pCandidate(candidates, rawValue) {
  const endpoint = normalizeP2pEndpoint(rawValue);
  if (endpoint && !candidates.includes(endpoint)) candidates.push(endpoint);
}

function tempTestnetEndpointOverride(network, producerName) {
  if (network.key !== "testnet") return null;
  return TEMP_TESTNET_ENDPOINTS[producerName] || null;
}

function endpointNetworkMismatch(endpoint, network) {
  const { host } = parseP2pEndpoint(endpoint);
  const value = `${host || endpoint}`.toLowerCase();
  if (!value) return "";

  const testnetPattern = /(^|[.\-_])(testnet|test)([.\-_]|$)|telostest|telos-test/i;
  const mainnetPattern = /(^|[.\-_])(mainnet|main)([.\-_]|$)|telosmain|telos-main/i;

  if (network.key === "testnet" && mainnetPattern.test(value)) return "Mainnet";
  if (network.key === "mainnet" && testnetPattern.test(value)) return "Testnet";
  return "";
}

async function fetchJsonGet(url, timeoutMs) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "accept": "application/json,text/plain,*/*",
      "user-agent": "TelosInstantFinalityReadinessChecker/1.0"
    }
  }, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("response was not valid JSON");
  }
}

async function resolveBpMetadata(network, rawUrl) {
  const result = {
    ok: false,
    url: "",
    source: "",
    json: null,
    errors: []
  };
  const base = getOriginPathUrl(rawUrl);
  if (!base) {
    result.errors.push("No usable producer URL registered on chain");
    return result;
  }

  base.hash = "";
  base.search = "";
  const baseUrl = base.toString().replace(/\/+$/, "");

  if (/\.json$/i.test(base.pathname)) {
    try {
      result.json = await fetchJsonGet(base.toString(), BP_METADATA_TIMEOUT_MS);
      result.url = base.toString();
      result.source = "registered-json";
      result.ok = true;
      return result;
    } catch (error) {
      result.errors.push(`${base.toString()}: ${error.message}`);
    }
  }

  try {
    const chainsUrl = metadataUrl(baseUrl, "chains.json");
    const chainsData = await fetchJsonGet(chainsUrl, BP_METADATA_TIMEOUT_MS);
    const chainPath = chainsData?.chains?.[network.chainId];
    if (chainPath) {
      const chainMetadataUrl = metadataUrl(baseUrl, chainPath);
      try {
        result.json = await fetchJsonGet(chainMetadataUrl, BP_METADATA_TIMEOUT_MS);
        result.url = chainMetadataUrl;
        result.source = "chains.json";
        result.ok = true;
        return result;
      } catch (error) {
        result.errors.push(`${chainMetadataUrl}: ${error.message}`);
      }
    } else {
      result.errors.push(`${chainsUrl}: no path for ${network.label}`);
    }
  } catch (error) {
    result.errors.push(`${metadataUrl(baseUrl, "chains.json")}: ${error.message}`);
  }

  for (const fileName of metadataFallbackFileNames(network)) {
    const fallbackUrl = metadataFallbackUrl(baseUrl, fileName);
    if (!fallbackUrl) continue;
    try {
      result.json = await fetchJsonGet(fallbackUrl, BP_METADATA_TIMEOUT_MS);
      result.url = fallbackUrl;
      result.source = "fallback";
      result.ok = true;
      return result;
    } catch (error) {
      result.errors.push(`${fallbackUrl}: ${error.message}`);
    }
  }

  return result;
}

function nodeTypes(node) {
  const rawType = node?.node_type || "";
  return Array.isArray(rawType) ? rawType : [rawType];
}

function endpointsFromBpJson(bpJson) {
  const endpoints = [];
  const nodes = Array.isArray(bpJson?.nodes) ? bpJson.nodes : [];

  function addFromNode(node) {
    for (const key of ["ssl_endpoint", "api_endpoint"]) {
      const value = node?.[key];
      if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        addCandidate(endpoints, value);
      }
    }
  }

  for (const preferredType of ["query", "producer", "seed"]) {
    for (const node of nodes) {
      if (nodeTypes(node).includes(preferredType)) addFromNode(node);
    }
  }
  for (const node of nodes) addFromNode(node);
  return endpoints;
}

function p2pEndpointsFromBpJson(bpJson) {
  const endpoints = [];
  const nodes = Array.isArray(bpJson?.nodes) ? bpJson.nodes : [];

  function addFromNode(node) {
    addP2pCandidate(endpoints, node?.p2p_endpoint);
  }

  for (const preferredType of ["seed", "producer", "query"]) {
    for (const node of nodes) {
      if (nodeTypes(node).includes(preferredType)) addFromNode(node);
    }
  }
  for (const node of nodes) addFromNode(node);
  return endpoints;
}

async function getInfoFromEndpoint(baseUrl) {
  const url = `${baseUrl}/v1/chain/get_info`;
  const headers = {
    "accept": "application/json",
    "user-agent": "TelosInstantFinalityReadinessChecker/1.0"
  };
  let lastError;
  for (const method of ["GET", "POST"]) {
    try {
      const response = await fetchWithTimeout(url, {
        method,
        headers: method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
        body: method === "POST" ? "{}" : undefined
      }, BP_API_TIMEOUT_MS);
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchBpApiStatus(network, producer, metadataOverride = null) {
  const result = {
    status: "unknown",
    label: "No matching public API",
    endpoint: "",
    version: "",
    bpJsonUrl: "",
    bpJsonSource: "",
    bpJsonStatus: "unknown",
    bpJsonError: "",
    endpoints: [],
    attempts: []
  };
  const candidates = [];
  const tempOverride = tempTestnetEndpointOverride(network, producer.name);
  if (tempOverride) addCandidate(candidates, tempOverride.api);
  const metadata = metadataOverride || await resolveBpMetadata(network, producer.url);
  result.bpJsonUrl = metadata.url;
  result.bpJsonSource = metadata.source;
  if (metadata.ok) {
    result.bpJsonStatus = "ok";
    for (const endpoint of endpointsFromBpJson(metadata.json)) addCandidate(candidates, endpoint);
  } else {
    result.bpJsonStatus = "error";
    result.bpJsonError = metadata.errors.join(" | ");
  }
  addCandidate(candidates, producer.url);
  result.endpoints = candidates.slice(0, 8);

  for (const endpoint of candidates.slice(0, 8)) {
    try {
      const info = await getInfoFromEndpoint(endpoint);
      const version = classifyVersion(info);
      const chainMatches = info.chain_id === network.chainId;
      result.attempts.push({
        endpoint,
        ok: true,
        chainId: info.chain_id || "",
        version: version.version || "",
        chainMatches
      });
      if (chainMatches) {
        result.status = version.status;
        result.label = version.label;
        result.endpoint = endpoint;
        result.version = version.version;
        return result;
      }
    } catch (error) {
      result.attempts.push({ endpoint, ok: false, error: error.message });
    }
  }
  if (result.attempts.some((attempt) => attempt.ok && !attempt.chainMatches)) {
    result.status = "review";
    result.label = `Published endpoint is not ${network.label}`;
  }
  return result;
}

function parseP2pEndpoint(endpoint) {
  const normalized = normalizeP2pEndpoint(endpoint);
  if (!normalized) return { host: "", port: 0 };
  try {
    const parsed = new URL(`tcp://${normalized}`);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 0)
    };
  } catch {
    return { host: "", port: 0 };
  }
}

function packVaruint(value) {
  if (value < 0) throw new Error("varuint must be non-negative");
  const bytes = [];
  let next = value;
  do {
    let byte = next & 0x7f;
    next >>= 7;
    if (next) byte |= 0x80;
    bytes.push(byte);
  } while (next);
  return Buffer.from(bytes);
}

function unpackVaruint(buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, cursor];
    shift += 7;
    if (shift > 35) throw new Error("varuint too large");
  }
  throw new Error("unexpected end of payload while reading varuint");
}

function packString(value) {
  const body = Buffer.from(String(value), "utf8");
  return Buffer.concat([packVaruint(body.length), body]);
}

function emptyPublicKeyBytes() {
  return Buffer.concat([packVaruint(0), Buffer.alloc(33)]);
}

function emptySignatureBytes() {
  return Buffer.concat([packVaruint(0), Buffer.alloc(65)]);
}

function makeHandshakePayload(expectedChainId) {
  const nodeId = crypto.randomBytes(32);
  const networkVersion = Buffer.alloc(2);
  networkVersion.writeUInt16LE(NET_VERSION_BASE + NET_VERSION_MAX, 0);

  const timestamp = Buffer.alloc(8);
  timestamp.writeBigInt64LE(BigInt(Date.now()) * 1_000_000n, 0);

  const zero32 = Buffer.alloc(32);
  const zero4 = Buffer.alloc(4);
  const generation = Buffer.alloc(2);
  generation.writeInt16LE(1, 0);

  return Buffer.concat([
    packVaruint(HANDSHAKE_MESSAGE_TYPE),
    networkVersion,
    Buffer.from(expectedChainId, "hex"),
    nodeId,
    emptyPublicKeyBytes(),
    timestamp,
    zero32,
    emptySignatureBytes(),
    packString(`127.0.0.1:0 - ${nodeId.toString("hex").slice(0, 7)}`),
    zero4,
    zero32,
    zero4,
    zero32,
    packString("linux"),
    packString("Telos IF Readiness Checker"),
    generation
  ]);
}

function parseMessageType(payload) {
  return unpackVaruint(payload, 0)[0];
}

function handshakeMatchesChain(payload, expectedChainId) {
  const [, offsetAfterType] = unpackVaruint(payload, 0);
  const chainOffset = offsetAfterType + 2;
  if (chainOffset + 32 > payload.length) return false;
  return payload.subarray(chainOffset, chainOffset + 32).equals(Buffer.from(expectedChainId, "hex"));
}

function checkP2pHandshake(endpoint, expectedChainId) {
  const { host, port } = parseP2pEndpoint(endpoint);
  if (!host || !port) {
    return Promise.resolve({
      ok: false,
      chainMatches: false,
      error: "missing host or port"
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let connected = false;
    const socket = net.createConnection({ host, port });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    }

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        chainMatches: false,
        error: connected ? "timed out waiting for P2P handshake" : "connection timed out"
      });
    }, BP_P2P_TIMEOUT_MS);

    socket.once("connect", () => {
      connected = true;
      const payload = makeHandshakePayload(expectedChainId);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
    });

    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const messageSize = buffer.readUInt32LE(0);
        if (messageSize <= 0 || messageSize > MAX_P2P_MESSAGE_SIZE) {
          finish({
            ok: false,
            chainMatches: false,
            error: "invalid P2P message size"
          });
          return;
        }
        if (buffer.length < 4 + messageSize) return;

        const payload = buffer.subarray(4, 4 + messageSize);
        buffer = buffer.subarray(4 + messageSize);

        try {
          const messageType = parseMessageType(payload);
          if (messageType === HANDSHAKE_MESSAGE_TYPE) {
            const chainMatches = handshakeMatchesChain(payload, expectedChainId);
            finish({
              ok: chainMatches,
              chainMatches,
              chainMismatch: !chainMatches,
              error: chainMatches ? "" : "P2P handshake returned a different chain ID"
            });
            return;
          }
          if (messageType === GO_AWAY_MESSAGE_TYPE) {
            finish({
              ok: false,
              chainMatches: false,
              error: "peer sent go_away"
            });
            return;
          }
        } catch (error) {
          finish({
            ok: false,
            chainMatches: false,
            error: error.message
          });
          return;
        }
      }
    });

    socket.once("error", (error) => {
      finish({
        ok: false,
        chainMatches: false,
        error: error.message
      });
    });

    socket.once("close", () => {
      finish({
        ok: false,
        chainMatches: false,
        error: "connection closed before P2P handshake"
      });
    });
  });
}

async function fetchBpP2pStatus(network, producer, metadataOverride = null) {
  const result = {
    status: "review",
    label: "No public P2P endpoint",
    endpoint: "",
    bpJsonUrl: "",
    bpJsonSource: "",
    bpJsonStatus: "unknown",
    bpJsonError: "",
    endpoints: [],
    attempts: []
  };
  const tempOverride = tempTestnetEndpointOverride(network, producer.name);
  const metadata = metadataOverride || await resolveBpMetadata(network, producer.url);
  result.bpJsonUrl = metadata.url;
  result.bpJsonSource = metadata.source;
  if (tempOverride) addP2pCandidate(result.endpoints, tempOverride.p2p);
  if (metadata.ok) {
    result.bpJsonStatus = "ok";
    for (const endpoint of p2pEndpointsFromBpJson(metadata.json)) addP2pCandidate(result.endpoints, endpoint);
    result.endpoints = result.endpoints.slice(0, 8);
  } else {
    result.bpJsonStatus = "error";
    result.bpJsonError = metadata.errors.join(" | ");
    if (!result.endpoints.length) {
      result.label = "BP metadata unavailable";
      return result;
    }
  }

  if (!result.endpoints.length) return result;

  for (const endpoint of result.endpoints) {
    const mismatchedNetwork = endpointNetworkMismatch(endpoint, network);
    if (mismatchedNetwork) {
      result.attempts.push({
        endpoint,
        ok: false,
        chainMatches: false,
        chainMismatch: true,
        error: `endpoint hostname looks like ${mismatchedNetwork}`
      });
      continue;
    }

    const attempt = await checkP2pHandshake(endpoint, network.chainId);
    result.attempts.push({ endpoint, ...attempt });
    if (attempt.ok) {
      result.status = "ok";
      result.label = "Handshake OK";
      result.endpoint = endpoint;
      return result;
    }
  }

  const wrongChain = result.attempts.some((attempt) => attempt.chainMismatch);
  const missingPort = result.attempts.length > 0
    && result.attempts.every((attempt) => attempt.error === "missing host or port");
  result.endpoint = result.endpoints[0] || "";
  result.label = wrongChain
    ? `P2P endpoint is not ${network.label}`
    : missingPort
      ? "P2P endpoint missing port"
      : "P2P handshake failed";
  return result;
}

async function fetchBpPublicStatus(network, producer) {
  const metadata = await resolveBpMetadata(network, producer.url);
  const [api, p2p] = await Promise.all([
    fetchBpApiStatus(network, producer, metadata),
    fetchBpP2pStatus(network, producer, metadata)
  ]);
  return { api, p2p };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function findProducerName(row) {
  const keys = ["finalizer_name", "producer_name", "producer", "owner", "name", "account", "account_name"];
  for (const key of keys) {
    if (row && typeof row[key] === "string" && row[key]) return row[key];
  }
  return "";
}

function isFinalizerActive(row) {
  if (!row) return false;
  if ("active" in row) return row.active === true || row.active === 1 || row.active === "1";
  if ("is_active" in row) return row.is_active === true || row.is_active === 1 || row.is_active === "1";
  if ("status" in row) return !/inactive|deleted|disabled/i.test(String(row.status));
  return true;
}

function finalizerKeyFromRow(row) {
  const keys = ["finalizer_key", "public_key", "key", "bls_key"];
  for (const key of keys) {
    if (row && typeof row[key] === "string" && row[key]) return row[key];
  }
  return "";
}

function buildFinalizerIndex(tableResults) {
  const index = new Map();
  for (const tableResult of tableResults) {
    if (!tableResult.ok) continue;
    for (const row of tableResult.rows) {
      const name = findProducerName(row);
      if (!name) continue;
      const previous = index.get(name) || { registered: false, active: false, keys: [], tables: [] };
      previous.registered = true;
      previous.active = previous.active || isFinalizerActive(row);
      const key = finalizerKeyFromRow(row);
      if (key && !previous.keys.includes(key)) previous.keys.push(key);
      if (!previous.tables.includes(tableResult.table)) previous.tables.push(tableResult.table);
      index.set(name, previous);
    }
  }
  return index;
}

function statusWeight(status) {
  return { blocker: 0, review: 1, manual: 2, ok: 3, unknown: 1 }[status] ?? 1;
}

function formatVotes(value) {
  const numeric = Number.parseFloat(String(value || "0"));
  if (!Number.isFinite(numeric)) return "0";
  if (numeric >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  return numeric.toFixed(0);
}

async function evaluateReadiness(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) {
    const error = new Error(`Unknown network: ${networkKey}`);
    error.status = 404;
    throw error;
  }

  const startedAt = Date.now();
  const [info, schedulePayload, producerRows, featuresPayload, abiPayload, finkeys, finalizers] = await Promise.all([
    rpcPost(network, "/v1/chain/get_info", {}),
    rpcPost(network, "/v1/chain/get_producer_schedule", {}),
    getAllTableRows(network, "producers", 200),
    rpcPost(network, "/v1/chain/get_activated_protocol_features", { limit: 100, reverse: true }),
    rpcPost(network, "/v1/chain/get_abi", { account_name: "eosio" }),
    safeTableRows(network, "finkeys"),
    safeTableRows(network, "finalizers")
  ]);

  const activeSchedule = schedulePayload.active?.producers || [];
  const activeNames = activeSchedule.map((entry) => entry.producer_name);
  const producerByName = new Map(producerRows.map((row) => [row.owner, row]));
  const activeProducerRows = producerRows
    .filter((row) => Number(row.is_active) === 1)
    .sort((a, b) => Number.parseFloat(b.total_votes || "0") - Number.parseFloat(a.total_votes || "0"));
  const rankByName = new Map(activeProducerRows.map((row, index) => [row.owner, index + 1]));

  const features = (featuresPayload.activated_protocol_features || []).map((feature) => ({
    codename: codenameFromFeature(feature),
    digest: feature.feature_digest,
    activationBlock: feature.activation_block_num,
    ordinal: feature.activation_ordinal
  }));
  const featureNames = new Set(features.map((feature) => feature.codename));
  const featureStatus = REQUIRED_FEATURES.map((name) => ({
    name,
    active: featureNames.has(name),
    activationBlock: features.find((feature) => feature.codename === name)?.activationBlock || null
  }));
  const missingPreSavannaFeatures = featureStatus
    .filter((feature) => feature.name !== "SAVANNA" && !feature.active)
    .map((feature) => feature.name);

  const abiActions = new Set((abiPayload.abi?.actions || []).map((action) => action.name));
  const abiTables = new Set((abiPayload.abi?.tables || []).map((table) => table.name));
  const missingFinalizerActions = FINALIZER_ACTIONS.filter((name) => !abiActions.has(name));
  const missingFinalizerTablesInAbi = FINALIZER_TABLES.filter((name) => !abiTables.has(name));
  const finalizerTables = [finkeys, finalizers];
  const finalizerTablesAvailable = finalizerTables.every((tableResult) => tableResult.ok);
  const finalizerIndex = buildFinalizerIndex(finalizerTables);
  const activeNameSet = new Set(activeNames);
  const tableRows = [
    ...activeSchedule.map((entry, index) => ({
      name: entry.producer_name,
      scheduleType: "active",
      schedulePosition: index + 1,
      scheduleEntry: entry
    })),
    ...activeProducerRows
      .filter((row) => !activeNameSet.has(row.owner))
      .map((row) => ({
        name: row.owner,
        scheduleType: "standby",
        schedulePosition: null,
        scheduleEntry: null
      }))
  ];

  const bpPublicStatuses = await mapLimit(tableRows, 6, async (entry) => {
    const producerRow = producerByName.get(entry.name) || {};
    return fetchBpPublicStatus(network, {
      name: entry.name,
      url: producerRow.url || ""
    });
  });
  const bpPublicByName = new Map(bpPublicStatuses.map((status, index) => [tableRows[index].name, status]));

  const producers = tableRows.map((entry) => {
    const row = producerByName.get(entry.name) || {};
    const finalizer = finalizerIndex.get(entry.name) || {
      registered: false,
      active: false,
      keys: [],
      tables: []
    };
    const publicStatus = bpPublicByName.get(entry.name) || {};
    const api = publicStatus.api || { status: "unknown", label: "Not checked" };
    const p2p = publicStatus.p2p || { status: "review", label: "Not checked", endpoint: "" };
    const blockers = [];
    const warnings = [];
    const isScheduled = entry.scheduleType === "active";
    if (Number(row.is_active) !== 1) blockers.push("Producer row is not active");
    if (isScheduled && missingFinalizerActions.length > 0) blockers.push("Savanna finalizer actions missing from eosio ABI");
    if (isScheduled && !finalizerTablesAvailable) blockers.push("Finalizer tables are not readable");
    if (isScheduled && finalizerTablesAvailable && !finalizer.registered) blockers.push("No finalizer key row found");
    if (isScheduled && finalizerTablesAvailable && finalizer.registered && !finalizer.active) blockers.push("Finalizer key row is not active");
    if (api.status === "blocker") blockers.push("Published API is not Spring compatible");
    if (api.status === "review" || api.status === "unknown") warnings.push(api.label || "Published API needs review");
    if (p2p.status === "blocker") blockers.push(p2p.label || "Public P2P handshake failed");
    if (p2p.status === "review" || p2p.status === "unknown") warnings.push(p2p.label || "Published P2P needs review");
    if (!isScheduled) warnings.push("Standby BP - not part of scheduled finalizer gate");
    const status = blockers.length > 0 ? "blocker" : warnings.length > 0 ? "review" : "ok";
    return {
      name: entry.name,
      scheduleType: entry.scheduleType,
      schedulePosition: entry.schedulePosition,
      rank: rankByName.get(entry.name) || null,
      blockSigningKey: entry.scheduleEntry ? producerKeyFromScheduleEntry(entry.scheduleEntry) : "",
      votes: row.total_votes || "",
      votesCompact: formatVotes(row.total_votes),
      url: row.url || "",
      isActive: Number(row.is_active) === 1,
      lifetimeMissedBlocks: Number(row.lifetime_missed_blocks || 0),
      missedBlocksPerRotation: Number(row.missed_blocks_per_rotation || 0),
      finalizer: {
        registered: finalizer.registered,
        active: finalizer.active,
        keys: finalizer.keys,
        tables: finalizer.tables
      },
      api,
      p2p,
      status,
      blockers,
      warnings
    };
  });
  const scheduledProducers = producers.filter((producer) => producer.scheduleType === "active");

  const counts = {
    totalRows: producers.length,
    scheduled: scheduledProducers.length,
    standby: producers.filter((producer) => producer.scheduleType === "standby").length,
    producerRowsActive: producers.filter((producer) => producer.isActive).length,
    ready: scheduledProducers.filter((producer) => producer.status === "ok").length,
    review: scheduledProducers.filter((producer) => producer.status === "review").length,
    blocked: scheduledProducers.filter((producer) => producer.status === "blocker").length,
    readyRows: producers.filter((producer) => producer.status === "ok").length,
    reviewRows: producers.filter((producer) => producer.status === "review").length,
    blockedRows: producers.filter((producer) => producer.status === "blocker").length,
    finalizersRegistered: scheduledProducers.filter((producer) => producer.finalizer.registered).length,
    finalizersActive: scheduledProducers.filter((producer) => producer.finalizer.active).length,
    activeSpringCompatible: scheduledProducers.filter((producer) => producer.api.status === "ok").length,
    springCompatible: scheduledProducers.filter((producer) => producer.api.status === "ok").length,
    bpApiSpring: scheduledProducers.filter((producer) => producer.api.status === "ok").length,
    bpApiReview: scheduledProducers.filter((producer) => producer.api.status === "review").length,
    bpApiUnknown: scheduledProducers.filter((producer) => producer.api.status === "unknown").length,
    bpApiBlocked: scheduledProducers.filter((producer) => producer.api.status === "blocker").length,
    publicP2pOk: scheduledProducers.filter((producer) => producer.p2p.status === "ok").length,
    publicP2pReview: scheduledProducers.filter((producer) => producer.p2p.status === "review").length,
    publicP2pUnknown: scheduledProducers.filter((producer) => producer.p2p.status === "unknown").length,
    publicP2pBlocked: scheduledProducers.filter((producer) => producer.p2p.status === "blocker").length
  };

  const rpcVersion = classifyVersion(info);
  const savannaActive = featureNames.has("SAVANNA");
  const gates = [
    {
      key: "public-rpc",
      label: "Public RPC Spring",
      status: rpcVersion.status,
      value: rpcVersion.version || "Unknown",
      detail: `${network.rpc} reports ${rpcVersion.label}`
    },
    {
      key: "schedule",
      label: "Active schedule",
      status: activeNames.length > 0 ? "ok" : "blocker",
      value: `${activeNames.length} producers`,
      detail: `Schedule version ${schedulePayload.active?.version ?? "unknown"}`
    },
    {
      key: "features",
      label: "Pre-Savanna features",
      status: missingPreSavannaFeatures.length === 0 ? "ok" : "blocker",
      value: missingPreSavannaFeatures.length === 0 ? "Complete" : `${missingPreSavannaFeatures.length} missing`,
      detail: missingPreSavannaFeatures.length ? missingPreSavannaFeatures.join(", ") : "All listed dependencies except SAVANNA are active"
    },
    {
      key: "bls",
      label: "BLS_PRIMITIVES2",
      status: featureNames.has("BLS_PRIMITIVES2") ? "ok" : "blocker",
      value: featureNames.has("BLS_PRIMITIVES2") ? "Active" : "Missing",
      detail: "Required before finalizer key registration"
    },
    {
      key: "contract",
      label: "Finalizer contract ABI",
      status: missingFinalizerActions.length === 0 && missingFinalizerTablesInAbi.length === 0 ? "ok" : "blocker",
      value: missingFinalizerActions.length === 0 ? "Actions present" : `${missingFinalizerActions.length} actions missing`,
      detail: [...missingFinalizerActions, ...missingFinalizerTablesInAbi.map((name) => `${name} table`)].join(", ") || "Finalizer actions and tables are present"
    },
    {
      key: "tables",
      label: "Finalizer key tables",
      status: finalizerTablesAvailable ? "ok" : "blocker",
      value: finalizerTablesAvailable ? "Readable" : "Unavailable",
      detail: finalizerTables.map((table) => table.ok ? `${table.table}: ${table.rows.length} rows` : `${table.table}: ${table.error}`).join(" | ")
    },
    {
      key: "finalizers",
      label: "Scheduled BP finalizers",
      status: finalizerTablesAvailable && counts.finalizersActive === counts.scheduled ? "ok" : "blocker",
      value: `${counts.finalizersActive}/${counts.scheduled} active`,
      detail: finalizerTablesAvailable ? "Every scheduled BP needs an active finalizer key" : "Waiting on finalizer table availability"
    },
    {
      key: "bp-apis",
      label: "Spring-compatible active BPs",
      status: counts.bpApiBlocked > 0 ? "blocker" : counts.bpApiSpring === counts.scheduled ? "ok" : "review",
      value: `${counts.bpApiSpring}/${counts.scheduled} Spring`,
      detail: `${counts.bpApiReview} review, ${counts.bpApiUnknown} unknown, ${counts.bpApiBlocked} blocked`
    },
    {
      key: "public-p2p",
      label: "Public live P2P",
      status: counts.publicP2pOk === counts.scheduled ? "ok" : "review",
      value: `${counts.publicP2pOk}/${counts.scheduled} reachable`,
      detail: `${counts.publicP2pReview + counts.publicP2pBlocked} review, ${counts.publicP2pUnknown} unknown`
    },
    {
      key: "savanna",
      label: "SAVANNA feature",
      status: savannaActive ? "ok" : "manual",
      value: savannaActive ? "Active" : "Pending",
      detail: savannaActive ? "Savanna is already active" : "Expected to remain pending until the activation action"
    },
    {
      key: "operator-private",
      label: "Operator host checks",
      status: "manual",
      value: "Manual",
      detail: "Confirm exact vote-threads = 4, unique BLS keys, relay vote propagation, and protected safety.dat"
    }
  ];

  const overallStatus = gates.some((gate) => gate.status === "blocker") || counts.blocked > 0
    ? "blocker"
    : gates.some((gate) => gate.status === "review" || gate.status === "manual") || counts.review > 0
      ? "review"
      : "ok";

  return {
    network: {
      key: network.key,
      label: network.label,
      rpc: network.rpc,
      chainId: network.chainId
    },
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    overallStatus,
    info: {
      headBlockNum: info.head_block_num,
      lastIrreversibleBlockNum: info.last_irreversible_block_num,
      libLagBlocks: Number(info.head_block_num || 0) - Number(info.last_irreversible_block_num || 0),
      headBlockTime: info.head_block_time,
      headBlockProducer: info.head_block_producer,
      serverVersion: rpcVersion.version,
      chainId: info.chain_id
    },
    counts,
    gates: gates.sort((a, b) => statusWeight(a.status) - statusWeight(b.status)),
    features: featureStatus,
    finalizerTables: finalizerTables.map((table) => ({
      table: table.table,
      ok: table.ok,
      rows: table.rows.length,
      error: table.error || ""
    })),
    producers,
    sourceNotes: [
      "Temporary testnet tempbpfill API/P2P endpoints are explicitly configured while they are used as schedule-fill validators.",
      "Published BP API checks come from BP metadata and public API endpoints, not private producer hosts.",
      "Public live P2P checks require a BP metadata p2p_endpoint that completes a peer handshake on the expected chain; failures are review items because private peering can still be healthy.",
      "Exact vote-threads configuration and private producer-host settings cannot be proven from public RPC."
    ]
  };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(normalized);
    const ext = path.extname(normalized);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") sendText(res, 404, "Not found");
    else sendText(res, 500, error.message);
  }
}

async function handleRequest(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (parsed.pathname === "/api/networks") {
    jsonResponse(res, 200, Object.values(NETWORKS).map(({ key, label, rpc, chainId }) => ({ key, label, rpc, chainId })));
    return;
  }
  const readinessMatch = parsed.pathname.match(/^\/api\/readiness\/(testnet|mainnet)$/);
  if (readinessMatch) {
    try {
      const payload = await evaluateReadiness(readinessMatch[1]);
      jsonResponse(res, 200, payload);
    } catch (error) {
      jsonResponse(res, error.status || 500, {
        error: error.message,
        status: error.status || 500
      });
    }
    return;
  }
  await serveStatic(req, res, decodeURIComponent(parsed.pathname));
}

module.exports = {
  NETWORKS,
  evaluateReadiness
};

if (require.main === module) {
  if (process.argv.includes("--check")) {
    Promise.all([evaluateReadiness("testnet"), evaluateReadiness("mainnet")])
      .then((results) => {
        for (const result of results) {
          console.log(`${result.network.label}: ${result.overallStatus}, ${result.counts.ready}/${result.counts.scheduled} BP rows ready, ${result.durationMs}ms`);
        }
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  } else {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        jsonResponse(res, 500, { error: error.message });
      });
    });
    server.listen(PORT, () => {
      console.log(`Telos instant finality readiness checker running at http://localhost:${PORT}`);
    });
  }
}
