# Telos Validator Checker

Standalone static rebuild of the validator dashboard shown at https://infinitybloc.io/validators.

## Files

- `requirements.md` documents the behavior and data contract derived from the live page and source repository.
- `index.html`, `styles.css`, and `app.js` implement the standalone app.
- `scripts/validate_bps.py` generates `validation/latest.json` and `validation/history.json`.
- The app tries local `validation/*.json` first, then local `data/*.json`, then falls back to the live public snapshots at `https://infinitybloc.io/validation/`.
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
