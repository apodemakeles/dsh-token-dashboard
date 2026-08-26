# @apodemakeles/dsh-token-dashboard

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) web GUI plugin: a token-consumption heatmap panel. It shows your **total token usage per day / per week** across all projects on this machine, GitHub-contributions style. Usage facts are projected into a local SQLite database by a persistent Worker, so opening the panel never scans session logs.

> Status: **released [v0.2.0](https://github.com/apodemakeles/dsh-token-dashboard/releases/tag/v0.2.0)** — GitHub distribution is live. The package is not currently published to npm.

> **Fork:** this repository is forked from [`apodemakeles/dsh-token-dashboard`](https://github.com/apodemakeles/dsh-token-dashboard). v0.3.0 re-targets the peer and dev dependency ranges from `0.1.0-rc.6` to `^0.1.0-rc.8` so the plugin typechecks, builds, and loads against DeepSeek Harness **rc.8 and later**. No runtime behavior changed.

## Screenshots

### Weekly heatmap

![Weekly token-usage heatmap](docs/images/token-dashboard-weekly.png)

### Daily view

![Daily token-usage bar chart](docs/images/token-dashboard-daily.png)

## What it does

- **Host half** — listens to live `session/event`, flushes through DSH's durability barrier, and sends minimal usage deltas to a persistent Worker. The Worker owns SQLite (`node:sqlite`), commits facts/checkpoints atomically, and serves one consistent snapshot endpoint.
- **Client half** — registers a **Token** entry in the sidebar and opens a dedicated panel rendering the heatmap (weekly grid + daily view). It fetches a single `GET /api/token-dashboard/snapshot` per open/refresh/page change.
- **CLI** — `dsh-token-dashboard status|verify|rebuild|backups|restore|cleanup` for local maintenance.

## Installation

From GitHub:

```bash
dsh plugin --profile web add github:apodemakeles/dsh-token-dashboard
```

Then **restart dsh web**. Open any project session and click the **Token** entry in the sidebar.

The npm package is not currently published; use the GitHub installation above.

## Data and operations

- Projection database: `$DSH_HOME/data/token-dashboard/usage-v1.sqlite` (default `~/.dsh`).
- Total tokens = `inputTokens + outputTokens + cacheReadTokens` (cache reads count into the headline).
- The panel only calls the snapshot route; it does not trigger `listSnapshots`, `inspect`, `readFrom`, `flush`, or backfill.
- Each startup runs a background completeness pass over all session logs (sessions already caught up are verified by revision comparison without reading the log); the panel shows phase/progress until `ready`.

## Development

```bash
git clone https://github.com/apodemakeles/dsh-token-dashboard.git
cd dsh-token-dashboard
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

See [.scratch/dsh-token-dashboard/map.md](.scratch/dsh-token-dashboard/map.md) for the project map (planning tracker), [docs/durable-usage-architecture.md](docs/durable-usage-architecture.md) for the architecture contract, and [docs/dev-loop.md](docs/dev-loop.md) for the full dev loop.

## Known limitations

- Projection is machine-local: it reads sessions stored on this machine (`~/.dsh/sessions` is the authority; SQLite is a rebuildable projection).
- Host/Worker changes require restarting DSH; client HMR does not cover the persistent Worker.
- SQLite is experimental in Node 24 (`node:sqlite`); the plugin checks capability at startup and does not hide the warning globally.

## License

MIT
