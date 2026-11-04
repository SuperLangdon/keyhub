# AGENTS.md — KeyHub

Web-based driver hub for SinoWealth-firmware wireless keyboards, and an open registry of community keyboard profiles. **Pure static site, zero dependencies** — no npm packages, no bundler, no build step; the site must stay fully offline-capable (no font/asset CDNs). Runs in Chrome/Edge via WebHID (requires `localhost` or HTTPS).

## Commands (all zero-install Node)

```bash
node tools/serve.mjs [port]              # dev server (default 8123); WebHID needs localhost/HTTPS
node tools/validate-registry.mjs         # registry validation — CI gate
node --test tools/test/protocol.test.mjs # protocol unit tests — CI gate
node --input-type=module --check < js/any.js   # per-file syntax check — CI gate
node tools/bump-build.mjs                # refresh BUILD marker (git hash + date) — run after ANY js change
node tools/check-main.mjs js/any.js      # actually import a module to see runtime errors
node tools/convert.mjs <driver-dir> --contributor <id>  # convert official driver KB.ini into a registry profile
```

CI (`.github/workflows/validate.yml`) = registry validation + protocol tests + syntax check of every `js/**` file.

## Layout & layer rules

- `index.html` + `css/app.css` (single stylesheet) + `js/` ES modules loaded natively.
- `js/store.js` — global `state`, localStorage persistence, event bus (`on`/`emit`), exports `BUILD`. The localStorage key `leobog-web-v1` is a historical name kept for old users' data — **do not rename**.
- `js/main.js` — boot & navigation. Feature pages are lazy-loaded via dynamic `import()` in the `PAGES` table — **never statically import from `js/pages/`**.
- `js/pages/` — feature pages (keys / light / macro / screen / settings).
- `js/device/` — device layer: `protocol.js` (reverse-engineered 20-byte HID report protocol, each command annotated with its source), `webhid.js` (real hardware), `film.js` (simulator), `panel.js` (HID debug console), `index.js` (unified `device` interface + `devLog(kind, msg)` with kinds tx/rx/in/ok/warn/er).
- `js/keyboard/` — keyboard stage rendering (`render.js`) and light simulation (`lightsim.js`).
- `js/ui.js` — DOM helpers: `h()` builder, `toast()`, `modalA11y()`. All dynamic dialogs must go through `modalA11y()`.
- `js/i18n.js` — `L('中文', 'English')` for inline bilingual strings; `t()` reads driver language packs from `assets/i18n/`.
- `assets/models/` — the model registry: pure-data JSON per keyboard (`<slug>/model.json` + `keyimg.png`) + `index.json` manifest. **Adding a model = data only, no JS changes.** Schema & rules: `docs/registry-schema.md`.

## Conventions

- Code comments and most docs are in Chinese — match that.
- Every user-visible string goes through `L(zh, en)`.
- Design tokens live **only** in `css/app.css` `:root` / `:root[data-theme="dark"]` — never hardcode colors; dark theme must fall out of variables automatically. `DESIGN.md` narrates the system; on conflict, CSS wins. Key rules: single orange accent `--primary`, 1px hairlines instead of shadows/gradients, mono font for hex/logs/VID:PID, keyboard stage fixed height `calc(100vh − 376px)`.
- After editing any file under `js/`, run `node tools/bump-build.mjs` (logs/diagnostics compare against `BUILD` to detect stale module caches).

## Gotchas

- Don't execute `js/` modules in Node to test them — most touch the browser DOM (that's why CI only syntax-checks). Use `tools/check-main.mjs` when you need a real import.
- Write operations go to real keyboard firmware. New protocol generations require reverse-engineering + real-device verification; unknown `fw` values are rejected by `validate-registry.mjs` (`KNOWN_FW` whitelist) — never blind-write to hardware.
- `DEVICE_FAMILIES` in `protocol.js` is only a built-in fallback; it is rebuilt at runtime from the registry (`rebuildDeviceFamilies()`), so new VID/PIDs come from `assets/models/index.json`, not code.
- Registry validation enforces: PSD uniqueness (colliding models need distinguishing fields), required `source/attribution/contributor/added` provenance, pure data (no executable content).

## Read before touching

- UI/CSS work → `DESIGN.md`
- `assets/models/` or `index.json` → `docs/registry-schema.md`
- Contribution flows / protocol reverse-engineering path → `CONTRIBUTING.md`
