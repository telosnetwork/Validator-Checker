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
- `.github/workflows/validate.yml` refreshes validation snapshots every six hours and can also be run manually from GitHub Actions.

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

For Netlify-parity local testing:

```sh
netlify dev --offline --port 8889
```

Then open:

```text
http://localhost:8889/ifchecker/
```
