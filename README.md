> **Archived / superseded.** This plugin is now part of
> [`@apodemakeles/dsh-kit`](https://github.com/apodemakeles/dsh-kit), which merges
> the token dashboard and turn notifications into one bundle. This repository is
> archived and no longer maintained.

# @apodemakeles/dsh-token-dashboard

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) web GUI plugin: a token-consumption heatmap panel. It shows your **total token usage per day / per week** across all projects on this machine, GitHub-contributions style. Usage facts are projected into a local SQLite database by a persistent Worker, so opening the panel never scans session logs.

> Status: **released [v0.2.0](https://github.com/apodemakeles/dsh-token-dashboard/releases/tag/v0.2.0)** — GitHub distribution is live. The package is not currently published to npm.

## Screenshots

### Weekly heatmap

![Weekly token-usage heatmap](docs/images/token-dashboard-weekly.png)

### Daily view

![Daily token-usage bar chart](docs/images/token-dashboard-daily.png)

## What it does

- **Host half** — listens to live `session/event`, flushes through DSH's durability barrier, and sends minimal usage deltas to a persistent Worker. The Worker owns SQLite (`node:sqlite`), commits facts/checkpoints atomically, and serves one consistent snapshot endpoint.
- **Client half** — puts a live **today capsule** in the sidebar footer (`● 今日 478.9k tokens`): today's total, always visible without opening anything, refreshed by one cheap `weeks=1` snapshot read on mount, on window focus, when the panel closes, and every 30s while the window is visible. Clicking it opens the panel — weekly heatmap grid + daily view — which fetches a single `GET /api/token-dashboard/snapshot` per open/refresh/page change.
- **CLI** — `dsh-token-dashboard status|verify|rebuild|backups|restore|cleanup` for local maintenance.

## Installation

The plugin is one package with two halves and no runtime dependencies; it runs on the DSH **web** profile and in the official **DeepSeek Harness desktop app** (which boots the same web App inside Electron on its own `desktop` profile).

### Desktop app

The CLI refuses `--profile desktop` ("managed exclusively by the Electron application"), so install into the desktop profile the way the app's own plugin manager does — declare the dependency and run pnpm in the profile directory:

```bash
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE="$DSH_HOME/profiles/desktop"

# 1. add the dependency to the desktop profile manifest and re-run pnpm
pnpm --dir "$PROFILE" add github:apodemakeles/dsh-token-dashboard   # or: link:/path/to/checkout
```

Then add the package to that manifest's `dsh.profile.bundles` list, so the profile loads its `cordis.patch.yml` layer:

```json
{ "dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@apodemakeles/dsh-token-dashboard"
] } } }
```

Restart the desktop app. The app's **插件 → 已安装** screen lists the package as an enabled plugin, and the **今日 N tokens** capsule appears in the sidebar footer.

### Web profile

From GitHub:

```bash
dsh plugin --profile web add github:apodemakeles/dsh-token-dashboard
```

Then **restart dsh web**. The sidebar footer shows the **今日 N tokens** capsule; click it to open the heatmap panel.

The npm package is not currently published; use the GitHub installation above.

## Data and operations

- Projection database: `$DSH_HOME/data/token-dashboard/usage-v1.sqlite` (default `~/.dsh`).
- Profiles share one Harness home, so the desktop app and `dsh web` read the **same** database and the same `$DSH_HOME/sessions` logs: history collected under one profile shows up under the other with no migration step.
- Total tokens = `inputTokens + outputTokens + cacheReadTokens` (cache reads count into the headline).
- The panel only calls the snapshot route; it does not trigger a session listing, `inspect`, a source read, `flush`, or backfill.
- First startup initializes the database in the background; the panel shows phase/progress until `ready`.
- A session log the running harness cannot interpret (for example a pre-release subagent log whose child descriptors are no longer readable) is isolated: it is listed on stderr with its reason, the phase ends `degraded` instead of `ready`, and the facts already committed for it stay in the database.

## Development

```bash
git clone https://github.com/apodemakeles/dsh-token-dashboard.git
cd dsh-token-dashboard
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

For the desktop app, point it at the checkout instead:

```bash
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/desktop" add link:$(pwd)
```

See [.scratch/dsh-token-dashboard/map.md](.scratch/dsh-token-dashboard/map.md) for the project map (planning tracker), [docs/durable-usage-architecture.md](docs/durable-usage-architecture.md) for the architecture contract, and [docs/dev-loop.md](docs/dev-loop.md) for the full dev loop.

## Known limitations

- Projection is machine-local: it reads sessions stored on this machine (`~/.dsh/sessions` is the authority; SQLite is a rebuildable projection).
- Host/Worker changes require restarting DSH; client HMR does not cover the persistent Worker.
- SQLite is experimental in Node 24 (`node:sqlite`); the plugin checks capability at startup and does not hide the warning globally.

## License

MIT
