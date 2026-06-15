#!/usr/bin/env python3
"""
Telos BP Validation Service
Validates all is_active=1 BPs (active schedule + standbys).
Tags each BP as 'active' or 'standby'. Outputs latest.json and history.json.
Pushes a benchmark transaction each run to measure real CPU execution time per BP.
"""

import asyncio
import aiohttp
import json
import os
import secrets
import shutil
import ssl
import struct
import sys
import time
from datetime import datetime, timezone
from typing import Optional, Tuple
from urllib.parse import urlparse

# ── Chain constants ──────────────────────────────────────────────────────────
TELOS_API         = os.environ.get("TELOS_API", "https://mainnet.telos.net")
TELOS_TESTNET_API = os.environ.get("TELOS_TESTNET_API", "https://testnet.telos.caleos.io")
MAINNET_CHAIN_ID = "4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11"
TESTNET_CHAIN_ID = "1eaa0824707c8c16bd25145493bf062aecddfeb56c736f6ba6397f3195f33c9f"

FETCH_TIMEOUT_SECONDS = 20
FETCH_TIMEOUT = aiohttp.ClientTimeout(total=FETCH_TIMEOUT_SECONDS)
CHECK_TIMEOUT = aiohttp.ClientTimeout(total=8)
P2P_TIMEOUT_SEC = 5
STRICT_SSL    = ssl.create_default_context()
NO_SSL        = False
NET_VERSION_BASE = 0x04B5
NET_VERSION_MAX = 12
HANDSHAKE_MESSAGE_TYPE = 0
GO_AWAY_MESSAGE_TYPE = 2
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TelosValidatorChecker/1.0; +https://validators.telos.net)",
    "Accept": "application/json,text/plain,*/*",
}
CURL_PATH = shutil.which("curl")

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(SCRIPT_DIR, "..", "validation", "history.json")
MAX_HISTORY  = 56   # ~14 days at 6-hour intervals

TEMP_TESTNET_ENDPOINTS = {
    "tempbpfill11": {"api": "http://38.49.217.195:8889", "p2p": "38.49.217.195:9878"},
    "tempbpfill22": {"api": "http://38.49.217.195:8890", "p2p": "38.49.217.195:9879"},
    "tempbpfill33": {"api": "http://38.49.217.195:8891", "p2p": "38.49.217.195:9880"},
    "tempbpfill44": {"api": "http://38.49.217.195:8892", "p2p": "38.49.217.195:9881"},
    "tempbpfill55": {"api": "http://38.49.217.195:8893", "p2p": "38.49.217.195:9882"},
    "tempbpfillaa": {"api": "http://38.49.217.195:8894", "p2p": "38.49.217.195:9883"},
    "tempbpfillbb": {"api": "http://38.49.217.195:8895", "p2p": "38.49.217.195:9884"},
    "tempbpfillcc": {"api": "http://38.49.217.195:8896", "p2p": "38.49.217.195:9885"},
    "tempbpfilldd": {"api": "http://38.49.217.195:8897", "p2p": "38.49.217.195:9886"},
}

# ────────────────────────────────────────────────────────────────────────────

async def get_active_schedule(
    session: aiohttp.ClientSession,
    api_url: str = TELOS_API,
) -> dict:
    """Return active schedule authorities keyed by producer name."""
    try:
        async with session.get(
            f"{api_url}/v1/chain/get_producer_schedule",
            timeout=FETCH_TIMEOUT, ssl=NO_SSL,
        ) as resp:
            data = await resp.json(content_type=None)
        producers = (data.get("active") or {}).get("producers", [])
        return {
            p["producer_name"]: extract_authority_keys(
                p.get("authority"),
                fallback_key=p.get("producer_key") or p.get("block_signing_key"),
            )
            for p in producers
            if p.get("producer_name")
        }
    except Exception as e:
        print(f"[ERROR] get_producer_schedule: {e}", file=sys.stderr)
        return {}


async def get_all_producers(
    session: aiohttp.ClientSession,
    api_url: str = TELOS_API,
) -> list:
    """Fetch all registered BPs, return only is_active=1 ones."""
    producers, lower_bound = [], ""
    while True:
        try:
            async with session.post(
                f"{api_url}/v1/chain/get_producers",
                json={"json": True, "limit": 100, "lower_bound": lower_bound},
                timeout=FETCH_TIMEOUT, ssl=NO_SSL,
            ) as resp:
                data = await resp.json(content_type=None)
        except Exception as e:
            print(f"[ERROR] get_producers: {e}", file=sys.stderr)
            break
        rows = data.get("rows", [])
        if not rows:
            break
        producers.extend(rows)
        if data.get("more"):
            lower_bound = rows[-1]["owner"]
        else:
            break
    return [p for p in producers if p.get("is_active") == 1]


async def fetch_json(session: aiohttp.ClientSession, url: str) -> Optional[dict]:
    try:
        async with session.get(url, timeout=FETCH_TIMEOUT, ssl=NO_SSL) as resp:
            if resp.status == 200:
                return await resp.json(content_type=None)
    except Exception:
        pass
    return await fetch_json_with_curl(url)


async def fetch_json_with_curl(url: str) -> Optional[dict]:
    """Fallback for public metadata hosts that reject Python's TLS stack."""
    if not CURL_PATH or not url.startswith(("http://", "https://")):
        return None

    args = [
        CURL_PATH,
        "--silent",
        "--show-error",
        "--location",
        "--fail",
        "--compressed",
        "--max-time",
        str(FETCH_TIMEOUT_SECONDS),
        "--header",
        f"User-Agent: {REQUEST_HEADERS['User-Agent']}",
        "--header",
        f"Accept: {REQUEST_HEADERS['Accept']}",
        url,
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(
            proc.communicate(),
            timeout=FETCH_TIMEOUT_SECONDS + 2,
        )
        if proc.returncode != 0:
            return None

        data = json.loads(stdout.decode("utf-8-sig"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    return None


async def check_ssl(session: aiohttp.ClientSession, endpoint: str) -> bool:
    try:
        if not endpoint.startswith("https://"):
            return False
        url = endpoint.rstrip("/") + "/v1/chain/get_info"
        async with session.get(url, timeout=CHECK_TIMEOUT, ssl=STRICT_SSL) as resp:
            return resp.status < 500
    except Exception:
        return False


async def check_api(
    session: aiohttp.ClientSession,
    endpoint: str,
    expected_chain_id: Optional[str] = None,
) -> Tuple[bool, int, Optional[str]]:
    url = endpoint.rstrip("/") + "/v1/chain/get_info"
    t0  = time.monotonic()
    try:
        async with session.get(url, timeout=CHECK_TIMEOUT, ssl=NO_SSL) as resp:
            if resp.status == 200:
                data = await resp.json(content_type=None)
                chain_id = data.get("chain_id")
                version = (
                    data.get("server_version_string")
                    or data.get("server_full_version_string")
                    or data.get("server_version")
                )
                if chain_id and (not expected_chain_id or chain_id == expected_chain_id):
                    return True, int((time.monotonic() - t0) * 1000), version
    except Exception:
        pass
    return False, -1, None


async def check_api_endpoint(
    session: aiohttp.ClientSession,
    endpoint: str,
    expected_chain_id: str,
) -> dict:
    ssl_ok, (api_ok, api_ms, api_version) = await asyncio.gather(
        check_ssl(session, endpoint),
        check_api(session, endpoint, expected_chain_id),
    )
    return {
        "endpoint": endpoint,
        "sslVerified": ssl_ok,
        "apiVerified": api_ok,
        "apiResponseMs": api_ms,
        "nodeosVersion": api_version,
    }


async def check_api_endpoints(
    session: aiohttp.ClientSession,
    endpoints: list,
    expected_chain_id: str,
) -> list:
    return list(await asyncio.gather(
        *[check_api_endpoint(session, endpoint, expected_chain_id) for endpoint in endpoints]
    ))


def normalize_p2p_endpoint(endpoint: str) -> str:
    return (endpoint or "").strip().rstrip("/")


def parse_p2p_endpoint(endpoint: str) -> Tuple[Optional[str], Optional[int]]:
    parsed = urlparse(endpoint if "://" in endpoint else f"tcp://{endpoint}")
    return parsed.hostname, parsed.port


def pack_varuint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varuint must be non-negative")

    output = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        output.append(byte)
        if not value:
            return bytes(output)


def unpack_varuint(data: bytes, offset: int = 0) -> Tuple[int, int]:
    value = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise ValueError("Unexpected end of payload while reading varuint")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, offset
        shift += 7
        if shift > 35:
            raise ValueError("varuint too large")


def pack_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return pack_varuint(len(encoded)) + encoded


def empty_public_key_bytes() -> bytes:
    return pack_varuint(0) + (b"\x00" * 33)


def empty_signature_bytes() -> bytes:
    return pack_varuint(0) + (b"\x00" * 65)


def make_handshake_payload(expected_chain_id: str) -> bytes:
    node_id = secrets.token_bytes(32)
    now_ns = int(time.time_ns())
    node_id_prefix = node_id.hex()[:7]
    payload = bytearray()
    payload += pack_varuint(HANDSHAKE_MESSAGE_TYPE)
    payload += struct.pack("<H", NET_VERSION_BASE + NET_VERSION_MAX)
    payload += bytes.fromhex(expected_chain_id)
    payload += node_id
    payload += empty_public_key_bytes()
    payload += struct.pack("<q", now_ns)
    payload += b"\x00" * 32
    payload += empty_signature_bytes()
    payload += pack_string(f"127.0.0.1:0 - {node_id_prefix}")
    payload += struct.pack("<I", 0)
    payload += b"\x00" * 32
    payload += struct.pack("<I", 0)
    payload += b"\x00" * 32
    payload += pack_string("osx")
    payload += pack_string("Telos Validator Checker")
    payload += struct.pack("<h", 1)
    return bytes(payload)


def parse_message_type(payload: bytes) -> int:
    msg_type, _ = unpack_varuint(payload, 0)
    return msg_type


def handshake_matches_chain(payload: bytes, expected_chain_id: str) -> bool:
    _, offset = unpack_varuint(payload, 0)
    offset += 2  # network_version
    if offset + 32 > len(payload):
        return False
    return payload[offset:offset + 32] == bytes.fromhex(expected_chain_id)


async def check_p2p(endpoint: str, expected_chain_id: str) -> bool:
    host, port = parse_p2p_endpoint(endpoint)
    if not host or not port:
        return False

    reader = None
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=P2P_TIMEOUT_SEC,
        )

        payload = make_handshake_payload(expected_chain_id)
        writer.write(struct.pack("<I", len(payload)) + payload)
        await asyncio.wait_for(writer.drain(), timeout=P2P_TIMEOUT_SEC)

        deadline = time.monotonic() + P2P_TIMEOUT_SEC
        while time.monotonic() < deadline:
            remaining = max(deadline - time.monotonic(), 0.1)
            header = await asyncio.wait_for(reader.readexactly(4), timeout=remaining)
            message_size = struct.unpack("<I", header)[0]
            if message_size <= 0:
                return False
            payload = await asyncio.wait_for(reader.readexactly(message_size), timeout=remaining)
            msg_type = parse_message_type(payload)
            if msg_type == HANDSHAKE_MESSAGE_TYPE:
                return handshake_matches_chain(payload, expected_chain_id)
            if msg_type == GO_AWAY_MESSAGE_TYPE:
                return False

        return False
    except Exception:
        return False
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


async def check_p2p_endpoint(endpoint: str, expected_chain_id: str) -> dict:
    return {
        "endpoint": endpoint,
        "verified": await check_p2p(endpoint, expected_chain_id),
    }


async def check_p2p_endpoints(endpoints: list, expected_chain_id: str) -> list:
    return list(await asyncio.gather(
        *[check_p2p_endpoint(endpoint, expected_chain_id) for endpoint in endpoints]
    ))


def best_endpoint(nodes: list) -> Optional[str]:
    for preferred in (["query"], ["producer"], ["seed"]):
        for node in nodes:
            nt    = node.get("node_type", "")
            types = nt if isinstance(nt, list) else [nt]
            if any(t in types for t in preferred):
                ep = node.get("ssl_endpoint", "").strip().rstrip("/")
                if ep:
                    return ep

    for node in nodes:
        ep = node.get("ssl_endpoint", "").strip().rstrip("/")
        if ep:
            return ep

    return None


def all_ssl_endpoints(nodes: list) -> list:
    endpoints = []
    for node in nodes:
        ep = node.get("ssl_endpoint", "").strip().rstrip("/")
        if ep and ep not in endpoints:
            endpoints.append(ep)
    return endpoints


def ordered_ssl_endpoints(nodes: list) -> list:
    endpoints = []

    def add(endpoint: str) -> None:
        ep = (endpoint or "").strip().rstrip("/")
        if ep and ep not in endpoints:
            endpoints.append(ep)

    for preferred in (["query"], ["producer"], ["seed"]):
        for node in nodes:
            nt = node.get("node_type", "")
            types = nt if isinstance(nt, list) else [nt]
            if any(t in types for t in preferred):
                add(node.get("ssl_endpoint", ""))

    for node in nodes:
        add(node.get("ssl_endpoint", ""))

    return endpoints


def best_p2p_endpoint(nodes: list) -> Optional[str]:
    for preferred in (["seed"], ["producer"], ["query"]):
        for node in nodes:
            nt    = node.get("node_type", "")
            types = nt if isinstance(nt, list) else [nt]
            if any(t in types for t in preferred):
                ep = normalize_p2p_endpoint(node.get("p2p_endpoint", ""))
                if ep:
                    return ep

    for node in nodes:
        ep = normalize_p2p_endpoint(node.get("p2p_endpoint", ""))
        if ep:
            return ep

    return None


def all_p2p_endpoints(nodes: list) -> list:
    endpoints = []
    for node in nodes:
        ep = normalize_p2p_endpoint(node.get("p2p_endpoint", ""))
        if ep and ep not in endpoints:
            endpoints.append(ep)
    return endpoints


def ordered_p2p_endpoints(nodes: list) -> list:
    endpoints = []

    def add(endpoint: str) -> None:
        ep = normalize_p2p_endpoint(endpoint)
        if ep and ep not in endpoints:
            endpoints.append(ep)

    for preferred in (["seed"], ["producer"], ["query"]):
        for node in nodes:
            nt = node.get("node_type", "")
            types = nt if isinstance(nt, list) else [nt]
            if any(t in types for t in preferred):
                add(node.get("p2p_endpoint", ""))

    for node in nodes:
        add(node.get("p2p_endpoint", ""))

    return endpoints


def select_api_endpoint_check(nodes: list, checks: list) -> Optional[dict]:
    by_endpoint = {check.get("endpoint"): check for check in checks}
    ordered = ordered_ssl_endpoints(nodes)
    for endpoint in ordered:
        check = by_endpoint.get(endpoint)
        if check and check.get("sslVerified") and check.get("apiVerified"):
            return check

    for endpoint in ordered:
        check = by_endpoint.get(endpoint)
        if check:
            return check

    return checks[0] if checks else None


def select_p2p_endpoint_check(nodes: list, checks: list) -> Optional[dict]:
    by_endpoint = {check.get("endpoint"): check for check in checks}
    ordered = ordered_p2p_endpoints(nodes)
    for endpoint in ordered:
        check = by_endpoint.get(endpoint)
        if check and check.get("verified"):
            return check

    for endpoint in ordered:
        check = by_endpoint.get(endpoint)
        if check:
            return check

    return checks[0] if checks else None


def temp_testnet_nodes(owner: str) -> list:
    override = TEMP_TESTNET_ENDPOINTS.get(owner)
    if not override:
        return []

    return [{
        "node_type": ["query", "producer", "seed"],
        "ssl_endpoint": override["api"],
        "api_endpoint": override["api"],
        "p2p_endpoint": override["p2p"],
    }]


def is_temp_testnet_api_endpoint(endpoint: str) -> bool:
    normalized = (endpoint or "").strip().rstrip("/")
    return any(normalized == override["api"] for override in TEMP_TESTNET_ENDPOINTS.values())


async def apply_testnet_nodes(
    session: aiohttp.ClientSession,
    result: dict,
    nodes: list,
    errors: list,
) -> None:
    result["apiEndpointsTestNet"] = all_ssl_endpoints(nodes)
    result["p2pEndpointsTestNet"] = all_p2p_endpoints(nodes)
    result["apiEndpointChecksTestNet"], result["p2pEndpointChecksTestNet"] = await asyncio.gather(
        check_api_endpoints(session, result["apiEndpointsTestNet"], TESTNET_CHAIN_ID),
        check_p2p_endpoints(result["p2pEndpointsTestNet"], TESTNET_CHAIN_ID),
    )

    testnet_p2p_check = select_p2p_endpoint_check(nodes, result["p2pEndpointChecksTestNet"])
    if testnet_p2p_check:
        result["p2pEndpointTestNet"] = testnet_p2p_check["endpoint"]
        result["p2pVerifiedTestNet"] = bool(testnet_p2p_check["verified"])
        if not result["p2pVerifiedTestNet"]:
            errors.append(f"Testnet P2P handshake failed: {result['p2pEndpointTestNet']}")
    else:
        errors.append("No testnet p2p_endpoint found in bp.json nodes")

    testnet_api_check = select_api_endpoint_check(nodes, result["apiEndpointChecksTestNet"])
    if testnet_api_check:
        result["apiEndpointTestNet"] = testnet_api_check["endpoint"]
        result["sslVerifiedTestNet"]    = bool(testnet_api_check["sslVerified"])
        result["apiVerifiedTestNet"]    = bool(testnet_api_check["apiVerified"])
        result["apiResponseMsTestNet"]  = testnet_api_check["apiResponseMs"]
        result["nodeosVersionTestNet"]  = testnet_api_check["nodeosVersion"]
        if not result["sslVerifiedTestNet"] and not is_temp_testnet_api_endpoint(result["apiEndpointTestNet"]):
            errors.append(f"Testnet SSL failed: {result['apiEndpointTestNet']}")
        if not result["apiVerifiedTestNet"]:
            errors.append(f"Testnet API failed: {result['apiEndpointTestNet']}")
    else:
        errors.append("No testnet ssl_endpoint found in bp.json nodes")


def metadata_url(base_url: str, path: str) -> str:
    """Resolve a chains.json metadata path relative to the registered BP URL."""
    clean_path = (path or "").strip()
    if not clean_path:
        return base_url.rstrip("/")
    parsed = urlparse(clean_path)
    if parsed.scheme in {"http", "https"}:
        return clean_path
    return f"{base_url.rstrip('/')}/{clean_path.lstrip('/')}"


def metadata_fallback_urls(base_url: str, file_names: list) -> list:
    urls = []
    for file_name in file_names:
        url = f"{base_url.rstrip('/')}/{file_name}"
        if url not in urls:
            urls.append(url)
    return urls


def normalize_producer_url(url: str) -> str:
    base_url = (url or "").strip().rstrip("/")
    if base_url and not base_url.startswith(("http://", "https://")):
        base_url = "https://" + base_url
    return base_url


def extract_authority_keys(authority: object, fallback_key: Optional[str] = None) -> list:
    """Extract active block-signing/finalizer public keys from authority variants."""
    if isinstance(authority, list) and len(authority) == 2 and isinstance(authority[1], dict):
        authority = authority[1]

    if isinstance(authority, dict):
        keys = authority.get("keys", [])
        extracted = [
            item.get("key")
            for item in keys
            if isinstance(item, dict) and item.get("key")
        ]
        if extracted:
            return extracted

    if fallback_key:
        return [fallback_key]

    return []


async def resolve_bp_json(
    session: aiohttp.ClientSession, base_url: str
) -> Tuple[Optional[dict], list, Optional[str]]:
    errors = []
    fallback_errors = []
    testnet_path = None

    chains_data = await fetch_json(session, f"{base_url}/chains.json")
    if chains_data:
        chains       = chains_data.get("chains", {})
        bp_path      = chains.get(MAINNET_CHAIN_ID)
        testnet_path = chains.get(TESTNET_CHAIN_ID)
        if bp_path:
            bp_url = metadata_url(base_url, bp_path)
            bp_json = await fetch_json(session, bp_url)
            if bp_json:
                return bp_json, errors, testnet_path
            fallback_errors.append(
                f"bp.json at {bp_url} unreachable — trying /bp.json, /mainnet.json, and /telos.json"
            )
        else:
            fallback_errors.append(
                "Mainnet chain ID missing from chains.json — trying /bp.json, /mainnet.json, and /telos.json"
            )
    else:
        fallback_errors.append("chains.json missing — trying /bp.json, /mainnet.json, and /telos.json")

    for fallback_url in metadata_fallback_urls(base_url, ["bp.json", "mainnet.json", "telos.json"]):
        bp_json = await fetch_json(session, fallback_url)
        if bp_json:
            return bp_json, errors, testnet_path

    errors.extend(fallback_errors)
    errors.append("/bp.json, /mainnet.json, and /telos.json also unreachable")
    return None, errors, None


async def resolve_testnet_bp_json(
    session: aiohttp.ClientSession, base_url: str
) -> Tuple[Optional[dict], list]:
    errors = []
    fallback_errors = []

    chains_data = await fetch_json(session, f"{base_url}/chains.json")
    if chains_data:
        chains = chains_data.get("chains", {})
        bp_path = chains.get(TESTNET_CHAIN_ID)
        if bp_path:
            bp_url = metadata_url(base_url, bp_path)
            bp_json = await fetch_json(session, bp_url)
            if bp_json:
                return bp_json, errors
            fallback_errors.append(f"Testnet bp.json at {bp_url} unreachable — trying /testnet.json and /bp.json")
        else:
            fallback_errors.append("Testnet chain ID missing from chains.json — trying /testnet.json and /bp.json")
    else:
        fallback_errors.append("Testnet chains.json missing — trying /testnet.json and /bp.json")

    for fallback_url in metadata_fallback_urls(base_url, ["testnet.json", "bp.json", "telos.json"]):
        bp_json = await fetch_json(session, fallback_url)
        if bp_json:
            return bp_json, errors

    errors.extend(fallback_errors)
    errors.append("Testnet /testnet.json, /bp.json, and /telos.json also unreachable")
    return None, errors


async def validate_producer(
    session: aiohttp.ClientSession,
    producer: dict,
    active_schedule: dict,
    testnet_producers: Optional[dict] = None,
    testnet_active_schedule: Optional[dict] = None,
) -> dict:
    owner    = producer["owner"]
    base_url = normalize_producer_url(producer.get("url", ""))
    testnet_producer = (testnet_producers or {}).get(owner)
    testnet_base_url = normalize_producer_url(
        testnet_producer.get("url", "") if testnet_producer else ""
    )
    testnet_override_nodes = temp_testnet_nodes(owner)
    mainnet_finalizer_keys = active_schedule.get(owner, [])
    testnet_finalizer_keys = (testnet_active_schedule or {}).get(owner, [])

    result = {
        "owner":                owner,
        "scheduleType":         "active" if owner in active_schedule else "standby",
        "scheduleTypeTestNet":  (
            "active"
            if owner in (testnet_active_schedule or {})
            else "standby" if testnet_producer else None
        ),
        "total_votes":          producer.get("total_votes", "0"),
        "url":                  base_url,
        "is_active":            producer.get("is_active", 0),
        "sslVerified":          False,
        "apiVerified":          False,
        "apiResponseMs":        -1,
        "apiEndpoint":          None,
        "apiEndpoints":         [],
        "apiEndpointChecks":    [],
        "p2pVerified":          False,
        "hasActiveFinalizerKey": bool(mainnet_finalizer_keys),
        "activeFinalizerKeys":  mainnet_finalizer_keys,
        "nodeosVersion":        None,
        "sslVerifiedTestNet":   False,
        "apiVerifiedTestNet":   False,
        "apiResponseMsTestNet": -1,
        "apiEndpointTestNet":   None,
        "apiEndpointsTestNet":  [],
        "apiEndpointChecksTestNet": [],
        "p2pVerifiedTestNet":   False,
        "hasActiveFinalizerKeyTestNet": bool(testnet_finalizer_keys),
        "activeFinalizerKeysTestNet": testnet_finalizer_keys,
        "nodeosVersionTestNet": None,
        "testnetUrl":           testnet_base_url or (testnet_override_nodes[0]["ssl_endpoint"] if testnet_override_nodes else None),
        "missedBlocksPerRotation": producer.get("missed_blocks_per_rotation", 0),
        "lifetimeMissedBlocks":    producer.get("lifetime_missed_blocks", 0),
        "lifetimeProducedBlocks":  producer.get("lifetime_produced_blocks", 0),
        "timesKicked":             producer.get("times_kicked", 0),
        "p2pEndpoint":          None,
        "p2pEndpoints":         [],
        "p2pEndpointChecks":    [],
        "p2pEndpointTestNet":   None,
        "p2pEndpointsTestNet":  [],
        "p2pEndpointChecksTestNet": [],
        "org":                  {},
        "validationErrors":     [],
        "checkedAt":            datetime.now(timezone.utc).isoformat(),
    }

    if testnet_override_nodes:
        result["org"] = {
            "candidate_name": owner,
            "website": "https://validators.telos.net",
            "code_of_conduct": "https://validators.telos.net",
        }

    if not base_url and not testnet_override_nodes:
        result["validationErrors"] = ["No URL registered on chain"]
        return result

    if not base_url:
        bp_json, errors, testnet_path = None, result["validationErrors"], None
    else:
        bp_json, errors, testnet_path = await resolve_bp_json(session, base_url)

    if base_url and not bp_json and not testnet_override_nodes:
        result["validationErrors"] = errors
        return result

    if bp_json:
        result["org"] = bp_json.get("org", {})
        nodes         = bp_json.get("nodes", [])
        result["apiEndpoints"] = all_ssl_endpoints(nodes)
        result["p2pEndpoints"] = all_p2p_endpoints(nodes)
        result["apiEndpointChecks"], result["p2pEndpointChecks"] = await asyncio.gather(
            check_api_endpoints(session, result["apiEndpoints"], MAINNET_CHAIN_ID),
            check_p2p_endpoints(result["p2pEndpoints"], MAINNET_CHAIN_ID),
        )

        p2p_check = select_p2p_endpoint_check(nodes, result["p2pEndpointChecks"])
        if p2p_check:
            result["p2pEndpoint"] = p2p_check["endpoint"]
            result["p2pVerified"] = bool(p2p_check["verified"])
            if not result["p2pVerified"]:
                errors.append(f"P2P handshake failed: {result['p2pEndpoint']}")
        else:
            errors.append("No p2p_endpoint found in bp.json nodes")

        api_check = select_api_endpoint_check(nodes, result["apiEndpointChecks"])
        if api_check:
            result["apiEndpoint"] = api_check["endpoint"]
            result["sslVerified"]   = bool(api_check["sslVerified"])
            result["apiVerified"]   = bool(api_check["apiVerified"])
            result["apiResponseMs"] = api_check["apiResponseMs"]
            result["nodeosVersion"] = api_check["nodeosVersion"]
            if not result["sslVerified"]:
                errors.append(f"SSL failed: {result['apiEndpoint']}")
            if not result["apiVerified"]:
                errors.append(f"API failed: {result['apiEndpoint']}/v1/chain/get_info")
        else:
            errors.append("No ssl_endpoint found in bp.json nodes")

    testnet_json = None

    if testnet_override_nodes:
        await apply_testnet_nodes(session, result, testnet_override_nodes, errors)
    elif testnet_base_url:
        testnet_json, testnet_errors = await resolve_testnet_bp_json(session, testnet_base_url)
        errors.extend(testnet_errors)
    elif testnet_path:
        testnet_json = await fetch_json(session, metadata_url(base_url, testnet_path))
        if testnet_json:
            testnet_nodes = testnet_json.get("nodes", [])
            await apply_testnet_nodes(session, result, testnet_nodes, errors)
        else:
            errors.append("Testnet bp.json missing or unreachable")
    else:
        testnet_json = None

    if testnet_base_url and testnet_json:
        testnet_nodes = testnet_json.get("nodes", [])
        await apply_testnet_nodes(session, result, testnet_nodes, errors)

    result["validationErrors"] = errors
    return result


def push_benchmark_tx() -> dict:
    """
    Call tlosmechanic::cpu (Mersenne prime benchmark, identical to eosmechanics)
    5 times spaced ~8s apart so each lands in a different BP slot.
    Returns a dict {producer: cpu_us} for every BP captured this run,
    or {} if TLOSMECHANIC_KEY is not set or all calls fail.

    With 21 active BPs rotating through 6-second slots, 5 calls cover
    ~5 different BPs per run — all 21 active BPs appear within ~4-5 runs.
    """
    key = os.environ.get("TLOSMECHANIC_KEY", "").strip()
    if not key:
        print("[Benchmark] TLOSMECHANIC_KEY not set — skipping", file=sys.stderr)
        return {}

    try:
        import pyntelope
        import requests as req

        net = pyntelope.TelosMainnet()
        results: dict = {}
        NUM_TXS   = 5
        SLOT_GAP  = 8   # seconds between pushes (> one 6-second BP slot)

        for i in range(NUM_TXS):
            if i > 0:
                time.sleep(SLOT_GAP)
            try:
                # Call tlosmechanic::cpu — Mersenne prime benchmark, same as eosmechanics
                auth   = pyntelope.Authorization(actor="tlosmechanic", permission="active")
                action = pyntelope.Action(
                    account="tlosmechanic", name="cpu",
                    data=[], authorization=[auth]
                )
                trx    = pyntelope.Transaction(actions=[action])
                linked = trx.link(net=net)
                signed = linked.sign(key=key)
                resp   = signed.send()

                processed = resp.get("processed", {})
                block_num  = processed.get("block_num")
                cpu_us     = processed.get("receipt", {}).get("cpu_usage_us")

                if not block_num or not cpu_us:
                    print(f"[Benchmark {i+1}] Unexpected response: {resp}", file=sys.stderr)
                    continue

                time.sleep(2)  # wait for block to finalise
                r = req.post(
                    f"{TELOS_API}/v1/chain/get_block",
                    json={"block_num_or_id": block_num},
                    timeout=10,
                )
                producer = r.json().get("producer")
                if producer:
                    results[producer] = cpu_us
                    print(f"[Benchmark {i+1}/{NUM_TXS}] block={block_num} "
                          f"producer={producer} cpu={cpu_us}µs", file=sys.stderr)

            except Exception as exc:
                print(f"[Benchmark {i+1}] Failed: {exc}", file=sys.stderr)

        print(f"[Benchmark] Captured {len(results)} BPs: {list(results.keys())}", file=sys.stderr)
        return results

    except Exception as exc:
        print(f"[Benchmark] Fatal: {exc}", file=sys.stderr)
        return {}


def update_history(
    results: list,
    generated_at: str,
    cpu_data: Optional[dict] = None,
) -> None:
    history_path = os.path.normpath(HISTORY_PATH)
    try:
        with open(history_path) as f:
            history = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = {"runs": []}

    snapshot = {
        "t": generated_at,
        "bps": {
            r["owner"]: r["apiResponseMs"]
            for r in results
            if r["apiResponseMs"] > 0
        },
        "missed": {
            r["owner"]: r["missedBlocksPerRotation"]
            for r in results
        },
    }

    if cpu_data:
        snapshot["cpu"] = cpu_data

    history["runs"].append(snapshot)
    history["runs"] = history["runs"][-MAX_HISTORY:]

    with open(history_path, "w") as f:
        json.dump(history, f, separators=(",", ":"))

    print(f"History: {len(history['runs'])} runs stored.", file=sys.stderr)


async def main():
    connector = aiohttp.TCPConnector(limit=30, ssl=False)
    async with aiohttp.ClientSession(connector=connector, headers=REQUEST_HEADERS) as session:
        print("Fetching active schedule and producer lists…", file=sys.stderr)
        schedule_task          = asyncio.create_task(get_active_schedule(session, TELOS_API))
        producers_task         = asyncio.create_task(get_all_producers(session, TELOS_API))
        testnet_schedule_task  = asyncio.create_task(get_active_schedule(session, TELOS_TESTNET_API))
        testnet_producers_task = asyncio.create_task(get_all_producers(session, TELOS_TESTNET_API))
        active_schedule, all_active, testnet_active_schedule, testnet_active = await asyncio.gather(
            schedule_task,
            producers_task,
            testnet_schedule_task,
            testnet_producers_task,
        )
        testnet_by_owner = {p["owner"]: p for p in testnet_active}

    mainnet_owner_set = {p["owner"] for p in all_active}
    temp_testnet_only = [
        {**testnet_by_owner[owner], "url": "", "is_active": 0}
        for owner in TEMP_TESTNET_ENDPOINTS
        if owner in testnet_by_owner and owner not in mainnet_owner_set
    ]
    validation_producers = [*all_active, *temp_testnet_only]

    print(f"Active schedule: {len(active_schedule)} | Total is_active=1: {len(all_active)}",
          file=sys.stderr)
    print(f"Testnet active schedule: {len(testnet_active_schedule)} | Testnet is_active=1: {len(testnet_active)}",
          file=sys.stderr)
    if temp_testnet_only:
        print(f"Temporary testnet-only producers included: {len(temp_testnet_only)}",
              file=sys.stderr)

    connector = aiohttp.TCPConnector(limit=30, ssl=False)
    async with aiohttp.ClientSession(connector=connector, headers=REQUEST_HEADERS) as session:
        results = await asyncio.gather(
            *[
                validate_producer(session, p, active_schedule, testnet_by_owner, testnet_active_schedule)
                for p in validation_producers
            ]
        )

    passing = sum(1 for r in results if r["sslVerified"] and r["apiVerified"])
    print(f"Done. {passing}/{len(results)} passed mainnet checks.", file=sys.stderr)

    # Push 5 benchmark transactions to capture ~5 different BPs this run
    cpu_data = push_benchmark_tx()

    generated_at = datetime.now(timezone.utc).isoformat()
    output = {
        "generatedAt":    generated_at,
        "totalProducers": len(results),
        "producers":      sorted(results, key=lambda r: float(r["total_votes"]), reverse=True),
    }

    print(json.dumps(output, indent=2))
    update_history(list(results), generated_at, cpu_data if cpu_data else None)


if __name__ == "__main__":
    asyncio.run(main())
