# 开发联调循环（dev loop）

本插件是「单包双面 + 常驻 Worker」DSH 插件：host 半区（node 进程）跑实时采集、持久化 Worker 与 /api/token-dashboard/snapshot 路由，client 半区（浏览器）跑面板 UI。联调循环分三档，改动落在哪个半区决定需要哪一档。

## 一次性挂载（每台机器一次）

### web profile

在仓库根目录：

    dsh plugin --profile web add link:（当前目录绝对路径）

即 dsh plugin --profile web add link:. 也可。dsh plugin 是 pnpm 转发器 + bundle reconcile：它把本包以 link: 依赖写进 ~/.dsh/profiles/web/package.json，并自动把 @apodemakeles/dsh-token-dashboard 追加进 dsh.profile.bundles（因为本包声明了 dsh.bundle.patch）。无需手改任何 patch 文件。

卸载：

    dsh plugin --profile web remove @apodemakeles/dsh-token-dashboard

### desktop profile（官方桌面版）

桌面版独占 desktop profile，CLI 明确拒绝它（`dsh plugin --profile desktop` → "managed exclusively by the Electron application"），所以照桌面版插件管理器自己的两步走：

    pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/desktop" add link:（当前目录绝对路径）
    # 然后手工把 @apodemakeles/dsh-token-dashboard 追加进同一份 package.json 的 dsh.profile.bundles
    # （dsh plugin 的 reconcile 那一步在 desktop profile 没有 CLI 入口）

两条 profile 共用同一个 `$DSH_HOME`，所以桌面版与 dsh web 读同一份 `$DSH_HOME/sessions` 和同一个 `$DSH_HOME/data/token-dashboard/usage-v1.sqlite`：历史不需要迁移，但**同一时刻只允许一个进程持有该库**（第二个进程报 `database_in_use`），联调时别让两边同时跑。

## 三档改动与生效方式

| 改动内容 | 生效方式 |
|---|---|
| client 半区代码（src/client/**） | pnpm watch（tsdown --watch 重建 lib/client.js）→ 浏览器热更（需 harness checkout 里同时跑 pnpm run dev:web 的 HMR receiver）；否则刷新页面 |
| host 半区代码（src/host/**、src/index.ts） | 重建 lib/index.js 后重启 dsh web（桌面版则重启 App） |
| 插件集合/声明（package.json 依赖、cordis.patch.yml、dsh.client 字段） | 重启 dsh web / 重启桌面版（HMR 只覆盖 bundle 内容，不改变插件集合） |

## 日常循环

    # 终端 1（仓库根目录）：watch 构建（只重建 bundle 内容）
    pnpm watch

    # 终端 2（DSH harness checkout，/usr/local/lib/node_modules/@deepseek-ai/dsh）：
    # client-plugin HMR receiver —— client 半区改动自动推到已打开的 GUI
    pnpm run dev:web

    # host 半区改动后：重启 dsh web

## 验证

host 半区（重启后）：

    curl 'http://127.0.0.1:3080/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0'

返回 {"ok":true,"value":{...}} 信封；不再有 /summary 与 /days 旧路由。

CLI 冒烟：

    dsh-token-dashboard status
    dsh-token-dashboard verify

client 半区：GUI 侧边栏底部出现 usage 入口，点击打开热力图面板。

桌面版联调：不重启 App 也能先跑隔离验证——把 profile 目录复制成另一个名字（CLI 只拒绝字面上的 desktop），再用 App 自带运行时启动它：

    cp -R "$DSH_HOME/profiles/desktop" "$DSH_HOME/profiles/desktop-verify"
    ELECTRON_RUN_AS_NODE=1 DSH_HOME=$HOME/.dsh \
      "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals \
      "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      --profile desktop-verify --no-open --port 19488

日志会打印带 token 的 URL，用它请求 /api/token-dashboard/snapshot 即可核对 phase/summary。要验证「从零重建」而不动真实库，把 DSH_HOME 指到一个只含 sessions 克隆的临时 home 即可（该 home 里用 profiles/desktop-verify 软链回真实 profile 目录）。

单测：pnpm test（含本机真实会话日志交叉核对，每次改动前跑一遍）。

## 已知坑（沿自 03/04 研究）

- 持久化 Worker 是独立 Node entry：必须 `pnpm build` 生成 `lib/usage-worker.js` 并随包发布；Git/npm 安装不得依赖现场 build。
- host/Worker/SQLite 改动后必须重启 DSH；浏览器 HMR 不会重载常驻 Worker。
- tsdown 对 platform:"node" 默认 fixedExtension 会产出 .mjs——本包已在 tsdown.config.ts 显式关闭；build 顺序必须是 tsdown && tsc -b（否则 clean 抹掉类型）。
- 缺失 lib/client.js 会让 GUI 启动即报错（client bundles not found）——发布前必须 build（prepublishOnly 已保证）。
- lib/client.js 必须是闭包工厂 bundle：外壳按 classic script 执行它，要求其自行调用 `window.__ModuleLoader__.load({id, factory})` 注册（外部依赖走 factory 注入的 `require`，解析冻结模块表）。普通 ESM 产物（`export {...}`）会让 GUI 启动报 `loaded without registering "@apodemakeles/dsh-token-dashboard" via __ModuleLoader__.load`——tsdown.config.ts 的 client 半区已用 banner/intro/footer 包装 cjs 输出（同 dsh-web-ui `shared/tsdown.client.ts` 范式），勿改回 format:"esm"。
- ~/.dsh/cordis.patch.yml（全局）只放用户层 patch，本插件不应写入那里；它作为 bundle 层随 dsh.profile.bundles 生效。
