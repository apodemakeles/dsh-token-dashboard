# @apodemakeles/dsh-token-dashboard

[English](README.md) | 中文

一个 DeepSeek Harness (DSH) Web GUI 插件：token 消耗热力图面板。以 GitHub 贡献图风格展示本机**所有项目的每日/每周 token 总消耗**。Usage facts 由常驻 Worker 投影到本地 SQLite，打开面板不会扫描会话日志。

> 状态：**已发布 [v0.2.0](https://github.com/apodemakeles/dsh-token-dashboard/releases/tag/v0.2.0)** —— GitHub 分发已上线；当前未发布到 npm。

## 界面截图

### 周视图

![Token 用量周视图热力图](docs/images/token-dashboard-weekly.png)

### 日视图

![Token 用量日视图柱状图](docs/images/token-dashboard-daily.png)

## 功能

- **宿主半区** —— 监听实时 `session/event`，经过 DSH 持久化屏障后把最小 usage 增量发给常驻 Worker；Worker 独占 SQLite（`node:sqlite`），原子提交 facts/checkpoint，并提供单一一致快照接口。
- **客户端半区** —— 在侧边栏底部放一个常驻的**今日胶囊**（`● 今日 478.9k tokens`）：不用点开任何东西就能看到今天的消耗，靠一次轻量 `weeks=1` 快照读取刷新——挂载时、窗口获得焦点时、面板关闭时，以及窗口可见期间每 30 秒一次。点击它打开面板（周视图网格 + 日视图），面板每次打开/刷新/翻页只请求一次 `GET /api/token-dashboard/snapshot`。
- **CLI** —— `dsh-token-dashboard status|verify|rebuild|backups|restore|cleanup` 提供本地运维。

## 安装

本插件是「一个包、两个半区」，没有运行时依赖；DSH **web** profile 与官方 **DeepSeek Harness 桌面版**（在 Electron 里启动同一个 Web App，使用自己的 `desktop` profile）都能运行。

### 桌面版

CLI 拒绝 `--profile desktop`（"managed exclusively by the Electron application"），所以按桌面版插件管理器自己的做法装进 desktop profile：声明依赖，再在 profile 目录里跑 pnpm。

```bash
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE="$DSH_HOME/profiles/desktop"

# 1. 在 desktop profile 清单里加依赖，并安装
pnpm --dir "$PROFILE" add github:apodemakeles/dsh-token-dashboard   # 本地开发用 link:/path/to/checkout
```

2. 把这个包追加进同一份清单的 `dsh.profile.bundles`，profile 才会加载它的 `cordis.patch.yml` 层：

```json
{ "dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@apodemakeles/dsh-token-dashboard"
] } } }
```

重启桌面版后，应用内 **插件 → 已安装** 会把它列为已启用的插件，侧边栏底部出现 **今日 N tokens** 胶囊。

### web profile

从 GitHub：

```bash
dsh plugin --profile web add github:apodemakeles/dsh-token-dashboard
```

安装后**重启 dsh web**。侧边栏底部出现 **今日 N tokens** 胶囊，点击即可打开热力图面板。

当前未发布 npm 包，请使用上面的 GitHub 安装方式。

## 数据与运维

- 投影数据库：`$DSH_HOME/data/token-dashboard/usage-v1.sqlite`（缺省 `~/.dsh`）。
- 所有 profile 共用一个 Harness home：桌面版与 `dsh web` 读的是**同一个数据库**和同一份 `$DSH_HOME/sessions` 日志，一边收集的历史另一边直接可见，不需要迁移步骤。
- Total tokens = `inputTokens + outputTokens + cacheReadTokens`（cache read 计入头条）。
- 面板只调用 snapshot 路由，不触发会话枚举、`inspect`、来源读取、`flush` 或补扫。
- 首次启动会在后台初始化数据库，面板显示 phase/progress 直到 `ready`。
- 当前 harness 无法解释的会话日志（例如 pre-release 子智能体日志的 descriptor 版本已不受支持）会被隔离：原因打到 stderr，phase 落到 `degraded` 而不是 `ready`，而它此前已提交的 facts 仍留在数据库里。

## 开发

```bash
git clone https://github.com/apodemakeles/dsh-token-dashboard.git
cd dsh-token-dashboard
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

桌面版改为指向本地 checkout：

```bash
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/desktop" add link:$(pwd)
```

项目地图（规划 tracker）见 [.scratch/dsh-token-dashboard/map.md](.scratch/dsh-token-dashboard/map.md)，架构合同见 [docs/durable-usage-architecture.md](docs/durable-usage-architecture.md)，完整联调循环（watch / HMR / 重启规则）见 [docs/dev-loop.md](docs/dev-loop.md)。

## 已知限制

- 仅统计本机：权威来源是 `~/.dsh/sessions`，SQLite 是可重建投影。
- host/Worker 改动需要重启 DSH；client HMR 不覆盖常驻 Worker。
- Node 24 的 `node:sqlite` 仍为实验特性；插件启动时做能力检查，不全局屏蔽警告。
- 需要 harness 提供的 `sessionPersistence` 服务：当前构建的 handle 形态（`list`/`open`）与 0.1.0-rc.6 的 snapshot 形态（`listSnapshots`/`readFrom`）都支持；两者都没有时启动会明确报错而不是静默降级。

## 协议

MIT
