// dsh-settings-groups — 设置面板导航「分组」客户端插件
//
// 目标（对齐主人提的三条）：
//   1) 自由配置排序：分组的先后、组内条目、未分组条目，全部可拖拽排序并持久化；
//   2) 分组 / 未分组：任意条目可在两者之间自由派发（导航里直接拖，管理页里也能改）；
//   3) 分组标签（chip）做小 + 展开/收起带下拉与缩放过渡动画。
//
// 实现路径：设置导航不是 Slot，宿主用内部排序自己渲染。所以本插件
//   ① 读 `settings.section` 台账拿到所有插件设置页；
//   ② 把「分组标签」按钮注入导航列表、按自定义顺序重排原生按钮（移动而非复制）；
//   ③ 用 data-* 属性 + 一小段样式表控制显隐与过渡；
//   ④ 导航里的拖拽 = 直接改配置；管理页提供同一份配置的可视化编辑。
// 所有注入节点与监听器挂在插件 fiber 上，停用即完全还原。
window.__ModuleLoader__.load({
	id: "dsh-settings-groups",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		const NS = "settings-groups";
		/** localStorage 键：分组配置 + 各项开关（重启不丢）。 */
		const STORAGE_KEY = "dsh.settingsGroups.v1";
		/** 宿主设置面板的导航列表容器。 */
		const NAV_SEL = '[role="dialog"][aria-modal="true"] > nav > div:last-child';
		/** 本插件自己的设置页 id。 */
		const MANAGE_ID = "settings-groups-manage";
		/**
		 * 宿主官方入口：固定平铺在最上面，不参与分组、不参与排序。
		 * 拖这些入口没有语义（它们不是插件贡献），也避免把「账号与余额」藏进分组。
		 */
		const CORE_IDS = new Set(["general", "models", "plugins", "agent-presets", "account", MANAGE_ID]);
		/** 需要注入的客户端服务。 */
		const inject = ["slots", "locale"];
		/** 过渡时长（与 CSS 的 .26s 对齐）。 */
		const ANIM_MS = 260;
		/** 拖拽载荷 MIME（自用，不依赖 text/plain）。 */
		const DND_MIME = "application/x-dsh-settings-groups";

		// 单实例守卫：重复 apply 会让两套观察器互相打架并形成 DOM 风暴。
		let ACTIVE = false;

		const h = React.createElement;

		function apply(ctx) {
			if (ACTIVE) {
				console.warn("[settings-groups] already active — ignoring duplicate apply");
				return;
			}
			ACTIVE = true;
			ctx.effect(() => () => {
				ACTIVE = false;
			}, "settings-groups: single-instance guard");
			console.log("[dsh-settings-groups] loaded");

			// ---------------------------------------------------------------- 文案
			ctx.effect(() => ctx.locale.register(NS, "zh", {
				label: "分组管理",
				ungrouped: "未分组",
				expand: "展开",
				collapse: "收起",
				dragHint: "拖动可排序 / 拖进分组",
				pageTitle: "分组管理",
				enabled: "启用分组",
				enabledDesc: "关闭后设置导航完全恢复宿主原生平铺，配置仍然保留。",
				newGroup: "新建分组",
				newGroupPlaceholder: "分组名称，例如「界面增强」",
				create: "新建",
				groupsHead: "分组",
				looseHead: "未分组",
				emptyGroups: "还没有分组。先在下面输入名称新建一个，再把条目拖进去。",
				emptyLoose: "所有插件设置入口都已经归组。",
				groupEmpty: "这个分组还是空的 —— 把下面的条目拖进来。",
				created: "已新建分组",
				emptyAll: "当前没有可管理的插件设置入口（已安装的插件可能都没有设置页）。",
				rename: "重命名",
				remove: "移出",
				removeGroup: "删除分组",
				removeGroupHint: "删除分组后，组内条目回到「未分组」，条目本身不受影响。",
				up: "上移",
				down: "下移",
				save: "保存",
				cancel: "取消",
				toGroup: "加入分组",
				reset: "重置全部配置",
				resetConfirm: "确认清空所有分组与排序，恢复默认？",
				resetDone: "已重置。",
				dragRowHint: "拖动这一行到某个分组可以归组；在组内拖动可以排序。",
				coreHint: "「{name}」等宿主官方入口固定在最上面，不参与分组。",
				panelHint: "设置面板本身也一并接管了：右缘分隔条拖宽度、拖标题栏移动面板、四边四角缩放，双击任一处复位 —— 不用再装 dsh-settings-panel-tweak 补丁。",
				legacyWarn: "检测到旧插件 dsh-settings-nav-organizer 仍在运行。两者都会改写设置导航，本插件已自动退让 —— 请先在「插件管理」里禁用它。",
				noEntries: "等待设置面板打开…",
				itemsCount: "{n} 项",
				movedTo: "已归入「{name}」",
				movedOut: "已移出分组",
				hide: "隐藏这一项",
				hideHint: "隐藏后导航里不再出现，配置还在，「已隐藏」里随时能放出来。",
				hiddenHead: "已隐藏",
				hiddenEmpty: "没有隐藏的设置项。",
				hiddenDropHint: "把条目拖到这里 = 隐藏",
				uninstalled: "已卸载",
				forget: "清除记录",
				forgetHint: "插件已经卸载了，留着这条隐藏记录没意义；清掉它，重装后就不会再自动隐藏。",
				forgotten: "已清除记录",
				forgetAll: "清理已卸载",
				forgottenAll: "已清理 {n} 条",
				unhide: "取消隐藏",
				hiddenDone: "已隐藏（导航里不再出现）",
				unhidden: "已取消隐藏",
				search: "搜索设置项",
				searchPlaceholder: "搜索设置项…",
				searchClear: "清空搜索",
				searchEmpty: "没有匹配的设置项（隐藏的项不参与搜索）",
				reload: "从磁盘重载",
				reloadHint: "配置文件被外部改过（比如让 AI 直接编辑 json）时，点这里立刻读回来。面板开着的话其实 5 秒内会自动同步。",
			}), "settings-groups: zh dictionary");

			ctx.effect(() => ctx.locale.register(NS, "en", {
				label: "Groups",
				ungrouped: "Ungrouped",
				expand: "Expand",
				collapse: "Collapse",
				dragHint: "Drag to reorder / drop into a group",
				pageTitle: "Settings groups",
				enabled: "Enable groups",
				enabledDesc: "When off, the settings nav returns to the host's flat list; your configuration is kept.",
				newGroup: "New group",
				newGroupPlaceholder: "Group name, e.g. “UI enhancements”",
				create: "Create",
				groupsHead: "Groups",
				looseHead: "Ungrouped",
				emptyGroups: "No groups yet. Create one below, then drag entries into it.",
				emptyLoose: "Every plugin settings entry is already grouped.",
				groupEmpty: "This group is empty — drag entries here from below.",
				created: "Group created",
				emptyAll: "No plugin settings entries to organize (installed plugins may not expose a settings page).",
				rename: "Rename",
				remove: "Remove",
				removeGroup: "Delete group",
				removeGroupHint: "Deleting a group returns its entries to “Ungrouped”; entries themselves are untouched.",
				up: "Move up",
				down: "Move down",
				save: "Save",
				cancel: "Cancel",
				toGroup: "Move to group",
				reset: "Reset all",
				resetConfirm: "Clear all groups and ordering and restore defaults?",
				resetDone: "Reset.",
				dragRowHint: "Drag a row onto a group to file it; drag inside a group to reorder.",
				coreHint: "Host entries such as “{name}” stay pinned at the top and never join a group.",
				panelHint: "The settings panel itself is covered too: drag its right edge for width, its header to move it, or any edge/corner to resize. Double-click to reset — no dsh-settings-panel-tweak patch needed.",
				legacyWarn: "The legacy plugin dsh-settings-nav-organizer is still running. Both rewrite the settings nav, so this plugin backed off — disable it in Plugins first.",
				noEntries: "Waiting for the settings panel…",
				itemsCount: "{n} items",
				movedTo: "Filed under “{name}”",
				movedOut: "Removed from group",
				hide: "Hide this entry",
				hideHint: "Hidden entries disappear from the nav but keep their config; bring them back from “Hidden”.",
				hiddenHead: "Hidden",
				hiddenEmpty: "Nothing is hidden.",
				hiddenDropHint: "Drop an entry here to hide it",
				uninstalled: "not installed",
				forget: "Forget",
				forgetHint: "The plugin is gone, so this hidden record is dead weight. Clearing it means no auto-hide if you reinstall.",
				forgotten: "Record cleared",
				forgetAll: "Clean up",
				forgottenAll: "Cleared {n}",
				unhide: "Unhide",
				hiddenDone: "Hidden (no longer in the nav)",
				unhidden: "Unhidden",
				search: "Search settings",
				searchPlaceholder: "Search settings…",
				searchClear: "Clear search",
				searchEmpty: "No matching settings (hidden entries excluded)",
				reload: "Reload from disk",
				reloadHint: "Pull the config file back in after editing it outside DSH. With the panel open it syncs automatically within 5s.",
			}), "settings-groups: en dictionary");
			const t = ctx.locale.bind(NS);

			// ---------------------------------------------------------------- 状态
			/**
			 * groups: [{ id, name, entries: [entryId...], open: boolean }] —— 数组顺序即显示顺序；
			 * loose:  [entryId...] —— 未分组条目的显式顺序（新出现的条目自动追加在末尾）；
			 * hidden: [entryId...] —— 被藏起来的条目，导航里完全不出现；
			 * enabled / folded：总开关、未分组折叠态；
			 * updatedAt：写这份配置的时间戳，用来跟磁盘那份比新旧。
			 *
			 * 一个条目同时只能处在一种状态：某个分组 / 未分组 / 隐藏（三态互斥）。
			 * 收起哪一组、未分组收没收，下次开 DSH 要原样还原，不能一律展开。
			 *
			 * folded 默认 false：装这个插件就是为了把条目拖来拖去，一进来就全收起来
			 * 等于把可拖的东西藏了。想省地方再自己点那一行收起。
			 */
			const defaults = () => ({ v: 1, updatedAt: 0, migratedV1: false, enabled: true, folded: false, groups: [], loose: [], hidden: [], coreExtra: [] });

			const sanitize = (raw) => {
				const next = defaults();
				if (raw === null || typeof raw !== "object") return next;
				if (Number.isFinite(raw.updatedAt)) next.updatedAt = Number(raw.updatedAt);
				if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
				if (typeof raw.folded === "boolean") next.folded = raw.folded;
				if (Array.isArray(raw.coreExtra)) next.coreExtra = raw.coreExtra.filter((x) => typeof x === "string");
				if (raw.migratedV1 === true) next.migratedV1 = true;
				if (Array.isArray(raw.hidden)) next.hidden = raw.hidden.filter((x) => typeof x === "string");
				if (Array.isArray(raw.loose)) next.loose = raw.loose.filter((x) => typeof x === "string");
				if (Array.isArray(raw.groups)) {
					const seen = new Set();
					for (const g of raw.groups) {
						if (g === null || typeof g !== "object") continue;
						if (typeof g.id !== "string" || typeof g.name !== "string") continue;
						if (seen.has(g.id)) continue;
						seen.add(g.id);
						next.groups.push({
							id: g.id,
							name: g.name,
							entries: Array.isArray(g.entries) ? g.entries.filter((x) => typeof x === "string") : [],
							open: g.open !== false,
						});
					}
				}
				return next;
			};

			const readStore = () => {
				try {
					const raw = localStorage.getItem(STORAGE_KEY);
					return sanitize(raw === null ? null : JSON.parse(raw));
				} catch (_ignored) {
					return defaults();
				}
			};

			/** 旧插件 dsh-settings-nav-organizer 的配置键（同源、格式相近）。 */
			const LEGACY_KEY = "dsh.settingsNavFold.v1";
			/**
			 * 一次性把旧插件的分组搬过来，省得重新配一遍。
			 *
			 * 只在「新配置里一个分组都没有」且「没有迁移过」时执行，所以：
			 * 手滑删光了分组不会被旧数据复活；迁移过的也不会反复覆盖。
			 * 旧插件只存了分组归属，没存未分组顺序和展开态，这两项用默认值。
			 */
			let migratedNow = false;
			const migrateLegacy = (next) => {
				if (next.migratedV1 === true) return next;
				if (next.groups.length > 0) return next;
				let legacy = null;
				try {
					const raw = localStorage.getItem(LEGACY_KEY);
					if (raw === null) return next;
					legacy = JSON.parse(raw);
				} catch (_ignored) {
					return next;
				}
				if (legacy === null || !Array.isArray(legacy.groups) || legacy.groups.length === 0) return next;
				const groups = [];
				for (const g of legacy.groups) {
					if (g === null || typeof g !== "object") continue;
					if (typeof g.name !== "string" || !Array.isArray(g.entries)) continue;
					groups.push({
						id: `g${groups.length + 1}`,
						name: g.name,
						entries: g.entries.filter((x) => typeof x === "string"),
						open: true,
					});
				}
				if (groups.length === 0) return next;
				next.groups = groups;
				// 旧插件的「插件入口」那一行默认是折叠的，搬过来保持一致
				next.folded = true;
				next.migratedV1 = true;
				next.updatedAt = Date.now();
				migratedNow = true;
				return next;
			};

			/**
			 * 运行状态。
			 *
			 * 两处存：localStorage（同步、立即可读）+ 宿主端文件（`~/.dsh/dsh-settings-groups.json`）。
			 * 只有 localStorage 的话，换个 origin / 清一次缓存配置就没了；而主人要的是
			 * 「关了 DSH 再开，收起的分组还是收起的」，所以磁盘那份是硬保障。
			 * 两边都带 `updatedAt`，谁新听谁的 —— 文件是旧的就把它覆盖掉，不会拿旧数据倒灌。
			 */
			let state = migrateLegacy(readStore());
			/**
			 * 去重 + 保证三态互斥：一个条目只能落在「某个分组 / 未分组 / 已隐藏」之一。
			 * hidden 先占位，所以配置文件被手工改出「既在组里又藏起来」时，以隐藏为准。
			 */
			const dedupe = () => {
				const seen = new Set(state.hidden);
				for (const g of state.groups) {
					g.entries = g.entries.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
				}
				state.loose = state.loose.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
			};
			dedupe();

			let nextGroupId = 1;
			const recalcNextGroupId = () => {
				nextGroupId = 1;
				for (const g of state.groups) {
					const n = Number(String(g.id).replace(/^g/, ""));
					if (Number.isFinite(n)) nextGroupId = Math.max(nextGroupId, n + 1);
				}
			};
			recalcNextGroupId();

			const API_BASE = "/api/dsh-settings-groups";

			/**
			 * 落盘用的快照。
			 *
			 * 比 state 多两块**纯注释**字段（读回来会被 sanitize 丢掉，不参与逻辑）：
			 * `_labels` 把 entryId 翻成看得懂的名字，`_readme` 说明怎么改。
			 * 这样主人（或 AI）直接编辑 json 时不用猜 `dsh-read-aloud` 是哪个插件。
			 */
			const snapshotForDisk = () => {
				const labels = {};
				for (const r of rows) {
					if (isCore(r.id)) continue;
					labels[r.id] = r.label;
				}
				return {
					_readme: "直接改这个文件也行：groups[].entries / loose / hidden 里填 _labels 的键。存盘后设置面板开着的话 5 秒内自动生效；手改不用管 updatedAt。",
					...state,
					_labels: labels,
				};
			};

			/** 上次推给磁盘的原文，用来认出「轮询读到的就是我刚写的」。 */
			let lastPushed = "";
			let pendingPush = false;

			/** 推到宿主端落盘。节流 250ms，失败就当没这回事（localStorage 仍在）。 */
			let pushTimer = null;
			const pushToHost = () => {
				if (pushTimer !== null) clearTimeout(pushTimer);
				pushTimer = setTimeout(() => {
					pushTimer = null;
					const body = JSON.stringify(snapshotForDisk());
					lastPushed = body;
					pendingPush = true;
					try {
						fetch(`${API_BASE}/config`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body,
						})
							.catch(() => undefined)
							.finally(() => {
								pendingPush = false;
							});
					} catch (_ignored) {
						pendingPush = false;
					}
				}, 250);
			};

			const applyRemote = (remote) => {
				state = remote;
				dedupe();
				recalcNextGroupId();
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
				} catch (_ignored) {
					/* 写不进去也能用，下次还得从磁盘读 */
				}
				refreshRows();
				sync(true);
				notifyPage();
			};

			/**
			 * 从磁盘拉一次。轮询用它发现「文件被外部改了」（比如主人让 AI 直接编辑 json）。
			 * 判断依据是**内容**而不是 updatedAt —— 手写的配置通常不会带这个字段。
			 */
			const pullFromHost = async (force = false) => {
				if (pendingPush && !force) return;
				let raw = null;
				try {
					const res = await fetch(`${API_BASE}/config`, { cache: "no-store" });
					if (!res.ok) return;
					const data = await res.json();
					raw = data?.config ?? null;
				} catch (_ignored) {
					return;
				}
				if (raw === null) return;
				if (JSON.stringify(raw) === lastPushed) return; // 就是自己刚写的那份
				const remote = sanitize(raw);
				if (JSON.stringify(remote) === JSON.stringify(sanitize(state))) return;
				applyRemote(remote);
			};

			const save = () => {
				state.updatedAt = Date.now();
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
				} catch (error) {
					console.warn("[settings-groups] localStorage write failed:", error);
				}
				pushToHost();
			};

			/**
			 * 启动时和磁盘对一次账。磁盘更新（比如清过缓存、换了 origin）就用磁盘的，
			 * 否则把本地这份推上去当权威。
			 */
			const hydrateFromHost = async () => {
				let remote = null;
				try {
					const res = await fetch(`${API_BASE}/config`, { cache: "no-store" });
					if (!res.ok) return;
					const data = await res.json();
					remote = sanitize(data?.config ?? null);
				} catch (_ignored) {
					return; // 宿主端还没加载这条路由：纯 localStorage 模式，照常工作
				}
				if (remote === null) return;
				if (remote.updatedAt > state.updatedAt) {
					applyRemote(remote);
					return;
				}
				if (state.updatedAt > remote.updatedAt) pushToHost();
			};

			// ---------------------------------------------------------------- 台账
			/** 当前设置台账：[{ id, order, label }]，按宿主 order 升序。 */
			let rows = [];
			const resolveLabel = (label) => (typeof label === "function" ? label() : (label ?? ""));
			const rowIds = () => new Set(rows.map((r) => r.id));
			const labelOf = (id) => rows.find((r) => r.id === id)?.label ?? id;

			const refreshRows = () => {
				let entries = [];
				try {
					entries = ctx.slots.entries("settings.section") ?? [];
				} catch (_ignored) {
					entries = [];
				}
				rows = entries
					.map((e) => ({
						id: e?.options?.id ?? "",
						order: e?.options?.order ?? 0,
						label: resolveLabel(e?.options?.label),
					}))
					.filter((r) => r.id !== "")
					.sort((a, b) => a.order - b.order);
			};

			/** 条目的归属分组（找不到 = 未分组）。 */
			const groupOf = (id) => {
				for (const g of state.groups) if (g.entries.includes(id)) return g;
				return undefined;
			};
			const groupById = (gid) => state.groups.find((g) => g.id === gid);

			/** 组内条目：只保留当前台账里真实存在的，顺序即配置顺序。 */
			const entriesOf = (g) => {
				const alive = rowIds();
				const hidden = new Set(state.hidden);
				return g.entries.filter((id) => alive.has(id) && !hidden.has(id));
			};

			/**
			 * 未分组条目：先按 loose 里的显式顺序，再把新出现（配置里没有）的
			 * 条目按台账顺序追加到末尾 —— 新装插件永远落在「未分组」里，不会丢。
			 */
			const looseIds = () => {
				const alive = rowIds();
				const inGroup = new Set();
				for (const g of state.groups) for (const id of g.entries) inGroup.add(id);
				const hidden = new Set(state.hidden);
				const out = [];
				for (const id of state.loose) {
					if (alive.has(id) && !inGroup.has(id) && !hidden.has(id) && !isCore(id)) out.push(id);
				}
				const known = new Set(out);
				for (const r of rows) {
					if (isCore(r.id) || inGroup.has(r.id) || known.has(r.id) || hidden.has(r.id)) continue;
					out.push(r.id);
				}
				return out;
			};

			/** 从所有分组、未分组、隐藏列表里摘掉某条目（三态互斥，换态先摘干净）。 */
			const detach = (id) => {
				for (const g of state.groups) g.entries = g.entries.filter((x) => x !== id);
				state.loose = state.loose.filter((x) => x !== id);
				state.hidden = state.hidden.filter((x) => x !== id);
			};

			/** 藏起来：导航里不再出现，但配置还在（管理页能一键放出来）。 */
			const hideEntry = (id) => {
				// 藏的是当前正在看的那一页时，先跳回「通用设置」——
				// 否则内容区停在一个导航上已经不存在的页，用户会以为设置面板坏了。
				const btn = refs.get(id);
				const current = btn === undefined ? null : btn.getAttribute("aria-current");
				if (current === "true" || current === "page") {
					const fallback = refs.get("general");
					if (fallback !== undefined) fallback.click();
				}
				detach(id);
				state.hidden.push(id);
			};

			const unhideEntry = (id) => {
				state.hidden = state.hidden.filter((x) => x !== id);
				if (!state.loose.includes(id)) state.loose.push(id);
			};

			/**
			 * 忘掉一条隐藏记录 —— 用于已经卸载的插件。
			 * 不能拿 unhideEntry 代替：它会把 id 塞回 loose，而 looseIds() 会按台账过滤，
			 * 于是"取消隐藏"对不存在的条目毫无效果，用户只会觉得按钮坏了。
			 */
			const forgetHidden = (id) => {
				state.hidden = state.hidden.filter((x) => x !== id);
			};

			/**
			 * 把条目插到目标位置。
			 *
			 * 做法：先取目标容器「当前可见顺序」，把 id 插进去，再整体写回配置。
			 * 直接写回（而不是在原数组上 splice）能顺手清掉已失效的 id；
			 * 但当前插件被临时禁用（设置页从台账消失）时那条记录要保留在末尾，
			 * 否则重装插件后分组记忆会丢 —— 所以把残留 id 接在后面。
			 *
			 * @param {string} id 条目 id
			 * @param {{gid?: string, before?: string, after?: string}} where
			 *   gid 省略 = 未分组；before / after 指定插入锚点。
			 */
			const place = (id, where) => {
				const g = where.gid === undefined ? undefined : groupById(where.gid);
				const raw = g === undefined ? [...state.loose] : [...g.entries];
				detach(id);
				// 过滤掉 id：detach 之后 looseIds() 会把「既不在组里也不在 loose 里」
				// 的条目当成新装插件自动补齐，正好把刚摘下来的这一条又补回来，
				// 再 splice 一次就重复了（React 那边会报 duplicate key）。
				const visible = (g === undefined ? looseIds() : entriesOf(g)).filter((x) => x !== id);
				const anchorId = where.before ?? where.after;
				let index = visible.length;
				if (anchorId !== undefined) {
					const at = visible.indexOf(anchorId);
					if (at >= 0) index = where.after !== undefined ? at + 1 : at;
				}
				visible.splice(Math.max(0, Math.min(index, visible.length)), 0, id);
				// 保留不在当前台账里的历史条目（临时禁用的插件）
				const alive = rowIds();
				const kept = raw.filter((x) => x !== id && !alive.has(x) && !visible.includes(x));
				const next = [...visible, ...kept];
				if (g === undefined) {
					state.loose = next;
					state.folded = false;
				} else {
					g.entries = next;
					g.open = true;
				}
			};

			// ---------------------------------------------------------------- 样式
			const styleTag = document.createElement("style");
			styleTag.dataset.dsgStyle = "1";
			const CSS = [
				// —— 搜索框：跟 chip 一样高，不占地方 ——
				".dsg-search{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;width:100%;margin:2px 0 5px}",
				".dsg-search-row{display:flex;align-items:center;gap:4px;box-sizing:border-box;height:26px;padding:0 7px;border-radius:7px;background:rgba(127,127,127,.09)}",
				".dsg-search-empty{padding:0 7px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#999)}",
				".dsg-search-input{flex:1;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:12px;line-height:26px;outline:none;padding:0}",
				".dsg-search-input::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}",
				".dsg-search-clear{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#999);font-family:inherit;font-size:11px;line-height:1;padding:0 2px;cursor:pointer;opacity:0;transition:opacity .15s ease}",
				".dsg-search[data-filled=\"1\"] .dsg-search-clear{opacity:.7}",
				".dsg-search[data-filled=\"1\"] .dsg-search-clear:hover{opacity:1}",
				// 搜索中：只留命中项。用 !important 压过行内的 display:none，
				// 所以收起的分组里命中的条目也会露出来，收完不用再手动展开。
				`[data-dsg-search=\"1\"] > button:not(.dsg-chip):not([data-dsg-hit=\"1\"]){display:none !important}`,
				`[data-dsg-search=\"1\"] > .dsg-chip:not([data-dsg-hit=\"1\"]){display:none !important}`,
				// —— 分组标签（chip）：比官方 item（40px）明显小一圈 ——
				".dsg-chip{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;height:26px;margin:4px 0 1px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);font-family:inherit;font-size:12px;line-height:26px;text-align:left;cursor:pointer;user-select:none;transition:background .15s ease,color .15s ease,transform .12s ease}",
				".dsg-chip:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#333)}",
				".dsg-chip:active{transform:scale(.97)}",
				".dsg-chip[aria-current=\"true\"]{color:var(--dsw-alias-label-primary,#333)}",
				// 小三角：细线 chevron（`>` 形状），展开时转成 `v`。
				// 用两条边框拼 L 形再转 -45°，比实心三角轻，跟宿主自己的展开箭头同一种观感。
				".dsg-caret{flex:none;display:inline-flex;align-items:center;justify-content:center;width:11px;height:11px;opacity:.7;transform-origin:50% 50%;transition:transform .34s cubic-bezier(.34,1.7,.5,1),opacity .22s ease}",
				".dsg-caret::before{content:\"\";display:block;width:4.5px;height:4.5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;border-radius:.5px;transform:rotate(-45deg);margin:0 0 0 -1px}",
				".dsg-chip:hover .dsg-caret{opacity:.95}",
				".dsg-chip[aria-expanded=\"true\"] .dsg-caret{transform:rotate(90deg) scale(1.15);opacity:1}",
				".dsg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;letter-spacing:.01em}",
				".dsg-count{flex:none;height:15px;line-height:15px;padding:0 5px;border-radius:999px;background:rgba(127,127,127,.14);color:inherit;font-size:10px;opacity:.85}",
				".dsg-grip{flex:none;font-size:10px;opacity:0;cursor:grab;transition:opacity .15s ease}",
				".dsg-chip:hover .dsg-grip{opacity:.55}",
				// —— 拖拽反馈 ——
				".dsg-chip[data-dsg-drop=\"into\"]{background:color-mix(in srgb, var(--dsg-accent,#4a7cf5) 15%, transparent);color:var(--dsg-accent,#4a7cf5);outline:1px solid color-mix(in srgb, var(--dsg-accent,#4a7cf5) 55%, transparent);outline-offset:-1px}",
				"[data-dsg-drop=\"before\"]{box-shadow:inset 0 2px 0 0 var(--dsg-accent,#4a7cf5)}",
				"[data-dsg-drop=\"after\"]{box-shadow:inset 0 -2px 0 0 var(--dsg-accent,#4a7cf5)}",
				"[data-dsg-dragging=\"1\"]{opacity:.4}",
				// —— 条目展开 / 收起：下拉 + 缩放 + 模糊 ——
				// height / padding / margin 也一起过渡，否则条目淡出后下面的内容
				// 会「啪」地往上跳一格（这才是收起动画最容易露馅的地方）。
				// 顺带把宿主原本的 hover 底色过渡带上，免得覆盖掉它自己那套手感。
				"[data-dsg-item]{transform-origin:center top;transition:background-color .15s ease,color .15s ease,opacity .2s ease,transform .26s cubic-bezier(.4,0,.2,1),filter .2s ease,height .26s cubic-bezier(.4,0,.2,1),padding-top .26s cubic-bezier(.4,0,.2,1),padding-bottom .26s cubic-bezier(.4,0,.2,1),margin-top .26s cubic-bezier(.4,0,.2,1),margin-bottom .26s cubic-bezier(.4,0,.2,1)}",
				// 只在动画那一下提层，平时不占合成层
				"[data-dsg-item][data-dsg-anim]{will-change:opacity,transform,filter,height}",
				// ⚠️ 入场必须用 animation，不能用 transition。
				// 条目收起后是 display:none，恢复显示的那一帧对浏览器来说是「元素刚出生」，
				// 没有前值可插值 ⇒ transition 直接不跑，展开就成了瞬间出现（收起反而正常，
				// 因为那时元素一直是可见的）。animation 不受这个限制。
				// 目标高度通过 --dsg-h 传进来，因为 keyframes 里写不了 auto。
				// 入场和退场都用 keyframes：四条属性写在同一条动画里，天然同步。
				// 之前退场用 transition，opacity 立刻起步、height 要等双 rAF（~32ms）才动，
				// 两段错开看着就是「卡一下」。
				"@keyframes dsgItemIn{from{height:0;opacity:0;filter:blur(4px);transform:scale(.86) translateY(-6px)}to{height:var(--dsg-h,40px);opacity:1;filter:blur(0);transform:none}}",
				"@keyframes dsgItemOut{from{height:var(--dsg-h,40px);opacity:1;filter:blur(0);transform:none}to{height:0;opacity:0;filter:blur(4px);transform:scale(.86) translateY(-6px)}}",
				"[data-dsg-item][data-dsg-anim=\"in\"]{animation:dsgItemIn .26s var(--dsg-ease,cubic-bezier(.2,.7,.3,1)) both;overflow:hidden;box-sizing:border-box}",
				"[data-dsg-item][data-dsg-anim=\"out\"]{animation:dsgItemOut .26s var(--dsg-ease,cubic-bezier(.2,.7,.3,1)) both;overflow:hidden;box-sizing:border-box}",
				// —— 管理页 ——
				".dsg-page{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;width:100%;max-width:560px;min-width:0;font-size:13px}",
				".dsg-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}",
				".dsg-card[data-over=\"1\"]{border-color:var(--dsg-accent,#4a7cf5);background:color-mix(in srgb, var(--dsg-accent,#4a7cf5) 7%, transparent)}",
				".dsg-cardhead{display:flex;align-items:center;gap:8px;min-width:0}",
				".dsg-cardname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-cardcount{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#999)}",
				".dsg-btn{flex:none;height:24px;padding:0 8px;border:none;border-radius:6px;background:var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:12px;cursor:pointer;transition:filter .12s ease,transform .1s ease}",
				".dsg-btn:hover{filter:brightness(1.08)}",
				".dsg-btn:active{transform:scale(.97)}",
				".dsg-btn[disabled]{opacity:.4;cursor:default}",
				".dsg-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,#999)}",
				".dsg-btn-ghost:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#333)}",
				".dsg-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}",
				".dsg-rows{display:flex;flex-direction:column;gap:2px}",
				".dsg-row{display:flex;align-items:center;gap:6px;min-height:28px;padding:2px 6px;border-radius:7px;color:var(--dsw-alias-label-primary,#333);transition:background .12s ease,opacity .12s ease}",
				".dsg-row:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.1))}",
				".dsg-row[data-dragging=\"1\"]{opacity:.35}",
				".dsg-row[data-over=\"before\"]{box-shadow:inset 0 2px 0 0 var(--dsg-accent,#4a7cf5)}",
				".dsg-row[data-over=\"after\"]{box-shadow:inset 0 -2px 0 0 var(--dsg-accent,#4a7cf5)}",
				".dsg-row[data-stale=\"1\"]{opacity:.55}",
				".dsg-row[data-stale=\"1\"] .dsg-rowname{text-decoration:line-through}",
				".dsg-rowgrip{flex:none;width:13px;color:var(--dsw-alias-label-tertiary,#aaa);cursor:grab;font-size:11px;text-align:center}",
				".dsg-rowname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}",
				".dsg-input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:12.5px}",
				".dsg-input:focus{outline:none;border-color:var(--dsg-accent,#4a7cf5)}",
				".dsg-new{display:flex;gap:8px;align-items:center}",
				".dsg-select{box-sizing:border-box;height:24px;max-width:130px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:11.5px}",
				".dsg-hint{margin:0;color:var(--dsw-alias-label-secondary,#999);font-size:11.5px;line-height:18px}",
				".dsg-warn{margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f5a524) 12%, transparent);color:var(--dsw-alias-state-warn-primary,#b8770b);font-size:12px;line-height:18px}",
				".dsg-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}",
				".dsg-toggletext{display:flex;flex-direction:column;gap:2px;min-width:0}",
				".dsg-toggletitle{font-size:13px;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-switch{flex:none;position:relative;width:34px;height:20px;border-radius:999px;border:none;background:var(--dsw-alias-label-tertiary,#bbb);cursor:pointer;padding:0;transition:background .18s ease}",
				".dsg-switch[data-on=\"1\"]{background:var(--dsw-alias-state-success-primary,#46a758)}",
				".dsg-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s cubic-bezier(.22,.8,.28,1)}",
				".dsg-switch[data-on=\"1\"] .dsg-knob{transform:translateX(14px)}",
				".dsg-section{display:flex;flex-direction:column;gap:6px}",
				".dsg-sectionhead{display:flex;align-items:baseline;gap:8px}",
				".dsg-sectiontitle{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#888);text-transform:uppercase}",
				".dsg-empty{margin:0;color:var(--dsw-alias-label-secondary,#999);font-size:12px;line-height:18px}",
				".dsg-foot{display:flex;justify-content:flex-end}",
			].join("\n");
			ctx.effect(() => {
				styleTag.textContent = CSS;
				document.head.appendChild(styleTag);
				return () => styleTag.remove();
			}, "settings-groups: stylesheet");

			// ---------------------------------------------------------------- 导航层
			let navList = null;
			/** entryId → 宿主原生按钮 */
			const refs = new Map();
			/** gid → 分组 chip */
			const chips = new Map();
			let looseChip = null;
			/** 期望可见性缓存：只在真正翻转时才播动画 */
			const shownState = new WeakMap();
			/** 管理页订阅者 */
			const pageListeners = new Set();

			const findNavList = () => {
				const el = document.querySelector(NAV_SEL);
				if (el === navList) return navList;
				// 宿主重建了列表：旧引用表作废
				navList = el;
				refs.clear();
				chips.clear();
				looseChip = null;
				// 面板关掉再打开 = 全新一棵树，搜索框和搜索词一起丢掉
				searchBox = null;
				searchQuery = "";
				return navList;
			};

			const notifyPage = () => {
				for (const fn of [...pageListeners]) fn();
			};

			/** 旧插件（dsh-settings-nav-organizer）是否在跑：它必插一条带标记的样式表。 */
			const legacyRunning = () => document.head.querySelector('style[data-settings-nav-fold="1"]') !== null;

			const isInjected = (el) => el.classList?.contains("dsg-chip") === true;

			/**
			 * 这个设置页算不算「宿主官方的固定入口」。
			 *
			 * 一开始想按 order 判断（order 小 = 内置），实测不行：本机就有第三方插件
			 * 用了 order 12 / 15 / 25 / 26 —— 按阈值判断会把它们误锁成不可分组，
			 * 那比"新内置页混进未分组"难受得多。所以还是白名单。
			 *
			 * 为了不用改代码就能跟上宿主版本，白名单可以在配置文件里追加：
			 * 把新内置页的 id 加进 `coreExtra` 数组即可（管理页看不到它，但配置能改）。
			 */
			const isCore = (id) => CORE_IDS.has(id) || state.coreExtra.includes(id);

			// ---- 搜索 ----
			let searchBox = null;
			let searchQuery = "";

			const makeSearchBox = () => {
				const wrap = document.createElement("div");
				wrap.className = "dsg-search";
				wrap.dataset.dsgSearchBox = "1";
				const row = document.createElement("div");
				row.className = "dsg-search-row";
				const input = document.createElement("input");
				input.type = "text";
				input.className = "dsg-search-input";
				input.placeholder = t("searchPlaceholder");
				input.setAttribute("aria-label", t("search"));
				const clear = document.createElement("button");
				clear.type = "button";
				clear.className = "dsg-search-clear";
				clear.textContent = "✕";
				clear.title = t("searchClear");
				const reset = () => {
					input.value = "";
					searchQuery = "";
					wrap.dataset.filled = "0";
					applySearch();
				};
				input.addEventListener("input", () => {
					searchQuery = input.value;
					wrap.dataset.filled = input.value === "" ? "0" : "1";
					applySearch();
				});
				input.addEventListener("keydown", (e) => {
					if (e.key === "Escape") {
						reset();
						input.blur();
					}
				});
				clear.addEventListener("click", () => {
					reset();
					input.focus();
				});
				const empty = document.createElement("div");
				empty.className = "dsg-search-empty";
				empty.textContent = t("searchEmpty");
				empty.style.display = "none";
				row.append(input, clear);
				wrap.append(row, empty);
				return wrap;
			};

			const ensureSearchBox = () => {
				if (searchBox === null) searchBox = makeSearchBox();
				return searchBox;
			};

			/**
			 * 搜索过滤：命中的打 `data-dsg-hit`，靠样式表把没命中的压掉。
			 * 用属性而不是直接改 display —— 搜索一结束清掉标记，分组折叠状态原样回来。
			 * 隐藏项不参与搜索（搜到了也没处点，反而更困惑）。
			 */
			const applySearch = () => {
				const nav = findNavList();
				if (nav === null) return;
				for (const el of nav.querySelectorAll("[data-dsg-hit]")) delete el.dataset.dsgHit;
				const q = searchQuery.trim().toLowerCase();
				const emptyHint = searchBox === null ? null : searchBox.querySelector(".dsg-search-empty");
				if (q === "") {
					delete nav.dataset.dsgSearch;
					if (emptyHint !== null) emptyHint.style.display = "none";
					return;
				}
				nav.dataset.dsgSearch = "1";
				const hidden = new Set(state.hidden);
				const hit = (id) => {
					if (hidden.has(id)) return false;
					return id.toLowerCase().includes(q) || (labelOf(id) ?? "").toLowerCase().includes(q);
				};
				for (const [id, btn] of refs) {
					if (hit(id)) btn.dataset.dsgHit = "1";
				}
				for (const g of state.groups) {
					const chip = chips.get(g.id);
					if (chip !== undefined && g.entries.some(hit)) chip.dataset.dsgHit = "1";
				}
				if (looseChip !== null && looseIds().some(hit)) looseChip.dataset.dsgHit = "1";
				if (emptyHint !== null) {
					emptyHint.style.display = nav.querySelector("[data-dsg-hit]") === null ? "" : "none";
				}
			};

			// ---- chip 构建 ----
			const makeChip = (kind, gid) => {
				const el = document.createElement("button");
				el.type = "button";
				el.className = "dsg-chip";
				el.dataset.dsgChip = kind;
				if (gid !== undefined) el.dataset.dsgGid = gid;
				const caret = document.createElement("span");
				caret.className = "dsg-caret";
				const name = document.createElement("span");
				name.className = "dsg-name";
				const count = document.createElement("span");
				count.className = "dsg-count";
				const grip = document.createElement("span");
				grip.className = "dsg-grip";
				grip.textContent = "⠿";
				grip.title = t("dragHint");
				el.append(caret, name, count, grip);

				el.addEventListener("click", () => {
					if (kind === "group") {
						const g = groupById(gid);
						if (g === undefined) return;
						g.open = g.open === false;
					} else {
						state.folded = !state.folded;
					}
					save();
					// 展开/收起只影响显隐，不需要重排 —— 直接就地播动画，点击响应更跟手
					refreshRows();
					applyVisibility(true);
					refreshChipLabels();
				});

				// 拖整组改顺序
				if (kind === "group") {
					el.draggable = true;
					el.addEventListener("dragstart", (e) => {
						dragPayload = { kind: "group", gid };
						el.dataset.dsgDragging = "1";
						e.dataTransfer.effectAllowed = "move";
						try {
							e.dataTransfer.setData(DND_MIME, JSON.stringify(dragPayload));
						} catch (_ignored) {
							/* 某些宿主禁止自定义 MIME，靠内存里的 dragPayload 兜底 */
						}
					});
					el.addEventListener("dragend", () => {
						dragPayload = null;
						delete el.dataset.dsgDragging;
						clearDropMarks();
					});
				}
				return el;
			};

			const ensureChip = (g) => {
				let el = chips.get(g.id);
				if (el === undefined) {
					el = makeChip("group", g.id);
					chips.set(g.id, el);
				}
				return el;
			};

			const ensureLooseChip = () => {
				if (looseChip === null) looseChip = makeChip("loose");
				return looseChip;
			};

			/**
			 * 只在内容真变了时才写 textContent。
			 * 直接赋值会替换文本节点 → 对导航列表来说是一次 childList mutation，
			 * 而我们的观察器正盯着那里 ⇒ 每次 sync 都会把自己再触发一遍（风暴）。
			 */
			const setText = (el, value) => {
				if (el !== undefined && el !== null && el.textContent !== value) el.textContent = value;
			};

			const refreshChipLabels = () => {
				for (const g of state.groups) {
					const chip = chips.get(g.id);
					if (chip === undefined) continue;
					const n = entriesOf(g).length;
					setText(chip.children[1], g.name);
					setText(chip.children[2], String(n));
					const expanded = String(g.open !== false);
					if (chip.getAttribute("aria-expanded") !== expanded) chip.setAttribute("aria-expanded", expanded);
					const title = g.open === false ? t("expand") : t("collapse");
					if (chip.title !== title) chip.title = title;
					// 空分组也要留在导航里：它得能当拖拽的投放目标，
					// 否则「把条目拖进新分组」这条最常用的路径就断了。
				}
				if (looseChip !== null) {
					const n = looseIds().length;
					setText(looseChip.children[1], t("ungrouped"));
					setText(looseChip.children[2], String(n));
					const expanded = String(!state.folded);
					if (looseChip.getAttribute("aria-expanded") !== expanded) looseChip.setAttribute("aria-expanded", expanded);
					const title = state.folded ? t("expand") : t("collapse");
					if (looseChip.title !== title) looseChip.title = title;
				}
			};

			// ---- 按钮引用表同步 ----
			// React 重建导航时旧元素会失效。按「印记 → label 文本 → DOM 顺序」三级匹配：
			// 印记（data-dsg-id）能让 React 复用元素的场景完全免疫错位；
			// label 是主路径；DOM 顺序只做最后的兜底。
			const syncRefs = (nav) => {
				const alive = new Set();
				for (const child of nav.children) {
					if (child.tagName !== "BUTTON" || isInjected(child)) continue;
					alive.add(child);
				}
				for (const [id, el] of [...refs]) if (!alive.has(el)) refs.delete(id);
				const taken = new Set(refs.values());
				const pending = rows.filter((r) => !refs.has(r.id));
				const knownIds = new Set(rows.map((r) => r.id));

				// 第一级：读回上一轮打下的印记
				for (const child of [...nav.children]) {
					if (child.tagName !== "BUTTON" || isInjected(child) || taken.has(child)) continue;
					const mark = child.dataset.dsgId;
					if (mark === undefined || !knownIds.has(mark) || refs.has(mark)) continue;
					refs.set(mark, child);
					taken.add(child);
					const at = pending.findIndex((r) => r.id === mark);
					if (at >= 0) pending.splice(at, 1);
				}

				// 第二级：label 文本（每个设置页标题唯一）
				for (const child of [...nav.children]) {
					if (child.tagName !== "BUTTON" || isInjected(child) || taken.has(child)) continue;
					const text = (child.textContent ?? "").trim();
					if (text === "") continue;
					const idx = pending.findIndex((r) => (r.label ?? "").trim() === text);
					if (idx >= 0) {
						refs.set(pending[idx].id, child);
						taken.add(child);
						pending.splice(idx, 1);
					}
				}

				// 第三级：DOM 顺序兜底
				let i = 0;
				for (const child of [...nav.children]) {
					if (child.tagName !== "BUTTON" || isInjected(child) || taken.has(child)) continue;
					while (i < pending.length && refs.has(pending[i].id)) i += 1;
					if (i < pending.length) {
						refs.set(pending[i].id, child);
						taken.add(child);
						i += 1;
					}
				}

				// 打回印记 + 自检：映射错了会让拖拽把条目搬到别的分区去，
				// 这类错位在 DOM 被宿主反复重建时最容易悄悄发生，留一条痕迹。
				for (const [id, el] of refs) {
					if (el.dataset.dsgId !== id) el.dataset.dsgId = id;
					const expect = (labelOf(id) ?? "").trim();
					const actual = (el.textContent ?? "").trim();
					if (expect !== "" && actual !== "" && expect !== actual) {
						console.warn(`[settings-groups] ref mismatch: ${id} → "${actual}" (expected "${expect}")`);
					}
				}
			};

			// ---- 条目按钮的拖拽绑定 ----
			let dragPayload = null;

			/**
			 * 给条目按钮绑拖拽。**不缓存 entryId** —— 绑定是一次性的，
			 * 但按钮与台账的映射会随宿主重渲染变化，只有 dragstart 那一刻
			 * 实时反查出来的 id 才是对的（缓存过的会张冠李戴）。
			 */
			const bindItemDrag = (btn) => {
				if (btn.dataset.dsgBound === "1") {
					// 已绑过（总开关被关掉后再打开）：只把可拖状态恢复回来
					btn.draggable = true;
					return;
				}
				btn.dataset.dsgBound = "1";
				btn.dataset.dsgItem = "1";
				btn.draggable = true;
				btn.addEventListener("dragstart", (e) => {
					const id = buttonId(btn);
					if (id === undefined) return;
					dragPayload = { kind: "item", id };
					btn.dataset.dsgDragging = "1";
					e.dataTransfer.effectAllowed = "move";
					try {
						e.dataTransfer.setData(DND_MIME, JSON.stringify(dragPayload));
					} catch (_ignored) {
						/* 兜底看 dragPayload */
					}
				});
				btn.addEventListener("dragend", () => {
					dragPayload = null;
					delete btn.dataset.dsgDragging;
					clearDropMarks();
				});
			};

			// ---- 放置目标判定 ----
			const buttonId = (btn) => {
				for (const [id, el] of refs) if (el === btn) return id;
				return undefined;
			};

			const hitTest = (x, y) => {
				const raw = document.elementFromPoint(x, y);
				if (raw === null) return null;
				const chip = raw.closest?.(".dsg-chip");
				if (chip !== null && chip !== undefined) {
					if (chip.dataset.dsgChip === "loose") return { kind: "loose", el: chip };
					return { kind: "chip", el: chip, gid: chip.dataset.dsgGid };
				}
				const btn = raw.closest?.("button");
				if (btn === null || btn === undefined) return null;
				if (isCore(buttonId(btn) ?? "")) return null;
				const id = buttonId(btn);
				if (id === undefined) return null;
				return { kind: "item", el: btn, id };
			};

			const clearDropMarks = () => {
				for (const el of document.querySelectorAll('[data-dsg-drop]')) delete el.dataset.dsgDrop;
			};

			const onDragOver = (e) => {
				if (dragPayload === null) return;
				const hit = hitTest(e.clientX, e.clientY);
				if (hit === null) {
					clearDropMarks();
					return;
				}
				const mode = decideDrop(hit, e);
				if (mode === null) {
					clearDropMarks();
					return;
				}
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				clearDropMarks();
				hit.el.dataset.dsgDrop = mode;
			};

			/** 返回 "into" | "before" | "after" | null */
			const decideDrop = (hit, e) => {
				if (dragPayload === null) return null;
				if (dragPayload.kind === "group") {
					// 组只认组之间的位置（拖到条目上无意义）
					if (hit.kind !== "chip") return null;
					if (hit.gid === dragPayload.gid) return null;
					const rect = hit.el.getBoundingClientRect();
					return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
				}
				// 条目
				if (hit.kind === "chip" || hit.kind === "loose") return "into";
				const rect = hit.el.getBoundingClientRect();
				return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
			};

			const applyDrop = (hit, mode, e) => {
				if (dragPayload === null) return;
				if (dragPayload.kind === "group") {
					const from = state.groups.findIndex((g) => g.id === dragPayload.gid);
					const to = state.groups.findIndex((g) => g.id === hit.gid);
					if (from < 0 || to < 0 || from === to) return;
					const [moved] = state.groups.splice(from, 1);
					let index = state.groups.findIndex((g) => g.id === hit.gid);
					if (mode === "after") index += 1;
					state.groups.splice(index, 0, moved);
					return;
				}
				const id = dragPayload.id;
				if (hit.kind === "chip") {
					place(id, { gid: hit.gid, anchorGid: hit.gid });
					const g = groupById(hit.gid);
					if (g !== undefined) g.open = true;
					return;
				}
				if (hit.kind === "loose") {
					place(id, {});
					state.folded = false;
					return;
				}
				// 落在条目上：跟随目标条目所在的容器
				const target = groupOf(hit.id);
				const where = target === undefined ? { gid: undefined } : { gid: target.id };
				if (mode === "before") where.before = hit.id;
				else where.after = hit.id;
				if (where.gid !== undefined) where.anchorGid = where.gid;
				place(id, where);
				return;
			};

			const onDrop = (e) => {
				if (dragPayload === null) return;
				const hit = hitTest(e.clientX, e.clientY);
				if (hit !== null) {
					const mode = decideDrop(hit, e);
					if (mode !== null) {
						e.preventDefault();
						applyDrop(hit, mode, e);
					}
				}
				dragPayload = null;
				clearDropMarks();
				save();
				sync(true);
				notifyPage();
			};

			const bindNavDnd = (nav) => {
				if (nav.dataset.dsgDnd === "1") return;
				nav.dataset.dsgDnd = "1";
				nav.addEventListener("dragover", onDragOver);
				nav.addEventListener("drop", onDrop);
				nav.addEventListener("dragleave", (e) => {
					if (nav.contains(e.relatedTarget)) return;
					clearDropMarks();
				});
			};

			// ---- 显隐 + 过渡 ----
			// 一次展开/收起要同时动四层：透明度、缩放位移、模糊、以及真实高度。
			// 高度这层不能交给 CSS 规则算（收起后条目要 display:none，无法过渡），
			// 只能在动画前临时锁成像素值、动画后再清掉让它回到自适应。
			const ANIM_EASE = "cubic-bezier(.4,0,.2,1)";

			/** 抹掉动画期间挂上去的所有 inline style（保留外部传入的 display）。 */
			const resetItemStyles = (btn) => {
				btn.style.height = "";
				btn.style.overflow = "";
				btn.style.boxSizing = "";
				btn.style.paddingTop = "";
				btn.style.paddingBottom = "";
				btn.style.marginTop = "";
				btn.style.marginBottom = "";
				btn.style.transitionDelay = "";
				btn.style.transitionTimingFunction = "";
				btn.style.animationDelay = "";
				btn.style.removeProperty("--dsg-h");
				delete btn.dataset.dsgAnim;
			};

			/**
			 * 入场：keyframes 驱动（height + opacity + blur + transform 一条动画），
			 * 不用 transition —— display:none 恢复的那一帧浏览器认为元素"刚出生"，
			 * 没有前值可插值，transition 直接不跑。
			 */
			const animateIn = (list) => {
				list.forEach((btn, i) => {
					const delay = Math.min(i * 22, 110);
					btn.style.display = "";
					resetItemStyles(btn);
					const natural = Math.max(1, btn.getBoundingClientRect().height);
					btn.style.setProperty("--dsg-h", `${Math.round(natural)}px`);
					btn.style.animationDelay = `${delay}ms`;
					// 同一个 animation 想重播，得先摘掉再挂回去，中间强制一次回流
					delete btn.dataset.dsgAnim;
					void btn.offsetWidth;
					btn.dataset.dsgAnim = "in";
					setTimeout(() => {
						btn.style.animationDelay = "";
						if (btn.dataset.dsgAnim !== "in") return;
						// 先落到实际高度再撤属性：直接撤会让 height 从 40px 跳回 auto，
						// 虽然值相同，但换行场景下会闪一下
						btn.style.height = `${Math.round(natural)}px`;
						delete btn.dataset.dsgAnim;
						requestAnimationFrame(() => resetItemStyles(btn));
					}, delay + ANIM_MS + 60);
				});
			};

			/**
			 * 退场：同样一条 keyframes 带全部属性。
			 * 之前 opacity 走 transition 立刻起步、height 要等双 rAF 才动，
			 * 错开 32ms 看着就是「停顿一下才塌」。
			 */
			const animateOut = (list) => {
				list.forEach((btn, i) => {
					const delay = Math.min(i * 10, 70);
					const h = Math.max(1, btn.getBoundingClientRect().height);
					btn.style.setProperty("--dsg-h", `${Math.round(h)}px`);
					btn.style.animationDelay = `${delay}ms`;
					delete btn.dataset.dsgAnim;
					void btn.offsetWidth;
					btn.dataset.dsgAnim = "out";
					setTimeout(() => {
						btn.style.animationDelay = "";
						// 期间若被重新展开，dataset 已经被 animateIn 改掉 → 这里不隐藏
						if (btn.dataset.dsgAnim !== "out") return;
						// 必须先 display:none 再撤动画，否则会闪回满高那一帧
						btn.style.display = "none";
						delete btn.dataset.dsgAnim;
						resetItemStyles(btn);
					}, delay + ANIM_MS + 50);
				});
			};

			const applyVisibility = (animate) => {
				const enter = [];
				const leave = [];
				for (const r of rows) {
					if (isCore(r.id)) continue;
					const btn = refs.get(r.id);
					if (btn === undefined) continue;
					// 正在过渡的按钮别插手，否则会把动画打断
					if (btn.dataset.dsgAnim !== undefined) continue;
					const g = groupOf(r.id);
					// 隐藏优先于一切：藏起来的条目不管在不在组里、组展没展开，都不显示。
					// 没有分组的时候「折叠未分组」这个状态没有意义，全部视为展开。
					const visible = state.hidden.includes(r.id)
						? false
						: (g === undefined ? (state.groups.length === 0 || !state.folded) : g.open !== false);
					const prev = shownState.get(btn);
					shownState.set(btn, visible);
					if (prev === visible || prev === undefined) {
						// 新按钮（首次渲染或 React 重建）直接落到最终态，不播动画
						const want = visible ? "" : "none";
						if (btn.style.display !== want) btn.style.display = want;
						continue;
					}
					if (visible) enter.push(btn);
					else leave.push(btn);
				}
				if (!animate) {
					for (const btn of enter) {
						btn.style.display = "";
						delete btn.dataset.dsgAnim;
					}
					for (const btn of leave) {
						btn.style.display = "none";
						delete btn.dataset.dsgAnim;
					}
					return;
				}
				if (enter.length > 0) animateIn(enter);
				if (leave.length > 0) animateOut(leave);
			};

			// ---- 布局 ----
			const layout = (nav) => {
				const seq = [];
				// 搜索框固定在列表最前。条目少于 3 个时不显示 —— 就那么几行，搜索框纯占地方。
				const nonCore = rows.filter((r) => !isCore(r.id)).length;
				const wantSearch = nonCore >= 3;
				let anchor = null;
				if (wantSearch) {
					const box = ensureSearchBox();
					if (nav.firstChild !== box) nav.insertBefore(box, nav.firstChild);
					anchor = box;
				} else if (searchBox !== null && searchBox.parentNode !== null) {
					searchBox.remove();
					if (searchQuery !== "") {
						searchQuery = "";
						applySearch();
					}
				}

				const core = [];
				for (const r of rows) {
					if (!isCore(r.id)) continue;
					const btn = refs.get(r.id);
					if (btn !== undefined) core.push(btn);
				}
				seq.push(...core);
				for (const g of state.groups) {
					const chip = ensureChip(g);
					seq.push(chip);
					for (const id of entriesOf(g)) {
						const btn = refs.get(id);
						if (btn !== undefined) seq.push(btn);
					}
				}
				const loose = looseIds();
				// 没建过分组时不需要「未分组」这个标签：条目本来就全都平铺着。
				// 一旦有了分组，即使未分组为空也要留着 —— 它是「把条目移出分组」的投放目标。
				if (state.groups.length > 0) {
					seq.push(ensureLooseChip());
				} else if (looseChip !== null && looseChip.parentNode !== null) {
					looseChip.remove();
				}
				for (const id of loose) {
					const btn = refs.get(id);
					if (btn !== undefined) seq.push(btn);
				}
				// 清掉已删除分组的 chip
				const aliveGids = new Set(state.groups.map((g) => g.id));
				for (const [gid, el] of [...chips]) {
					if (aliveGids.has(gid)) continue;
					el.remove();
					chips.delete(gid);
				}
				// 一次性对齐：锚点向后推进，位置对了就不动 DOM（避免抖动循环）
				for (const el of seq) {
					const expected = anchor === null ? nav.firstElementChild : anchor.nextSibling;
					if (el.parentNode !== nav || el !== expected) nav.insertBefore(el, expected);
					anchor = el;
				}
				refreshChipLabels();
				applySearch();
			};

			/** 关掉总开关时：把导航还原成宿主原生顺序与显隐。 */
			const restoreNative = (nav) => {
				for (const [gid, el] of [...chips]) {
					el.remove();
					chips.delete(gid);
				}
				if (looseChip !== null && looseChip.parentNode !== null) looseChip.remove();
				if (searchBox !== null && searchBox.parentNode !== null) searchBox.remove();
				delete nav.dataset.dsgSearch;
				for (const el of nav.querySelectorAll("[data-dsg-hit]")) delete el.dataset.dsgHit;
				clearDropMarks();
				// 原生顺序：按台账 order 重排
				let anchor = null;
				for (const r of rows) {
					const btn = refs.get(r.id);
					if (btn === undefined) continue;
					resetItemStyles(btn);
					btn.style.display = "";
					btn.draggable = false;
					delete btn.dataset.dsgDragging;
					const expected = anchor === null ? nav.firstElementChild : anchor.nextSibling;
					if (btn.parentNode !== nav || btn !== expected) nav.insertBefore(btn, expected);
					anchor = btn;
				}
				// 剩下没被引用到的原生按钮也恢复显示
				for (const child of nav.children) {
					if (child.tagName !== "BUTTON" || isInjected(child)) continue;
					child.style.display = "";
				}
			};

			// ---- 主同步 ----
			let inSync = false;
			let pendingSync = false;
			let animatePending = false;

			const sync = (animate = false) => {
				if (inSync) {
					pendingSync = true;
					if (animate) animatePending = true;
					return;
				}
				inSync = true;
				try {
					const nav = findNavList();
					if (nav === null) return;
					refreshRows();
					if (legacyRunning()) {
						// 旧插件在跑：退让，不碰 DOM（两边都改会互相打架）
						if (chips.size > 0 || looseChip !== null) restoreNative(nav);
						return;
					}
					if (!state.enabled) {
						restoreNative(nav);
						return;
					}
					syncRefs(nav);
					bindNavDnd(nav);
					// 给可拖条目绑定拖拽
					for (const r of rows) {
						if (isCore(r.id)) continue;
						const btn = refs.get(r.id);
						if (btn !== undefined) bindItemDrag(btn);
					}
					// 核心项不该被拖
					for (const r of rows) {
						if (!isCore(r.id)) continue;
						const btn = refs.get(r.id);
						if (btn !== undefined) {
							btn.draggable = false;
							delete btn.dataset.dsgItem;
						}
					}
					layout(nav);
					applyVisibility(animate);
				} finally {
					inSync = false;
					if (pendingSync) {
						pendingSync = false;
						const a = animatePending;
						animatePending = false;
						sync(a);
					}
				}
			};

			// ---- 台账 / 语言订阅 ----
			ctx.effect(() => ctx.slots.subscribe("settings.section", () => {
				refreshRows();
				sync();
				notifyPage();
			}), "settings-groups: section ledger watch");

			ctx.effect(() => ctx.locale.subscribe(() => {
				refreshRows();
				sync();
				notifyPage();
			}), "settings-groups: locale watch");

			// ---- DOM 观察器（设置面板挂载 / 宿主重渲染）----
			// 只关心两类变化：设置 dialog 内的 childList，和 dialog 本身的挂载。
			// 附加风暴看门狗：异常时挂起 2 秒，避免页面被卡死。
			let syncCount = 0;
			let stormBase = 0;
			let stormTimer = null;
			let suspended = false;
			const observer = new MutationObserver((mutations) => {
				if (suspended) return;
				let need = false;
				for (const m of mutations) {
					if (m.type !== "childList") continue;
					const target = m.target;
					if (!(target instanceof Element)) continue;
					// chip 内部（文字/计数）的变化是我们自己写的，忽略
					if (target.closest?.(".dsg-chip") != null) continue;
					const inDialog = target.closest?.('[role="dialog"][aria-modal="true"]') !== null;
					const dialogTouched = [...(m.addedNodes ?? []), ...(m.removedNodes ?? [])].some(
						(n) => n instanceof Element && n.matches?.('[role="dialog"][aria-modal="true"]'),
					);
					if (target === document.body || dialogTouched || inDialog) {
						need = true;
						break;
					}
				}
				if (!need) return;
				const now = Date.now();
				if (now - stormBase > 1000) {
					syncCount = 0;
					stormBase = now;
				}
				syncCount += 1;
				if (syncCount > 24) {
					console.warn("[settings-groups] mutation storm — suspending observer for 2s");
					suspended = true;
					observer.disconnect();
					stormTimer = setTimeout(() => {
						stormTimer = null;
						suspended = false;
						observer.observe(document.body, { childList: true, subtree: true });
						sync();
					}, 2000);
					return;
				}
				sync();
			});

			ctx.effect(() => {
				observer.observe(document.body, { childList: true, subtree: true });
				return () => {
					observer.disconnect();
					if (stormTimer !== null) clearTimeout(stormTimer);
					for (const [, el] of chips) el.remove();
					chips.clear();
					if (looseChip !== null) looseChip.remove();
					looseChip = null;
					if (searchBox !== null) searchBox.remove();
					searchBox = null;
					refs.clear();
					pageListeners.clear();
					// 抹掉留在宿主按钮上的痕迹：插件卸载后导航必须和原生长得一样
					clearDropMarks();
					for (const el of document.querySelectorAll("[data-dsg-item], [data-dsg-bound], [data-dsg-dragging], [data-dsg-anim], [data-dsg-id]")) {
						resetItemStyles(el);
						el.style.display = "";
						if (el.tagName === "BUTTON") el.draggable = false;
						for (const key of ["dsgItem", "dsgBound", "dsgDragging", "dsgId"]) delete el.dataset[key];
					}
				};
			}, "settings-groups: dom observer");

			// ---------------------------------------------------------------- 管理页
			const newGroup = (name) => {
				const g = { id: `g${nextGroupId++}`, name, entries: [], open: true };
				state.groups.push(g);
				save();
				return g;
			};

			const removeGroup = (gid) => {
				const idx = state.groups.findIndex((g) => g.id === gid);
				if (idx < 0) return;
				const [g] = state.groups.splice(idx, 1);
				// 条目回到未分组，保持原有先后
				state.loose = [...new Set([...g.entries, ...state.loose])];
				save();
			};

			const moveGroup = (gid, delta) => {
				const idx = state.groups.findIndex((g) => g.id === gid);
				const to = idx + delta;
				if (idx < 0 || to < 0 || to >= state.groups.length) return;
				const [g] = state.groups.splice(idx, 1);
				state.groups.splice(to, 0, g);
				save();
			};

			/** 组内上移/下移 */
			const moveEntry = (gid, id, delta) => {
				const g = gid === undefined ? undefined : groupById(gid);
				const list = g === undefined ? looseIds() : [...g.entries];
				const idx = list.indexOf(id);
				const to = idx + delta;
				if (idx < 0 || to < 0 || to >= list.length) return;
				list.splice(idx, 1);
				list.splice(to, 0, id);
				if (g === undefined) state.loose = list;
				else g.entries = list;
				save();
			};

			function GroupsPage(props) {
				const tPage = props?.t ?? t;
				const [, setTick] = React.useState(0);
				const [draft, setDraft] = React.useState("");
				const [renaming, setRenaming] = React.useState(null); // gid
				const [renameText, setRenameText] = React.useState("");
				const [dragId, setDragId] = React.useState(null); // 被拖的条目
				const [dropTarget, setDropTarget] = React.useState(null); // gid | "__loose" | "row:<id>:before"
				const [flash, setFlash] = React.useState("");

				React.useEffect(() => {
					const bump = () => setTick((v) => v + 1);
					pageListeners.add(bump);
					return () => pageListeners.delete(bump);
				}, []);

				React.useEffect(() => {
					// 进入管理页时补一次台账刷新（面板刚打开时可能还没同步）
					refreshRows();
					setTick((v) => v + 1);
				}, []);

				const groups = state.groups;
				const loose = looseIds();
				// 不按台账过滤：卸载的插件也要留在清单里，否则用户既看不到也删不掉，
				// 重装时又莫名其妙变成隐藏状态（"幽灵隐藏项"）。
				const installedIds = rowIds();
				const hiddenIds = [...state.hidden];
				const staleHidden = hiddenIds.filter((id) => !installedIds.has(id));
				const total = rows.filter((r) => !isCore(r.id)).length;
				const coreNames = () => {
					const names = rows
						.filter((r) => isCore(r.id) && r.id !== MANAGE_ID)
						.map((r) => r.label)
						.filter((x) => typeof x === "string" && x !== "");
					return names.slice(0, 2).join(" / ") || "—";
				};
				const say = (msg) => {
					setFlash(msg);
					setTimeout(() => setFlash(""), 1600);
				};

				const commit = (msg) => {
					save();
					// 带动画同步：隐藏/移出时右侧导航里那一条应该淡出塌掉，而不是凭空消失
					sync(true);
					notifyPage();
					if (msg !== undefined) say(msg);
				};

				const addGroup = () => {
					const name = draft.trim();
					if (name === "") return;
					newGroup(name);
					setDraft("");
					commit(tPage("created"));
				};

				const entryRow = (id, gid) => h("div", {
					key: `r-${gid ?? "loose"}-${id}`,
					className: "dsg-row",
					draggable: true,
					"data-dragging": dragId === id ? "1" : undefined,
					"data-over": dropTarget !== null && dropTarget.startsWith(`row:${id}:`) ? dropTarget.split(":").at(-1) : undefined,
					onDragStart: (e) => {
						setDragId(id);
						e.dataTransfer.effectAllowed = "move";
						try {
							e.dataTransfer.setData("text/plain", id);
						} catch (_ignored) {
							/* noop */
						}
					},
					onDragEnd: () => {
						setDragId(null);
						setDropTarget(null);
					},
					onDragOver: (e) => {
						if (dragId === null || dragId === id) return;
						e.preventDefault();
						const rect = e.currentTarget.getBoundingClientRect();
						const before = e.clientY < rect.top + rect.height / 2;
						setDropTarget(`row:${id}:${before ? "before" : "after"}`);
					},
					onDrop: (e) => {
						e.preventDefault();
						if (dragId === null || dragId === id) return;
						const rect = e.currentTarget.getBoundingClientRect();
						const before = e.clientY < rect.top + rect.height / 2;
						const where = gid === undefined ? {} : { gid, anchorGid: gid };
						if (before) where.before = id;
						else where.after = id;
						place(dragId, where);
						setDragId(null);
						setDropTarget(null);
						commit();
					},
				},
				h("span", { className: "dsg-rowgrip", title: tPage("dragRowHint") }, "⠿"),
				h("span", { className: "dsg-rowname", title: labelOf(id) }, labelOf(id)),
				h("button", {
					type: "button",
					className: "dsg-btn dsg-btn-ghost",
					title: tPage("up"),
					onClick: () => {
						moveEntry(gid, id, -1);
						commit();
					},
				}, "↑"),
				h("button", {
					type: "button",
					className: "dsg-btn dsg-btn-ghost",
					title: tPage("down"),
					onClick: () => {
						moveEntry(gid, id, 1);
						commit();
					},
				}, "↓"),
				gid === undefined
					? h("select", {
						className: "dsg-select",
						value: "",
						title: tPage("toGroup"),
						onChange: (e) => {
							const target = e.target.value;
							if (target === "") return;
							place(id, { gid: target, anchorGid: target });
							const g = groupById(target);
							commit(g === undefined ? undefined : tPage("movedTo").replace("{name}", g.name));
						},
					},
					h("option", { value: "" }, tPage("toGroup")),
					groups.map((g) => h("option", { key: g.id, value: g.id }, g.name)),
					)
					: h("button", {
						type: "button",
						className: "dsg-btn dsg-btn-ghost",
						title: tPage("remove"),
						onClick: () => {
							place(id, {});
							commit(tPage("movedOut"));
						},
					}, tPage("remove")),
				// 隐藏：从导航里彻底拿掉，但配置留着，随时能从「已隐藏」放回来
				h("button", {
					type: "button",
					className: "dsg-btn dsg-btn-ghost",
					title: tPage("hideHint"),
					onClick: () => {
						hideEntry(id);
						commit(tPage("hiddenDone"));
					},
				}, "⊘"),
				);

				const groupCard = (g, index) => {
					const items = entriesOf(g);
					const isOver = dropTarget === g.id;
					return h("div", {
						key: g.id,
						className: "dsg-card",
						"data-over": isOver ? "1" : undefined,
						onDragOver: (e) => {
							if (dragId === null) return;
							e.preventDefault();
							setDropTarget(g.id);
						},
						onDragLeave: (e) => {
							if (e.currentTarget.contains(e.relatedTarget)) return;
							setDropTarget((cur) => (cur === g.id ? null : cur));
						},
						onDrop: (e) => {
							e.preventDefault();
							if (dragId !== null) {
								place(dragId, { gid: g.id, anchorGid: g.id });
								setDragId(null);
								setDropTarget(null);
								commit(tPage("movedTo").replace("{name}", g.name));
							}
						},
					},
					h("div", { className: "dsg-cardhead" },
						renaming === g.id
							? h(React.Fragment, null,
								h("input", {
									className: "dsg-input",
									value: renameText,
									autoFocus: true,
									onChange: (e) => setRenameText(e.target.value),
									onKeyDown: (e) => {
										if (e.key === "Enter") {
											const name = renameText.trim();
											if (name !== "") g.name = name;
											setRenaming(null);
											commit();
										}
										if (e.key === "Escape") setRenaming(null);
									},
								}),
								h("button", {
									type: "button",
									className: "dsg-btn",
									onClick: () => {
										const name = renameText.trim();
										if (name !== "") g.name = name;
										setRenaming(null);
										commit();
									},
								}, tPage("save")),
								h("button", { type: "button", className: "dsg-btn dsg-btn-ghost", onClick: () => setRenaming(null) }, tPage("cancel")),
							)
							: h(React.Fragment, null,
								h("span", { className: "dsg-cardname" }, g.name),
								h("span", { className: "dsg-cardcount" }, tPage("itemsCount").replace("{n}", String(items.length))),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost",
									title: tPage("up"),
									disabled: index === 0,
									onClick: () => {
										moveGroup(g.id, -1);
										commit();
									},
								}, "↑"),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost",
									title: tPage("down"),
									disabled: index === groups.length - 1,
									onClick: () => {
										moveGroup(g.id, 1);
										commit();
									},
								}, "↓"),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost",
									onClick: () => {
										setRenaming(g.id);
										setRenameText(g.name);
									},
								}, tPage("rename")),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost dsg-danger",
									title: tPage("removeGroupHint"),
									onClick: () => {
										removeGroup(g.id);
										commit();
									},
								}, tPage("removeGroup")),
							),
					),
					items.length === 0
						? h("p", { className: "dsg-empty" }, tPage("groupEmpty"))
						: h("div", { className: "dsg-rows" }, items.map((id) => entryRow(id, g.id))),
					);
				};

				return h("div", { className: "dsg-page" },
					legacyRunning()
						? h("p", { className: "dsg-warn" }, tPage("legacyWarn"))
						: null,
					h("div", { className: "dsg-card" },
						h("div", { className: "dsg-toggle" },
							h("div", { className: "dsg-toggletext" },
								h("span", { className: "dsg-toggletitle" }, tPage("enabled")),
								h("span", { className: "dsg-hint" }, tPage("enabledDesc")),
							),
							h("button", {
								type: "button",
								className: "dsg-switch",
								"data-on": state.enabled ? "1" : "0",
								onClick: () => {
									state.enabled = !state.enabled;
									commit();
								},
							}, h("span", { className: "dsg-knob" })),
						),
					),
					h("p", { className: "dsg-hint" }, tPage("panelHint")),
					h("p", { className: "dsg-hint" }, tPage("coreHint").replace("{name}", coreNames())),
					h("div", { className: "dsg-new" },
						h("input", {
							className: "dsg-input",
							placeholder: tPage("newGroupPlaceholder"),
							value: draft,
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => {
								if (e.key === "Enter") addGroup();
							},
						}),
						h("button", { type: "button", className: "dsg-btn", onClick: addGroup, disabled: draft.trim() === "" }, tPage("create")),
					),
					h("div", { className: "dsg-section" },
						h("div", { className: "dsg-sectionhead" },
							h("span", { className: "dsg-sectiontitle" }, tPage("groupsHead")),
							h("span", { className: "dsg-cardcount" }, String(groups.length)),
						),
						groups.length === 0
							? h("p", { className: "dsg-empty" }, tPage("emptyGroups"))
							: groups.map(groupCard),
					),
					h("div", {
						className: "dsg-section",
						onDragOver: (e) => {
							if (dragId === null) return;
							e.preventDefault();
							setDropTarget("__loose");
						},
						onDrop: (e) => {
							e.preventDefault();
							if (dragId !== null) {
								place(dragId, {});
								setDragId(null);
								setDropTarget(null);
								commit(tPage("movedOut"));
							}
						},
					},
						h("div", { className: "dsg-sectionhead" },
							h("span", { className: "dsg-sectiontitle" }, tPage("looseHead")),
							h("span", { className: "dsg-cardcount" }, String(loose.length)),
						),
						h("div", {
							className: "dsg-card",
							"data-over": dropTarget === "__loose" ? "1" : undefined,
						},
						loose.length === 0
							? h("p", { className: "dsg-empty" }, total === 0 ? tPage("emptyAll") : tPage("emptyLoose"))
							: h("div", { className: "dsg-rows" }, loose.map((id) => entryRow(id, undefined))),
						),
					),
					// 「已隐藏」：藏起来的东西不能没有去处，否则用户再也找不回来。
					// 这里既列清单，也是拖拽的投放目标（拖进来 = 隐藏）。
					h("div", {
						className: "dsg-section",
						onDragOver: (e) => {
							if (dragId === null) return;
							e.preventDefault();
							setDropTarget("__hidden");
						},
						onDrop: (e) => {
							e.preventDefault();
							if (dragId !== null) {
								hideEntry(dragId);
								setDragId(null);
								setDropTarget(null);
								commit(tPage("hiddenDone"));
							}
						},
					},
						h("div", { className: "dsg-sectionhead" },
							h("span", { className: "dsg-sectiontitle" }, tPage("hiddenHead")),
							h("span", { className: "dsg-cardcount" }, String(hiddenIds.length)),
							staleHidden.length > 0
								? h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost dsg-danger",
									style: { marginLeft: "auto" },
									title: tPage("forgetHint"),
									onClick: () => {
										state.hidden = state.hidden.filter((id) => installedIds.has(id));
										commit(tPage("forgottenAll").replace("{n}", String(staleHidden.length)));
									},
								}, tPage("forgetAll"))
								: null,
						),
						h("div", {
							className: "dsg-card",
							"data-over": dropTarget === "__hidden" ? "1" : undefined,
							title: tPage("hiddenDropHint"),
						},
						hiddenIds.length === 0
							? h("p", { className: "dsg-empty" }, tPage("hiddenEmpty"))
							: h("div", { className: "dsg-rows" }, hiddenIds.map((id) => {
								const live = installedIds.has(id);
								return h("div", {
									key: `h-${id}`,
									className: "dsg-row",
									"data-stale": live ? undefined : "1",
								},
								h("span", { className: "dsg-rowgrip", style: { visibility: "hidden" } }, "⠿"),
								h("span", { className: "dsg-rowname", title: id }, labelOf(id)),
								live ? null : h("span", { className: "dsg-cardcount" }, tPage("uninstalled")),
								live
									? h("button", {
										type: "button",
										className: "dsg-btn",
										onClick: () => {
											unhideEntry(id);
											commit(tPage("unhidden"));
										},
									}, tPage("unhide"))
									: h("button", {
										type: "button",
										className: "dsg-btn dsg-btn-ghost dsg-danger",
										title: tPage("forgetHint"),
										onClick: () => {
											forgetHidden(id);
											commit(tPage("forgotten"));
										},
									}, tPage("forget")),
								);
							})),
						),
					),
					h("div", { className: "dsg-foot" },
						h("button", {
							type: "button",
							className: "dsg-btn dsg-btn-ghost",
							title: tPage("reloadHint"),
							onClick: () => {
								pullFromHost(true);
							},
						}, tPage("reload")),
						h("button", {
							type: "button",
							className: "dsg-btn dsg-btn-ghost dsg-danger",
							onClick: () => {
								if (!window.confirm(tPage("resetConfirm"))) return;
								const fresh = defaults();
								state.groups = fresh.groups;
								state.loose = fresh.loose;
								state.hidden = fresh.hidden;
								state.folded = fresh.folded;
								state.enabled = fresh.enabled;
								commit(tPage("resetDone"));
							},
						}, tPage("reset")),
					),
					flash === "" ? null : h("p", { className: "dsg-hint", style: { color: "var(--dsw-alias-state-success-primary,#46a758)" } }, flash),
				);
			}

			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: MANAGE_ID, order: 27, label: () => t("label"), locale: NS },
				GroupsPage,
			));

			// ---------------------------------------------------------------- 设置面板可调
			// 原先这是本机补丁 dsh-settings-patch-panel-tweak，打在 dsh-settings-nav-organizer
			// 的 client.js 里 —— 那个插件一停，侧栏就变回"188px 写死、拉不动、面板挪不了"。
			// 既然本插件要顶掉它，这份能力就一并接过来。
			//
			// 面板结构（宿主 @deepseek-ai/dsh-client-ui-settings-general 的 SettingsPanel）：
			//   div[role=dialog][aria-modal=true][data-shortcut-modal=settings]
			//     ├─ nav   导航栏（宿主 CSS 把宽度写死）
			//     └─ div   内容区（首个子节点是 header）
			// 尺寸/位移沿用原来的 localStorage 键，之前调好的宽度和位置继续有效。
			const PT_SEL = '[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]';
			const PT_KEY = "dsh.settingsPanelTweak.v1";
			const PT_MIN_NAV = 150;
			const PT_MIN_CONTENT = 260;
			const PT_HIT = "button,a,input,select,textarea,[role='button']";

			const ptRead = () => {
				try {
					const raw = localStorage.getItem(PT_KEY);
					const v = raw === null ? {} : JSON.parse(raw);
					return v !== null && typeof v === "object" ? v : {};
				} catch (_ignored) {
					return {};
				}
			};
			const ptWrite = (patch) => {
				try {
					localStorage.setItem(PT_KEY, JSON.stringify({ ...ptRead(), ...patch }));
				} catch (_ignored) {
					/* 隐私模式下写不进去，只影响记忆不影响本次拖拽 */
				}
			};
			const ptNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
			const ptClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
			const ptTransform = (x, y) => `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;

			const ptStyle = document.createElement("style");
			ptStyle.dataset.dshPtweak = "1";
			const PT_CSS = [
				".dsh-ptweak-split{flex:0 0 6px;align-self:stretch;position:relative;cursor:col-resize;background:transparent;z-index:4}",
				".dsh-ptweak-split::after{content:'';position:absolute;top:10px;bottom:10px;left:2px;width:2px;border-radius:1px;background:transparent;transition:background .12s}",
				".dsh-ptweak-split:hover::after,.dsh-ptweak-split[data-dragging='1']::after{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.45))}",
				".dsh-ptweak-rz{position:absolute;z-index:6;touch-action:none}",
				".dsh-ptweak-rz[data-dir='n']{top:0;left:10px;right:10px;height:6px;cursor:ns-resize}",
				".dsh-ptweak-rz[data-dir='s']{bottom:0;left:10px;right:10px;height:6px;cursor:ns-resize}",
				".dsh-ptweak-rz[data-dir='e']{right:0;top:10px;bottom:10px;width:6px;cursor:ew-resize}",
				".dsh-ptweak-rz[data-dir='w']{left:0;top:10px;bottom:10px;width:6px;cursor:ew-resize}",
				".dsh-ptweak-rz[data-dir='ne']{top:0;right:0;width:11px;height:11px;cursor:nesw-resize}",
				".dsh-ptweak-rz[data-dir='nw']{top:0;left:0;width:11px;height:11px;cursor:nwse-resize}",
				".dsh-ptweak-rz[data-dir='se']{bottom:0;right:0;width:13px;height:13px;cursor:nwse-resize}",
				".dsh-ptweak-rz[data-dir='sw']{bottom:0;left:0;width:11px;height:11px;cursor:nesw-resize}",
				".dsh-ptweak-rz:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.3))}",
				".dsh-ptweak-grip::after{content:'';position:absolute;right:3px;bottom:3px;width:9px;height:9px;border-right:2px solid var(--dsw-alias-label-secondary,#8a8f98);border-bottom:2px solid var(--dsw-alias-label-secondary,#8a8f98);border-bottom-right-radius:3px;opacity:.45}",
				".dsh-ptweak-grip:hover::after{opacity:.9}",
				// ⚠️ 这里**不要**常驻 `will-change:transform`。
				// 常驻会让设置面板整个生命周期都待在 GPU 合成层上，合成层里的文字
				// 不走 subpixel antialiasing（LCD 次像素渲染），只剩灰度抗锯齿 ——
				// 看上去就是"设置变糊了"。改成拖动时临时提层，松手就撤（见 ptLift/ptDrop）。
				// 切换左侧设置项时，右侧内容区淡入 + 从模糊拉清楚。
				// 用 animation 而不是 transition：切换是"内容被换掉"，没有可过渡的前后值。
				// 不写 fill-mode，动画一结束元素就回到没有 filter 的状态，不会常驻合成层。
				"@keyframes dsgPageIn{from{opacity:.25;filter:blur(7px)}to{opacity:1;filter:blur(0)}}",
				"[data-dsg-page=\"in\"]{animation:dsgPageIn .3s cubic-bezier(.22,.8,.26,1)}",
				".dsh-ptweak-header{cursor:grab;user-select:none}",
				".dsh-ptweak-header:active{cursor:grabbing}",
			].join("\n");

			/**
			 * 取内容区。
			 *
			 * ⚠️ 不能直接 `nav.nextElementSibling` —— 侧栏分隔条是我们自己插在
			 * nav 后面的，那样拿到的会是一条 6px 的空 div，切页动画就白播了。
			 */
			const ptContentOf = (panel) => {
				const nav = panel.querySelector(":scope > nav");
				if (nav === null) return null;
				let el = nav.nextElementSibling;
				while (el !== null && el.classList.contains("dsh-ptweak-split")) el = el.nextElementSibling;
				return el;
			};

			/** 当前激活的设置页按钮（用来判断"换人了"）。 */
			let ptLastActive = null;
			/** 盯着 aria-current 变化的观察器，随插件一起销毁。 */
			let ptWatcher = null;

			/**
			 * 内容区过渡：先摘掉标记、强制回流，再挂回去 —— 同一个 animation 才能重播。
			 * 不加 fill-mode 的话动画一结束元素就回到无 filter 状态，不会一直待在合成层上。
			 */
			const ptPlayPageIn = (panel) => {
				const content = ptContentOf(panel);
				if (content === null) return;
				content.removeAttribute("data-dsg-page");
				void content.offsetWidth;
				content.setAttribute("data-dsg-page", "in");
			};

			/** ① 侧栏右缘分隔条 ② 拖 header 移动面板 ③ 四边四角缩放；都是双击复位。 */
			const ptDecorate = (panel) => {
				if (panel.dataset.dshPtweak === "1") return;
				const nav = panel.querySelector(":scope > nav");
				const content = ptContentOf(panel);
				if (nav === null || content === null) return;
				panel.dataset.dshPtweak = "1";
				const saved = ptRead();

				// ① 导航栏宽度。宿主的 nav 带内边距：rect 宽度 ≠ style.width，
				// 直接用 rect 会「每拖一次漂移一个 padding」，统一换算到 style 口径。
				const split = document.createElement("div");
				split.className = "dsh-ptweak-split";
				split.title = "拖动调整设置侧栏宽度（双击复位）";
				nav.after(split);
				const navPad = () => {
					const cs = getComputedStyle(nav);
					if (cs.boxSizing === "border-box") return 0;
					return (
						(parseFloat(cs.paddingLeft) || 0) +
						(parseFloat(cs.paddingRight) || 0) +
						(parseFloat(cs.borderLeftWidth) || 0) +
						(parseFloat(cs.borderRightWidth) || 0)
					);
				};
				const navStyleW = () => nav.getBoundingClientRect().width - navPad();
				const setNavStyleW = (w) => {
					nav.style.width = `${Math.round(w)}px`;
				};
				const savedNav = ptNum(saved.navW);
				if (savedNav !== null) setNavStyleW(ptClamp(savedNav, PT_MIN_NAV, 520));
				split.addEventListener("dblclick", (ev) => {
					ev.preventDefault();
					// 复位要滑回去，不能瞬移（拖动过程中不加过渡，那是跟手）
					nav.style.transition = "width .28s cubic-bezier(.2,.7,.3,1)";
					nav.style.width = "";
					setTimeout(() => {
						nav.style.transition = "";
					}, 320);
					ptWrite({ navW: null });
				});
				split.addEventListener("pointerdown", (ev) => {
					if (ev.button !== 0) return;
					ev.preventDefault();
					ev.stopPropagation();
					split.dataset.dragging = "1";
					try {
						split.setPointerCapture(ev.pointerId);
					} catch (_ignored) {
						/* 老浏览器没有 pointer capture，靠 document 上的 move 也能跑 */
					}
					const startX = ev.clientX;
					const startW = navStyleW();
					const extra = navPad();
					const move = (e) => {
						const max = Math.max(PT_MIN_NAV + 40, panel.getBoundingClientRect().width - PT_MIN_CONTENT - extra);
						setNavStyleW(ptClamp(startW + (e.clientX - startX), PT_MIN_NAV, max));
					};
					const up = () => {
						split.removeEventListener("pointermove", move);
						split.removeEventListener("pointerup", up);
						split.removeEventListener("pointercancel", up);
						delete split.dataset.dragging;
						ptWrite({ navW: Math.round(navStyleW()) });
					};
					split.addEventListener("pointermove", move);
					split.addEventListener("pointerup", up);
					split.addEventListener("pointercancel", up);
				});

				// ② 拖 header 移动整个面板（落在按钮/输入框上时不抢手势）
				const dx = ptNum(saved.dx) ?? 0;
				const dy = ptNum(saved.dy) ?? 0;
				if (dx !== 0 || dy !== 0) panel.style.transform = ptTransform(dx, dy);
				const header = content.firstElementChild;
				if (header !== null) {
					header.classList.add("dsh-ptweak-header");
					header.addEventListener("dblclick", (ev) => {
						if (ev.target.closest(PT_HIT) !== null) return;
						// 归位要滑，瞬移像"跳了一下"
						panel.style.transition = "transform .3s cubic-bezier(.2,.7,.3,1)";
						panel.style.transform = "";
						setTimeout(() => {
							panel.style.transition = "";
						}, 340);
						ptWrite({ dx: 0, dy: 0 });
					});
					header.addEventListener("pointerdown", (ev) => {
						if (ev.button !== 0) return;
						if (ev.target.closest(PT_HIT) !== null) return;
						ev.preventDefault();
						const cur = ptRead();
						const baseX = ptNum(cur.dx) ?? 0;
						const baseY = ptNum(cur.dy) ?? 0;
						const startX = ev.clientX;
						const startY = ev.clientY;
						try {
							header.setPointerCapture(ev.pointerId);
						} catch (_ignored) {
							/* noop */
						}
						const move = (e) => {
							panel.style.transform = ptTransform(baseX + (e.clientX - startX), baseY + (e.clientY - startY));
						};
						const up = () => {
							header.removeEventListener("pointermove", move);
							header.removeEventListener("pointerup", up);
							header.removeEventListener("pointercancel", up);
							const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(panel.style.transform || "");
							ptWrite({ dx: m ? Math.round(Number(m[1])) : 0, dy: m ? Math.round(Number(m[2])) : 0 });
						};
						header.addEventListener("pointermove", move);
						header.addEventListener("pointerup", up);
						header.addEventListener("pointercancel", up);
					});
				}

				// ③ 四边 + 四角缩放；默认比宿主大一整圈
				const PT_DEF_W = "min(1080px, calc(100vw - 64px))";
				const PT_DEF_H = "min(920px, calc(100vh - 64px))";
				const savedW = ptNum(saved.panelW);
				const savedH = ptNum(saved.panelH);
				// 宿主把尺寸写成 min()，不改 max-* 会夹住我们设的像素值
				panel.style.maxWidth = "none";
				panel.style.maxHeight = "none";
				panel.style.width = savedW !== null ? `${Math.max(440, savedW)}px` : PT_DEF_W;
				panel.style.height = savedH !== null ? `${Math.max(300, savedH)}px` : PT_DEF_H;

				const resetBox = () => {
					panel.style.transition = "width .3s cubic-bezier(.2,.7,.3,1), height .3s cubic-bezier(.2,.7,.3,1)";
					panel.style.width = PT_DEF_W;
					panel.style.height = PT_DEF_H;
					setTimeout(() => {
						panel.style.transition = "";
					}, 340);
					ptWrite({ panelW: null, panelH: null });
				};
				for (const [dir, sx, sy] of [
					["n", 0, -1], ["s", 0, 1], ["e", 1, 0], ["w", -1, 0],
					["ne", 1, -1], ["nw", -1, -1], ["se", 1, 1], ["sw", -1, 1],
				]) {
					const handle = document.createElement("div");
					handle.className = `dsh-ptweak-rz${dir === "se" ? " dsh-ptweak-grip" : ""}`;
					handle.dataset.dir = dir;
					handle.title = "拖动调整设置面板大小（双击复位）";
					panel.appendChild(handle);
					handle.addEventListener("dblclick", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						resetBox();
					});
					handle.addEventListener("pointerdown", (ev) => {
						if (ev.button !== 0) return;
						ev.preventDefault();
						ev.stopPropagation();
						try {
							handle.setPointerCapture(ev.pointerId);
						} catch (_ignored) {
							/* noop */
						}
						const rect = panel.getBoundingClientRect();
						const cur = ptRead();
						const baseDx = ptNum(cur.dx) ?? 0;
						const baseDy = ptNum(cur.dy) ?? 0;
						const startX = ev.clientX;
						const startY = ev.clientY;
						const maxW = Math.max(440, window.innerWidth - 16);
						const maxH = Math.max(300, window.innerHeight - 16);
						const move = (e) => {
							const w = sx ? ptClamp(rect.width + sx * (e.clientX - startX), 440, maxW) : rect.width;
							const h = sy ? ptClamp(rect.height + sy * (e.clientY - startY), 300, maxH) : rect.height;
							panel.style.width = `${Math.round(w)}px`;
							panel.style.height = `${Math.round(h)}px`;
							// 面板在 overlay 里是 flex 居中的：改尺寸会左右/上下各长一半，
							// 把平移补回一半，被拖的那条边才会咬住鼠标（否则手感像从中心缩放）
							let ndx = sx ? baseDx + (sx * (w - rect.width)) / 2 : baseDx;
							let ndy = sy ? baseDy + (sy * (h - rect.height)) / 2 : baseDy;
							const halfW = Math.max(0, (window.innerWidth - w) / 2);
							const halfH = Math.max(0, (window.innerHeight - h) / 2);
							ndx = ptClamp(ndx, -halfW, halfW);
							ndy = ptClamp(ndy, -halfH, halfH);
							panel.style.transform = ptTransform(ndx, ndy);
						};
						const up = () => {
							handle.removeEventListener("pointermove", move);
							handle.removeEventListener("pointerup", up);
							handle.removeEventListener("pointercancel", up);
							const box = panel.getBoundingClientRect();
							const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(panel.style.transform || "");
							ptWrite({
								panelW: Math.round(box.width),
								panelH: Math.round(box.height),
								dx: m ? Math.round(Number(m[1])) : 0,
								dy: m ? Math.round(Number(m[2])) : 0,
							});
						};
						handle.addEventListener("pointermove", move);
						handle.addEventListener("pointerup", up);
						handle.addEventListener("pointercancel", up);
					});
				}

				// 切换左侧设置项 → 右侧内容区来一下淡入模糊。
				// 内容区是宿主渲染的，唯一可靠的信号是左侧按钮的 aria-current 换人。
				ptWatcher = new MutationObserver((mutations) => {
					for (const m of mutations) {
						if (m.type !== "attributes" || m.attributeName !== "aria-current") continue;
						const el = m.target;
						if (!(el instanceof Element) || el.tagName !== "BUTTON") continue;
						const active = el.getAttribute("aria-current");
						if (active === null || active === "false") continue;
						if (ptLastActive === el) continue;
						ptLastActive = el;
						ptPlayPageIn(panel);
						return;
					}
				});
				ptWatcher.observe(panel, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });

				// 只在真的拖/缩时才把面板提为合成层，松手立刻撤。
				// 常驻 will-change 会让整个设置面板一直走 GPU 光栅化，文字丢掉次像素渲染
				// —— 那就是"装上补丁之后设置变糊"的来源。
				panel.addEventListener("pointerdown", (e) => {
					const target = e.target;
					if (!(target instanceof Element)) return;
					if (target.closest(".dsh-ptweak-split, .dsh-ptweak-rz, .dsh-ptweak-header") === null) return;
					panel.style.willChange = "transform";
					// 上一次复位的过渡如果还没跑完，这时的编辑会被它拖住 —— 直接掐断
					panel.style.transition = "";
					const navEl = panel.querySelector(":scope > nav");
					if (navEl !== null) navEl.style.transition = "";
				}, true);
				const dropLayer = () => {
					panel.style.willChange = "";
				};
				panel.addEventListener("pointerup", dropLayer, true);
				panel.addEventListener("pointercancel", dropLayer, true);
			};

			let ptQueued = false;
			const ptObserver = new MutationObserver(() => {
				if (ptQueued) return;
				ptQueued = true;
				setTimeout(() => {
					ptQueued = false;
					const panel = document.querySelector(PT_SEL);
					if (panel !== null) {
						try {
							ptDecorate(panel);
						} catch (error) {
							console.warn("[dsh-settings-groups] panel tweak failed", error);
						}
					}
				}, 0);
			});

			ctx.effect(() => {
				ptStyle.textContent = PT_CSS;
				document.head.appendChild(ptStyle);
				const scan = () => {
					const panel = document.querySelector(PT_SEL);
					if (panel !== null) ptDecorate(panel);
				};
				scan();
				ptObserver.observe(document.body, { childList: true, subtree: true });
				return () => {
					ptObserver.disconnect();
					if (ptWatcher !== null) {
						ptWatcher.disconnect();
						ptWatcher = null;
					}
					ptStyle.remove();
					for (const el of document.querySelectorAll(".dsh-ptweak-split, .dsh-ptweak-rz")) el.remove();
					const panel = document.querySelector(PT_SEL);
					if (panel !== null) {
						delete panel.dataset.dshPtweak;
						panel.style.transform = "";
						panel.style.width = "";
						panel.style.height = "";
						panel.style.maxWidth = "";
						panel.style.maxHeight = "";
						const nav = panel.querySelector(":scope > nav");
						if (nav !== null) nav.style.width = "";
					}
				};
			}, "settings-groups: panel tweak");

			// 首帧：设置面板可能还没挂载，观察器会补上
			refreshRows();
			// 刚从旧插件搬过来的配置立刻落盘，别等用户下一次操作才写
			if (migratedNow) save();
			sync();
			// 再跟磁盘那份对一次账（异步；宿主端没加载这条路由就纯 localStorage）
			hydrateFromHost();

			// 外部改动检测：主人让 AI 直接改 json 时，面板开着 5 秒内自己跟上。
			// 面板没开就不查，省得白跑请求。
			ctx.effect(() => {
				const timer = setInterval(() => {
					if (document.querySelector(NAV_SEL) === null) return;
					pullFromHost();
				}, 5000);
				return () => clearInterval(timer);
			}, "settings-groups: external config poll");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
