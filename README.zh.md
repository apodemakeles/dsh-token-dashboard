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
- **客户端半区** —— 在侧边栏注册 **Token** 入口，打开专用面板渲染热力图（周视图网格 + 日视图）。每次打开/刷新/翻页只请求一次 `GET /api/token-dashboard/snapshot`。
- **CLI** —— `dsh-token-dashboard status|verify|rebuild|backups|restore|cleanup` 提供本地运维。

## 安装

从 GitHub：

```bash
dsh plugin --profile web add github:apodemakeles/dsh-token-dashboard
```

安装后**重启 dsh web**。打开任意项目会话，点击侧边栏的 **Token** 入口即可看到热力图面板。

当前未发布 npm 包，请使用上面的 GitHub 安装方式。

## 数据与运维

- 投影数据库：`$DSH_HOME/data/token-dashboard/usage-v1.sqlite`（缺省 `~/.dsh`）。
- Total tokens = `inputTokens + outputTokens + cacheReadTokens`（cache read 计入头条）。
- 面板只调用 snapshot 路由，不触发 `listSnapshots`、`inspect`、`readFrom`、`flush` 或补扫。
- 每次启动都会在后台对全部会话日志做完整性核对（已追平的会话只比较 revision、不读日志），面板显示 phase/progress 直到 `ready`。

## 开发

```bash
git clone https://github.com/apodemakeles/dsh-token-dashboard.git
cd dsh-token-dashboard
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

项目地图（规划 tracker）见 [.scratch/dsh-token-dashboard/map.md](.scratch/dsh-token-dashboard/map.md)，架构合同见 [docs/durable-usage-architecture.md](docs/durable-usage-architecture.md)，完整联调循环（watch / HMR / 重启规则）见 [docs/dev-loop.md](docs/dev-loop.md)。

## 已知限制

- 仅统计本机：权威来源是 `~/.dsh/sessions`，SQLite 是可重建投影。
- host/Worker 改动需要重启 DSH；client HMR 不覆盖常驻 Worker。
- Node 24 的 `node:sqlite` 仍为实验特性；插件启动时做能力检查，不全局屏蔽警告。

## 协议

MIT
