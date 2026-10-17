# KeyHub

A web-based driver hub for wireless keyboards built on the SinoWealth firmware platform — pure static site, zero dependencies, no install: connect your keyboard in the browser via WebHID (Chrome/Edge, localhost or HTTPS).

KeyHub is also an **open registry of community-maintained keyboard profiles** (`assets/models/`): one folder of pure-data JSON per model. 10 models are built in today (LEOBOG Hi75/A75/Hi8/Hi86/Hi98 family, YINDIAO K65, …) — yours can be next:

- Have the official driver? Convert it into a profile in ~10 minutes: see [CONTRIBUTING.md](CONTRIBUTING.md)（中文）.
- Keyboard only? Connect it, click *Add device*, and use the "Help adapt this keyboard" flow to file an adapter request with a one-click diagnostics bundle.
- Registry data schema & rules: [docs/registry-schema.md](docs/registry-schema.md).

Features: model auto-identification (PSD fingerprint), per-key RGB painting, lighting effects, key remapping layers, macros, battery & sleep settings, plus an HID console with read-only probes for tinkerers.

> WIP — use at your own risk. 写入操作均下发到键盘固件，请自行评估风险。
