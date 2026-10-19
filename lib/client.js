window.__ModuleLoader__.load({
	id: "@apodemakeles/dsh-token-dashboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
		//#region src/client/locales.ts
		const zh = {
			title: "Token 用量",
			today: "今日",
			week: "本周",
			month30: "近 30 天",
			all: "全部",
			weekView: "周视图",
			dayView: "日视图",
			refresh: "刷新",
			refreshedAt: "上次更新",
			close: "关闭",
			older: "← 更早",
			newer: "更新 →",
			recentWeeks: "最近 {n} 周",
			rangeWeeks: "第 {n} 周",
			legendLess: "少",
			legendMore: "多",
			hoverTotal: "{date} · {total} tokens",
			hoverRequests: "{n} 次请求",
			loading: "加载中…",
			error: "加载失败：{message}",
			entryLabel: "Token 用量",
			others: "others",
			sessions: "{n} 个会话",
			empty: "暂无数据",
			initializing: "初始化中…",
			recovering: "恢复中…",
			degraded: "数据不完整",
			warnings: "{n} 条警告",
			pending: "{n} 个批次待写入"
		};
		const en = {
			title: "Token Usage",
			today: "Today",
			week: "This week",
			month30: "Last 30 days",
			all: "All time",
			weekView: "Week",
			dayView: "Day",
			refresh: "Refresh",
			refreshedAt: "Updated",
			close: "Close",
			older: "← Older",
			newer: "Newer →",
			recentWeeks: "Last {n} weeks",
			rangeWeeks: "Weeks {n}",
			legendLess: "Less",
			legendMore: "More",
			hoverTotal: "{date} · {total} tokens",
			hoverRequests: "{n} requests",
			loading: "Loading…",
			error: "Failed to load: {message}",
			entryLabel: "Token usage",
			others: "others",
			sessions: "{n} sessions",
			empty: "No data yet",
			initializing: "Initializing…",
			recovering: "Recovering…",
			degraded: "Incomplete data",
			warnings: "{n} warnings",
			pending: "{n} batches pending"
		};
		//#endregion
		//#region src/client/styles.ts
		const PANEL_STYLE_ID = "dsh-token-dashboard-styles";
		const STYLE_TEXT = [
			":root {",
			"  --td-bg: #ffffff; --td-card: #f7f8fa; --td-border: #e6e8ec; --td-text: #1f2430; --td-muted: #71788a;",
			"  --td-c0: #eef1f4; --td-c1: #c9e6c0; --td-c2: #8fd08a; --td-c3: #4cb155; --td-c4: #2b8a3e; --td-c5: #1b6e2f;",
			"  --td-accent: #3b82f6; --td-accent-soft: #eaf2fe;",
			"  --td-shadow: 0 24px 64px rgba(23, 32, 60, 0.18), 0 2px 8px rgba(23, 32, 60, 0.08);",
			"}",
			"body[data-ds-dark-theme] {",
			"  --td-bg: #171a21; --td-card: #1e222b; --td-border: #2a2f3a; --td-text: #e7e9ee; --td-muted: #8b93a5;",
			"  --td-c0: #242a34; --td-c1: #1d4428; --td-c2: #2a6b33; --td-c3: #3d9b48; --td-c4: #57c163; --td-c5: #7ee787;",
			"  --td-accent: #4c8dff; --td-accent-soft: #1d2b47;",
			"  --td-shadow: 0 24px 64px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3);",
			"}",
			".td-panel {",
			"  position: fixed; z-index: 1200; left: 50%; top: 50%; transform: translate(-50%, -50%);",
			"  width: min(960px, calc(100vw - 56px)); height: min(660px, calc(100vh - 100px));",
			"  display: flex; flex-direction: column; overflow: hidden;",
			"  background: var(--td-bg); border: 1px solid var(--td-border); border-radius: 16px;",
			"  box-shadow: var(--td-shadow); color: var(--td-text); pointer-events: auto;",
			"  font-family: -apple-system, \"PingFang SC\", \"Segoe UI\", sans-serif; font-size: 13px;",
			"}",
			".td-head { display: flex; align-items: center; gap: 16px; padding: 16px 20px 12px; }",
			".td-head h2 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0.2px; }",
			".td-spacer { flex: 1; }",
			".td-tabs { display: inline-flex; padding: 4px; border-radius: 12px; background: var(--td-card); border: 1px solid var(--td-border); }",
			".td-tabs button { border: 0; background: transparent; color: var(--td-muted); padding: 9px 26px; font-size: 14px; font-weight: 600; cursor: pointer; border-radius: 9px; transition: color .15s, background .15s, box-shadow .15s; }",
			".td-tabs button.on { background: var(--td-accent); color: #fff; box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35); }",
			".td-btn { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; padding: 8px 16px; border: 1px solid var(--td-border); border-radius: 10px; background: var(--td-card); color: var(--td-text); cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .05s; }",
			".td-btn:hover { border-color: var(--td-accent); box-shadow: 0 1px 6px rgba(59, 130, 246, 0.18); }",
			".td-btn:active { transform: translateY(1px); }",
			".td-btn:disabled { opacity: .45; cursor: default; box-shadow: none; border-color: var(--td-border); }",
			".td-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--td-muted); cursor: pointer; font-size: 15px; transition: background .15s, color .15s; }",
			".td-iconbtn:hover { background: var(--td-card); color: var(--td-text); }",
			".td-stats { display: flex; gap: 12px; padding: 4px 20px 14px; }",
			".td-stat { flex: 1; background: var(--td-card); border: 1px solid var(--td-border); border-radius: 12px; padding: 12px 16px; }",
			".td-stat .num { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }",
			".td-stat .lbl { font-size: 11px; color: var(--td-muted); margin-top: 2px; }",
			".td-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 6px 20px 16px; }",
			".td-body-scroll { flex: 1; min-height: 0; overflow: auto; padding-top: 4px; }",
			".td-pager { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 14px; }",
			".td-pager .td-cap { color: var(--td-muted); font-size: 12px; min-width: 130px; text-align: center; }",
			".td-grid-wrap { height: 100%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 10px 0 6px; overflow: hidden; }",
			".td-grid { display: inline-block; }",
			".td-months { position: relative; display: block; height: 17px; margin-bottom: 4px; }",
			".td-months span { position: absolute; top: 0; font-size: 10.5px; color: var(--td-muted); white-space: nowrap; font-weight: 500; }",
			".td-row { display: flex; gap: 6px; margin-bottom: 6px; }",
			".td-weekday { width: 28px; font-size: 11px; color: var(--td-muted); text-align: right; padding-right: 8px; line-height: 20px; }",
			".td-cell { width: 20px; height: 20px; border-radius: 5px; cursor: pointer; transition: transform .08s; }",
			".td-cell:hover { transform: scale(1.18); outline: 1.5px solid var(--td-accent); outline-offset: 1px; }",
			".td-legend { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11px; color: var(--td-muted); margin-top: 14px; }",
			".td-legend .td-cell { cursor: default; }",
			".td-legend .td-cell:hover { transform: none; outline: none; }",
			".td-tip { position: fixed; z-index: 9999; background: rgba(17, 24, 39, 0.96); color: #fff; font-size: 12px; padding: 10px 12px; border-radius: 10px; pointer-events: none; white-space: nowrap; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.08); backdrop-filter: blur(6px); }",
			".td-tip .big { font-weight: 650; font-size: 12.5px; }",
			".td-tip .sub { color: #a8b0c0; font-size: 11px; margin-top: 2px; }",
			".td-tip .sub.model { display: flex; justify-content: space-between; gap: 24px; margin-top: 3px; }",
			".td-tip .sub.model .name { white-space: nowrap; }",
			".td-tip .sub.model .val { color: #d7dce6; font-variant-numeric: tabular-nums; }",
			".td-tip .divider { height: 1px; background: rgba(255, 255, 255, 0.12); margin: 5px 0; }",
			".td-daywrap { position: relative; height: 100%; display: flex; flex-direction: column; }",
			".td-bars { display: flex; align-items: flex-end; gap: 4px; flex: 1; min-height: 0; padding: 8px 18px 0 0; border-bottom: 1px solid var(--td-border); }",
			".td-bar { flex: 1; background: var(--td-accent); border-radius: 4px 4px 0 0; min-width: 6px; opacity: .55; cursor: pointer; transition: opacity .12s; }",
			".td-bar.empty { background: transparent; cursor: default; opacity: 1; }",
			".td-bar:hover { opacity: 1; }",
			".td-bar.today { opacity: 1; background: linear-gradient(180deg, var(--td-accent), #2563eb); }",
			".td-axis { display: flex; justify-content: space-between; padding: 8px 18px 0 0; font-size: 11px; color: var(--td-muted); }",
			".td-status { color: var(--td-muted); padding: 24px 0; text-align: center; }",
			".td-foot { display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid var(--td-border); color: var(--td-muted); font-size: 11px; }",
			".td-entry { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 10px; background: transparent; border: 0; color: var(--td-muted); cursor: pointer; border-radius: 9px; transition: background .15s, color .15s; }",
			".td-entry:hover { background: var(--td-card); }",
			".td-entry:not(:has(.td-entry-label)) { width: auto; justify-content: center; }",
			".td-entry-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--td-c3); box-shadow: 0 0 6px rgba(61, 155, 72, 0.55); flex: none; }",
			".td-entry-label { font-size: 12.5px; color: var(--td-muted); white-space: nowrap; }",
			".td-entry-num { font-size: 14px; font-weight: 650; color: var(--td-text); font-variant-numeric: tabular-nums; letter-spacing: .2px; }",
			".td-entry-unit { font-size: 10.5px; color: var(--td-muted); opacity: .75; }"
		].join("\n");
		function injectStyles() {
			if (document.getElementById("dsh-token-dashboard-styles") !== null) return;
			const style = document.createElement("style");
			style.id = PANEL_STYLE_ID;
			style.textContent = STYLE_TEXT;
			document.head.appendChild(style);
		}
		//#endregion
		//#region src/client/fmt.ts
		function fmt(n) {
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(n);
		}
		//#endregion
		//#region src/client/store.ts
		function createStore(initial) {
			let state = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(update) {
					state = update(state);
					for (const listener of listeners) listener();
				}
			};
		}
		/** Panel visibility, toggled by the sidebar entry and the panel close button. */
		const panelStore = createStore(false);
		const togglePanel = () => panelStore.set((open) => !open);
		const closePanel = () => panelStore.set(() => false);
		//#endregion
		//#region src/client/snapshot.ts
		async function fetchSnapshot(options = {}) {
			const url = `/api/token-dashboard/snapshot?weeks=${options.weeks ?? 26}&offsetWeeks=${options.offsetWeeks ?? 0}`;
			const res = await fetch(url, {
				headers: { accept: "application/json" },
				signal: options.signal
			});
			if (!res.ok) {
				let message = "HTTP " + res.status;
				try {
					const body = await res.json();
					if (body.error?.message !== void 0) message = body.error.message;
				} catch {}
				throw new Error(message);
			}
			const envelope = await res.json();
			if (!envelope.ok) throw new Error(envelope.error.message);
			return envelope.value;
		}
		//#endregion
		//#region src/client/entry/today-usage.ts
		const REFRESH_WHILE_VISIBLE_MS = 3e4;
		const FOCUS_DEBOUNCE_MS = 300;
		/** Latest `summary.today` in tokens, or undefined before the first success. */
		function useTodayUsage() {
			const [today, setToday] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let disposed = false;
				let timer;
				let focusTimer;
				const refresh = () => {
					fetchSnapshot({ weeks: 1 }).then((snapshot) => {
						if (!disposed) setToday(snapshot.summary.today);
					}).catch(() => {});
				};
				const applyVisibility = () => {
					if (document.visibilityState === "visible") {
						if (timer === void 0) {
							refresh();
							timer = window.setInterval(refresh, REFRESH_WHILE_VISIBLE_MS);
						}
					} else if (timer !== void 0) {
						window.clearInterval(timer);
						timer = void 0;
					}
				};
				const onFocus = () => {
					window.clearTimeout(focusTimer);
					focusTimer = window.setTimeout(refresh, FOCUS_DEBOUNCE_MS);
				};
				const unsubscribePanel = panelStore.subscribe(() => {
					if (!panelStore.getSnapshot()) refresh();
				});
				document.addEventListener("visibilitychange", applyVisibility);
				window.addEventListener("focus", onFocus);
				applyVisibility();
				return () => {
					disposed = true;
					document.removeEventListener("visibilitychange", applyVisibility);
					window.removeEventListener("focus", onFocus);
					window.clearTimeout(focusTimer);
					window.clearInterval(timer);
					unsubscribePanel();
				};
			}, []);
			return today;
		}
		//#endregion
		//#region src/client/entry/FooterTokenEntry.tsx
		function FooterTokenEntry({ t, wide }) {
			const today = useTodayUsage();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				className: "td-entry",
				onClick: togglePanel,
				title: t("entryLabel"),
				"aria-label": t("entryLabel"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "td-entry-dot",
						"aria-hidden": "true"
					}),
					wide && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "td-entry-label",
						children: [
							t("today"),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "td-entry-num",
								children: today === void 0 ? "—" : fmt(today)
							})
						]
					}),
					wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "td-entry-unit",
						children: "tokens"
					})
				]
			});
		}
		//#endregion
		//#region src/client/panel/Tip.tsx
		const MARGIN = 10;
		const TIP_WIDTH = 360;
		const TIP_HEIGHT = 170;
		const TOP_MODELS = 3;
		/** Clamp a viewport point so a TIP_WIDTH x TIP_HEIGHT box stays fully visible. */
		function clampTip(x, y) {
			let left = x + 12;
			if (left + TIP_WIDTH > window.innerWidth - MARGIN) left = x - TIP_WIDTH - 12;
			left = Math.max(MARGIN, Math.min(left, window.innerWidth - TIP_WIDTH - MARGIN));
			const top = Math.max(MARGIN, Math.min(y + 10, window.innerHeight - TIP_HEIGHT - MARGIN));
			return {
				left,
				top
			};
		}
		function Tip({ x, y, children }) {
			const { left, top } = clampTip(x, y);
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "td-tip",
				style: {
					left,
					top
				},
				children
			}), document.body);
		}
		/** Tooltip body: date + total, per-model top-3 + others, request count. */
		function DayTipContent({ day, t }) {
			const models = day.byModel ?? [];
			const top = models.slice(0, TOP_MODELS);
			const restTokens = models.slice(TOP_MODELS).reduce((sum, entry) => sum + entry.tokens, 0);
			const restCount = models.length - top.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "big",
					children: t("hoverTotal", {
						date: day.date,
						total: fmt(day.totalTokens)
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "divider" }),
				top.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sub model",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "name",
						children: [
							entry.provider,
							" · ",
							entry.model
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "val",
						children: fmt(entry.tokens)
					})]
				}, entry.provider + "::" + entry.model)),
				restCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sub model",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "name",
						children: [
							t("others"),
							"（",
							restCount,
							"）"
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "val",
						children: fmt(restTokens)
					})]
				}),
				models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "sub",
					children: t("empty")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "divider" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "sub",
					children: t("hoverRequests", { n: day.requests })
				})
			] });
		}
		//#endregion
		//#region src/client/panel/DayView.tsx
		function DayView({ days, t }) {
			const [tip, setTip] = (0, react.useState)(null);
			const recent = (0, react.useMemo)(() => days.slice(-30), [days]);
			const max = (0, react.useMemo)(() => recent.reduce((m, d) => Math.max(m, d.totalTokens), 0), [recent]);
			const firstDate = recent.length > 0 ? recent[0].date : "";
			const todayDate = recent.length > 0 ? recent[recent.length - 1].date : "";
			const onMove = (day, event) => {
				setTip({
					day,
					x: event.clientX,
					y: event.clientY
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "td-daywrap",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "td-bars",
						children: recent.map((day, index) => day.totalTokens <= 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "td-bar empty" }, day.date) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: index === recent.length - 1 ? "td-bar today" : "td-bar",
							style: { height: max > 0 ? Math.max(3, Math.round(day.totalTokens / max * 100)) + "%" : "3px" },
							onMouseMove: (e) => onMove(day, e),
							onMouseLeave: () => setTip(null)
						}, day.date))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-axis",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: firstDate }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							todayDate,
							" · ",
							t("today")
						] })]
					}),
					tip !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tip, {
						x: tip.x,
						y: tip.y,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DayTipContent, {
							day: tip.day,
							t
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/panel/Heatmap.tsx
		const WEEKDAYS = [
			"日",
			"一",
			"二",
			"三",
			"四",
			"五",
			"六"
		];
		const CELL = 20;
		const COL_PITCH = 26;
		const MONTH_LEFT = (col) => 42 + col * COL_PITCH;
		const LEVELS = [
			"var(--td-c1)",
			"var(--td-c2)",
			"var(--td-c3)",
			"var(--td-c4)",
			"var(--td-c5)"
		];
		function colorOf(total, max) {
			if (total <= 0 || max <= 0) return "var(--td-c0)";
			const r = total / max;
			if (r < .2) return LEVELS[0];
			if (r < .4) return LEVELS[1];
			if (r < .65) return LEVELS[2];
			if (r < .85) return LEVELS[3];
			return LEVELS[4];
		}
		function Heatmap({ days, t }) {
			const [tip, setTip] = (0, react.useState)(null);
			const max = (0, react.useMemo)(() => days.reduce((m, d) => Math.max(m, d.totalTokens), 0), [days]);
			const weekdayOf = (date) => (/* @__PURE__ */ new Date(date + "T00:00:00Z")).getUTCDay();
			const rows = (0, react.useMemo)(() => {
				const table = [
					[],
					[],
					[],
					[],
					[],
					[],
					[]
				];
				const first = days.length > 0 ? weekdayOf(days[0].date) : 0;
				for (let pad = 0; pad < first; pad++) table[pad].push(null);
				for (const day of days) table[weekdayOf(day.date)].push(day);
				return table;
			}, [days]);
			const months = (0, react.useMemo)(() => {
				const out = [];
				let firstCol = 0;
				days.forEach((day, index) => {
					const label = day.date.slice(5, 7) + "月";
					const col = Math.floor(index / 7);
					const last = out[out.length - 1];
					if (last === void 0 || last.label !== label) {
						if (last !== void 0) {
							const prevCol = Math.floor((index - 1) / 7);
							last.center = (firstCol + prevCol) * COL_PITCH / 2 + CELL / 2;
						}
						out.push({
							label,
							center: 0
						});
						firstCol = col;
					}
				});
				const lastEntry = out[out.length - 1];
				if (lastEntry !== void 0 && days.length > 0) {
					const lastCol = Math.floor((days.length - 1) / 7);
					lastEntry.center = (firstCol + lastCol) * COL_PITCH / 2 + CELL / 2;
				}
				return out;
			}, [days]);
			const onMove = (day, event) => {
				setTip({
					day,
					x: event.clientX,
					y: event.clientY
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "td-grid-wrap",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "td-grid",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "td-months",
						children: months.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								left: MONTH_LEFT(0) + m.center,
								transform: "translateX(-50%)"
							},
							children: m.label
						}, m.label))
					}), rows.map((row, weekday) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "td-weekday",
							children: WEEKDAYS[weekday]
						}), row.map((day, i) => day === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "td-cell",
							style: { background: "transparent" }
						}, "pad-" + i) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "td-cell",
							style: { background: colorOf(day.totalTokens, max) },
							onMouseMove: (e) => onMove(day, e),
							onMouseLeave: () => setTip(null)
						}, day.date))]
					}, weekday))]
				}), tip !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tip, {
					x: tip.x,
					y: tip.y,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DayTipContent, {
						day: tip.day,
						t
					})
				})]
			});
		}
		//#endregion
		//#region src/client/panel/SnapshotStatus.tsx
		function SnapshotStatus({ snapshot, t }) {
			const { projection } = snapshot;
			if (projection.complete && projection.phase === "ready" && snapshot.warnings.count === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "td-status-line",
				role: "status",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(projection.phase === "initializing" ? "initializing" : projection.phase === "recovering" ? "recovering" : "degraded") }),
					projection.pendingBatches > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("pending", { n: projection.pendingBatches }) }),
					snapshot.warnings.count > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("warnings", { n: snapshot.warnings.count }) })
				]
			});
		}
		//#endregion
		//#region src/client/panel/Panel.tsx
		const WEEKS = 26;
		/** Contains any render error inside the panel: the slot entry must survive
		*  bad host data instead of unmounting the whole plugin surface. */
		var PanelErrorBoundary = class extends react.Component {
			state = { failed: false };
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error, info) {
				console.error("dsh-token-dashboard: panel render error", error, info);
			}
			render() {
				return this.state.failed ? this.props.fallback : this.props.children;
			}
		};
		const REFRESH_ICON = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			viewBox: "0 0 16 16",
			width: "13",
			height: "13",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.5",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.7 1.8v2.9h-2.9" })]
		});
		function TokenPanel({ t }) {
			const open = (0, react.useSyncExternalStore)(panelStore.subscribe, panelStore.getSnapshot);
			const [view, setView] = (0, react.useState)("week");
			const [offsetWeeks, setOffsetWeeks] = (0, react.useState)(0);
			const [snapshot, setSnapshot] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [refreshedAt, setRefreshedAt] = (0, react.useState)(null);
			const abortRef = (0, react.useRef)(null);
			const load = (0, react.useCallback)(async () => {
				abortRef.current?.abort();
				const controller = new AbortController();
				abortRef.current = controller;
				setLoading(true);
				setError(null);
				try {
					const next = await fetchSnapshot({
						weeks: WEEKS,
						offsetWeeks,
						signal: controller.signal
					});
					if (controller.signal.aborted) return;
					setSnapshot(next);
					setRefreshedAt(/* @__PURE__ */ new Date());
				} catch (cause) {
					if (controller.signal.aborted) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (!controller.signal.aborted) setLoading(false);
				}
			}, [offsetWeeks]);
			(0, react.useEffect)(() => () => abortRef.current?.abort(), []);
			(0, react.useEffect)(() => {
				if (!open) return;
				load();
			}, [open, load]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape") closePanel();
				};
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const timeLabel = (0, react.useMemo)(() => {
				if (refreshedAt === null) return "";
				const pad = (n) => String(n).padStart(2, "0");
				return t("refreshedAt") + " " + pad(refreshedAt.getHours()) + ":" + pad(refreshedAt.getMinutes());
			}, [refreshedAt, t]);
			if (!open) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "td-panel",
				role: "dialog",
				"aria-label": t("title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: t("title") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-tabs",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: view === "week" ? "on" : "",
									onClick: () => setView("week"),
									children: t("weekView")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: view === "day" ? "on" : "",
									onClick: () => setView("day"),
									children: t("dayView")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "td-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								className: "td-btn",
								onClick: () => void load(),
								children: [REFRESH_ICON, t("refresh")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "td-iconbtn",
								onClick: closePanel,
								"aria-label": t("close"),
								children: "✕"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-stats",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-stat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "num",
									children: snapshot === null ? "–" : fmt(snapshot.summary.today)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "lbl",
									children: t("today")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-stat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "num",
									children: snapshot === null ? "–" : fmt(snapshot.summary.week)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "lbl",
									children: t("week")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-stat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "num",
									children: snapshot === null ? "–" : fmt(snapshot.summary.month30)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "lbl",
									children: t("month30")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-stat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "num",
									children: snapshot === null ? "–" : fmt(snapshot.summary.all)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "lbl",
									children: t("all")
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-body",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PanelErrorBoundary, {
								fallback: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "td-status",
									children: t("error", { message: "render" })
								}),
								children: [view === "week" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "td-pager",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "td-btn",
											onClick: () => setOffsetWeeks((n) => n + WEEKS),
											children: t("older")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "td-cap",
											children: offsetWeeks === 0 ? t("recentWeeks", { n: WEEKS }) : t("rangeWeeks", { n: offsetWeeks })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "td-btn",
											disabled: offsetWeeks === 0,
											onClick: () => setOffsetWeeks((n) => Math.max(0, n - WEEKS)),
											children: t("newer")
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "td-body-scroll",
									children: [
										loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "td-status",
											children: t("loading")
										}),
										!loading && error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "td-status",
											children: t("error", { message: error })
										}),
										!loading && error === null && view === "week" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Heatmap, {
											days: snapshot?.days ?? [],
											t
										}),
										!loading && error === null && view === "day" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DayView, {
											days: snapshot?.days ?? [],
											t
										})
									]
								})]
							}),
							snapshot !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SnapshotStatus, {
								snapshot,
								t
							}),
							view === "week" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "td-legend",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("legendLess") }),
									[
										"var(--td-c0)",
										"var(--td-c1)",
										"var(--td-c2)",
										"var(--td-c3)",
										"var(--td-c4)",
										"var(--td-c5)"
									].map((color) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "td-cell",
										style: { background: color }
									}, color)),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("legendMore") })
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "td-foot",
						children: [snapshot !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("sessions", { n: snapshot.summary.sessionCount }) }), timeLabel !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: timeLabel })]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const NS = "token-dashboard";
		/** Required client services: the slot registry and the locale dictionary. */
		const inject = ["slots", "locale"];
		/** Mount the sidebar entry and the heatmap panel. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-token-dashboard: dictionaries");
			ctx.effect(() => {
				injectStyles();
				return () => {
					document.getElementById("dsh-token-dashboard-styles")?.remove();
				};
			}, "dsh-token-dashboard: stylesheet");
			ctx.slots.inject("sidebar.footer.action", () => {
				let disposeEntry;
				try {
					disposeEntry = ctx.slots.register({
						name: "sidebar.footer.action",
						id: "token-dashboard",
						order: 60,
						locale: NS
					}, FooterTokenEntry);
				} catch (error) {
					console.error("dsh-token-dashboard: sidebar entry registration failed", error);
				}
				return () => {
					disposeEntry?.();
				};
			});
			ctx.slots.inject("shell.overlay", () => {
				let disposePanel;
				try {
					disposePanel = ctx.slots.register({
						name: "shell.overlay",
						id: "token-dashboard",
						locale: NS
					}, TokenPanel);
				} catch (error) {
					console.error("dsh-token-dashboard: panel registration failed", error);
				}
				return () => {
					disposePanel?.();
				};
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map