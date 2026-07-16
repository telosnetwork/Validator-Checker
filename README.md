# Telos Validator Checker

Standalone static rebuild of the validator dashboard shown at https://infinitybloc.io/validators.

## Files

- `requirements.md` documents the behavior and data contract derived from the live page and source repository.
- `index.html`, `styles.css`, and `app.js` implement the standalone app.
- `ifchecker/` implements the Spring/Savanna instant finality readiness checker at `/ifchecker/`.
- `netlify/functions/` exposes live IF checker API routes through Netlify Functions.
- `validation/ifchecker/latest.json` stores the latest cached IF checker snapshot.
- `scripts/validate_bps.py` generates `validation/latest.json` and `validation/history.json`.
- The app tries local `validation/*.json` first, then local `data/*.json`.
- CPU timing history is also merged from `https://infinitybloc.io/validation/history.json` so benchmark data can continue coming from the original repo while its GitHub secret remains there.
- `.github/workflows/validate.yml` refreshes validation snapshots every 15 minutes and can also be run manually from GitHub Actions.

## Run

Serve the folder with any static HTTP server:

```sh
python3 -m http.server 4173
```

Then open:

```text
http://127.0.0.1:4173/
```

The app fetches JSON files over HTTP, so opening `index.html` directly from the filesystem may not work in all browsers.

## Instant Finality Checker

The IF checker is served from:

```text
/ifchecker/
```

It uses live API routes:

```text
/api/networks
/api/readiness/testnet
/api/readiness/mainnet
```

The page first loads `validation/ifchecker/latest.json` so results are immediately visible on arrival. The scheduled validation workflow refreshes that snapshot, and the page can still run a live refresh through the API routes.

Readiness includes a public live P2P gate for scheduled BPs. A BP passes that gate only when its published BP metadata P2P endpoint completes an Antelope peer handshake on the expected Telos chain. Private host checks such as exact `vote-threads = 4`, finalizer key custody, relay vote propagation, and `safety.dat` protection remain operator-attested checks because public RPC and public P2P handshakes do not expose local node config.

The IF checker table also shows active standby BPs below a divider for operator visibility, with each section ordered by vote rank. Standby rows are checked for published API/P2P health and can still show their finalizer table state, but scheduled finalizer readiness gates and top-level pass counts are based on the active schedule only. Being standby does not by itself make a row `Review`.

The IF checker banner shows `Live` only once the network's `SAVANNA` feature is active and every scheduled BP has an active finalizer. Before that, it distinguishes pending finalizer registration from pending activation; other readiness metrics and review gates remain visible independently.

For Spring/nodeos API version checks, any published endpoint that answers `/v1/chain/get_info` with the expected chain id is classified by its `server_version_string`/`server_full_version_string`, even if the hostname includes `hyperion`.

For Netlify-parity local testing:

```sh
netlify dev --offline --port 8889
```

Then open:

```text
http://localhost:8889/ifchecker/
```
