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
		// 宿主自带的设置页 —— 它们不是插件贡献，所以固定在顶部、不参与分组。
// 「设置管理」不在里面：它是本插件自己的页面，用户想把它丢进哪个组都行。
		const CORE_IDS = new Set(["general", "models", "plugins", "agent-presets", "account"]);
		/** 需要注入的客户端服务。 */
		const inject = ["slots", "locale"];
		/** 过渡时长（与 CSS 的 .26s 对齐）。 */
		const ANIM_MS = 220;
		/** 左侧导航长按后开始拖动的等待时间。 */
		const NAV_LONG_PRESS_MS = 250;
		const normalizeSidebarDragDelay = (value) => Math.min(5000, Math.max(100, Math.round(value)));
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
				label: "设置管理",
				heroTitle: "设置管理",
				heroSub: "把宿主的设置入口收进分组：排序、隐藏、在分组与未分组之间随意派发。",
				heroTag: "Layered",
				statusBar: "{groups} 个分组 · {items} 个设置入口 · {hidden} 个已隐藏",
				ungrouped: "未分组",
				expand: "展开",
				collapse: "收起",
				dragHint: "拖动可排序 / 拖进分组",
				pageTitle: "设置管理",
				enabled: "启用分组",
				enabledDesc: "关闭后设置导航完全恢复宿主原生平铺，配置仍然保留。",
				animations: "启用动效",
				animationsDesc: "一键开关设置管理提供的全部动效；关闭后操作立即完成，偏好会自动保存。",
				sidebarDrag: "左侧设置栏长按拖动",
				sidebarDragDesc: "开启后按住 {ms}ms 可拖动分组和设置入口；关闭后仍可点击、展开和收起分组。管理页内拖动不受影响。",
				sidebarDragDelay: "长按等待时间",
				sidebarDragDelayDesc: "100–5000ms，默认 250ms。按 Enter 或移开焦点保存。",
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
				renamed: "分组名称已更新",
				remove: "移出",
				removeGroup: "删除分组",
				removeGroupHint: "删除分组后，组内条目回到「未分组」，条目本身不受影响。",
				confirmDelete: "删除「{name}」？组内条目会回到未分组。",
				delCancel: "取消",
				delConfirm: "删除",
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
				legacyWarn: "检测到旧插件 dsh-settings-nav-organizer 仍在运行。两者都会改写设置导航，本插件已自动退让 —— 请先在「插件管理」里禁用它。",
				noEntries: "等待设置面板打开…",
				itemsCount: "{n} 项",
				movedTo: "已归入「{name}」",
				movedOut: "已移出分组",
				hide: "隐藏这一项",
				hideHint: "隐藏后导航里不再出现，配置还在，「已隐藏」里随时能放出来。",
				hiddenHead: "已隐藏",
				pinnedHead: "顶部固定项",
				pinnedHint: "宿主自带的入口，始终排在导航最上面，不参与分组。顺序可以调，也可以整个藏掉。",
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
				label: "Settings management",
				heroTitle: "Settings management",
				heroSub: "Collect the host's settings entries into groups: reorder, hide, and move them between groups and the ungrouped bucket.",
				heroTag: "Layered",
				statusBar: "{groups} groups · {items} entries · {hidden} hidden",
				ungrouped: "Ungrouped",
				expand: "Expand",
				collapse: "Collapse",
				dragHint: "Drag to reorder / drop into a group",
				pageTitle: "Settings management",
				enabled: "Enable groups",
				enabledDesc: "When off, the settings nav returns to the host's flat list; your configuration is kept.",
				animations: "Enable animations",
				animationsDesc: "Control all animations provided by Settings management. When off, actions finish immediately. Your preference is saved.",
				sidebarDrag: "Long-press dragging in the settings sidebar",
				sidebarDragDesc: "Hold for {ms}ms to drag groups and settings entries. Turning this off keeps clicks and group toggles available. Dragging within the management page is unaffected.",
				sidebarDragDelay: "Long-press delay",
				sidebarDragDelayDesc: "100–5000ms; default 250ms. Press Enter or leave the field to save.",
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
				renamed: "Group name updated",
				remove: "Remove",
				removeGroup: "Delete group",
				removeGroupHint: "Deleting a group returns its entries to “Ungrouped”; entries themselves are untouched.",
				confirmDelete: "Delete “{name}”? Its entries go back to Ungrouped.",
				delCancel: "Cancel",
				delConfirm: "Delete",
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
				legacyWarn: "The legacy plugin dsh-settings-nav-organizer is still running. Both rewrite the settings nav, so this plugin backed off — disable it in Plugins first.",
				noEntries: "Waiting for the settings panel…",
				itemsCount: "{n} items",
				movedTo: "Filed under “{name}”",
				movedOut: "Removed from group",
				hide: "Hide this entry",
				hideHint: "Hidden entries disappear from the nav but keep their config; bring them back from “Hidden”.",
				hiddenHead: "Hidden",
				pinnedHead: "Pinned",
				pinnedHint: "Host-provided entries. They stay at the top and never join a group, but you can reorder or hide them.",
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
			 * sidebarDrag / sidebarDragDelay：左侧导航长按拖动开关及等待毫秒数；
			 * updatedAt：写这份配置的时间戳，用来跟磁盘那份比新旧。
			 *
			 * 一个条目同时只能处在一种状态：某个分组 / 未分组 / 隐藏（三态互斥）。
			 * 收起哪一组、未分组收没收，下次开 DSH 要原样还原，不能一律展开。
			 *
			 * folded 默认 false：装这个插件就是为了把条目拖来拖去，一进来就全收起来
			 * 等于把可拖的东西藏了。想省地方再自己点那一行收起。
			 */
			const defaults = () => ({ v: 1, updatedAt: 0, migratedV1: false, enabled: true, animations: true, sidebarDrag: true, sidebarDragDelay: NAV_LONG_PRESS_MS, folded: false, groups: [], loose: [], hidden: [], coreExtra: [], coreOrder: [], topOrder: [] });

			const sanitize = (raw) => {
				const next = defaults();
				if (raw === null || typeof raw !== "object") return next;
				if (Number.isFinite(raw.updatedAt)) next.updatedAt = Number(raw.updatedAt);
				if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
				if (typeof raw.animations === "boolean") next.animations = raw.animations;
				if (typeof raw.sidebarDrag === "boolean") next.sidebarDrag = raw.sidebarDrag;
				if (Number.isFinite(raw.sidebarDragDelay)) next.sidebarDragDelay = normalizeSidebarDragDelay(raw.sidebarDragDelay);
				if (typeof raw.folded === "boolean") next.folded = raw.folded;
				if (Array.isArray(raw.coreExtra)) next.coreExtra = raw.coreExtra.filter((x) => typeof x === "string");
				if (Array.isArray(raw.coreOrder)) next.coreOrder = raw.coreOrder.filter((x) => typeof x === "string");
				if (Array.isArray(raw.topOrder)) next.topOrder = raw.topOrder.filter((x) => typeof x === "string");
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
				applyMotionPreference();
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
				// 节流期（pushTimer 还没到点）也算「本地有未落盘的改动」。
				// 只判断 pendingPush 会留一个 250ms 的空窗：这期间磁盘还是旧值，
				// 轮询一读就把用户刚做的操作覆盖回去了。
				if ((pendingPush || pushTimer !== null) && !force) return;
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
				applyMotionPreference();
				state.updatedAt = Date.now();
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
				} catch (error) {
					console.warn("[settings-groups] localStorage write failed:", error);
				}
				pushToHost();
			};

			// 短动效统一跟随系统偏好；停用或关闭页面时撤掉动画和只用于退场的画面。
			const uiMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
			const motionAllowed = () => state.animations && !uiMedia.matches;
			let settleMotion = () => {};
			function applyMotionPreference() {
				const mode = motionAllowed() ? "on" : "off";
				if (document.documentElement.dataset.dsgMotion === mode) return;
				document.documentElement.dataset.dsgMotion = mode;
				if (mode === "off") settleMotion();
			}
			ctx.effect(() => {
				// 范围只覆盖插件的界面和设置面板过渡，保持其他页面的行为。
				const off = 'html[data-dsg-motion="off"]';
				const panel = '[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]';
				const targets = [panel, `${panel} > nav`, `${panel} > nav *`, `${panel} > nav *::before`, `${panel} > nav *::after`,
					"[data-dsg-page]", ".dsg-page", ".dsg-page *", ".dsg-page *::before", ".dsg-page *::after", ".dsh-ptweak-split::after", ".dsh-ptweak-header", ".dsh-ptweak-rz", "[data-dsg-floating]", "[data-dsg-row-floating]"];
				const style = document.createElement("style");
				style.dataset.dsgMotionStyle = "1";
				style.textContent = `${targets.map((selector) => `${off} ${selector}`).join(",")} {animation:none !important;transition:none !important}`;
				document.head.appendChild(style);
				applyMotionPreference();
				uiMedia.addEventListener("change", applyMotionPreference);
				return () => { uiMedia.removeEventListener("change", applyMotionPreference); style.remove(); delete document.documentElement.dataset.dsgMotion; };
			}, "settings-groups: animation preference");
			const uiMotions = new Set(), uiLayers = new Set();
			const uiAnimate = (el, frames, options) => {
				if (!motionAllowed() || !el?.isConnected) return null;
				try {
					const motion = el.animate(frames, { duration: 200, easing: "cubic-bezier(.2,.7,.3,1)", ...options });
					uiMotions.add(motion);
					motion.finished.then(() => uiMotions.delete(motion), () => uiMotions.delete(motion));
					return motion;
				} catch (_ignored) { return null; }
			};
			const uiArrival = (el) => uiAnimate(el, [
				{ boxShadow: "inset 0 0 0 100px rgba(127,127,127,.15)" },
				{ boxShadow: "inset 0 0 0 100px rgba(127,127,127,0)" },
			], { id: "dsg-arrival", duration: 420 });
			ctx.effect(() => {
				const prune = () => { for (const layer of [...uiLayers]) if (!layer.owner.isConnected) layer.kill(); };
				const watch = new MutationObserver(prune);
				watch.observe(document.body, { childList: true, subtree: true });
				return () => {
					watch.disconnect();
					for (const motion of uiMotions) motion.cancel();
					uiMotions.clear();
					for (const layer of [...uiLayers]) layer.kill();
				};
			}, "settings-groups: interaction motion cleanup");

			/** 退出时继续留在原位置淡出；退出期间从焦点顺序和鼠标命中中移除。 */
			function MotionBox({ show, className, children, ...attrs }) {
				const [present, setPresent] = React.useState(show);
				const node = React.useRef(null), running = React.useRef(null), seen = React.useRef(false);
				React.useLayoutEffect(() => {
					if (show && !present) { setPresent(true); return; }
					const el = node.current;
					if (!el) { running.current?.cancel(); running.current = null; seen.current = false; return; }
					el.inert = !show;
					const cs = getComputedStyle(el);
					const from = running.current || seen.current ? { opacity: cs.opacity, transform: cs.transform } : { opacity: 0, transform: "translateY(-4px) scale(.985)" };
					running.current?.cancel();
					seen.current = true;
					const motion = uiAnimate(el, [from, { opacity: show ? 1 : 0, transform: show ? "none" : "translateY(-4px) scale(.985)" }], { id: "dsg-presence", duration: show ? 180 : 140, fill: "both" });
					running.current = motion;
					let live = true;
					const finish = () => {
						if (!live) return;
						if (!show) setPresent(false);
						else { motion?.cancel(); running.current = null; }
					};
					if (motion) motion.finished.then(finish, () => {}); else finish();
					return () => { live = false; };
				}, [show, present]);
				React.useEffect(() => () => running.current?.cancel(), []);
				return present ? h("div", { ...attrs, className, ref: node, "data-dsg-presence": show ? "in" : "out", "aria-hidden": show ? undefined : "true" }, children) : null;
			}

			const sceneKey = (el) => el.dataset.dsgEntry || el.dataset.dsgPin || el.dataset.dsgHidden
				? `entry:${el.dataset.dsgEntry ?? el.dataset.dsgPin ?? el.dataset.dsgHidden}`
				: el.dataset.dsgGid ? `group:${el.dataset.dsgGid}` : `bucket:${el.dataset.dsgBucket}`;
			const captureScene = (root, selector, keyOf = (el) => el) => {
				const box = root.getBoundingClientRect();
				let left = Math.max(0, box.left), top = Math.max(0, box.top), right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
				for (let parent = root.parentElement; parent; parent = parent.parentElement) {
					const style = getComputedStyle(parent), r = parent.getBoundingClientRect();
					if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
					if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
				}
				const scene = { root, rect: { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, items: new Map() };
				for (const el of root.querySelectorAll(selector)) {
					const rect = el.getBoundingClientRect();
					if (rect.height < 1 || rect.width < 1 || el.dataset.dsgPageDragging || el.dataset.dsgDragging) continue;
					const card = el.classList.contains("dsg-row") ? el.closest(".dsg-card") : null;
					scene.items.set(keyOf(el), { el, rect, parent: card ? keyOf(card) : null, opacity: getComputedStyle(el).opacity });
				}
				return scene;
			};
			const playScene = (before, after, { reorder = true, highlight = false } = {}) => {
				if (!motionAllowed() || !after.root.isConnected) return;
				for (const layer of [...uiLayers]) if (layer.owner === after.root) layer.kill();
				const gone = [];
				for (const [key, item] of before.items) {
					if (after.items.get(key)?.el === item.el || item.parent && !after.items.has(item.parent)) continue;
					if (Number(item.opacity) > .05) gone.push(item);
				}
				if (gone.length) {
					const layer = document.createElement("div");
					layer.dataset.dsgMotionLayer = "1"; layer.setAttribute("aria-hidden", "true"); layer.inert = true;
					const bounds = before.rect;
					Object.assign(layer.style, { position: "fixed", left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, overflow: "hidden", pointerEvents: "none", zIndex: "2147482000" });
					const clones = [];
					for (const item of gone) {
						const clone = item.el.cloneNode(true), r = item.rect;
						for (const el of [clone, ...clone.querySelectorAll("*")]) {
							el.removeAttribute("id");
							for (const attr of [...el.attributes]) if (attr.name.startsWith("data-dsg-")) el.removeAttribute(attr.name);
						}
						Object.assign(clone.style, { position: "absolute", left: `${r.left - bounds.left}px`, top: `${r.top - bounds.top}px`, width: `${r.width}px`, height: `${r.height}px`, minHeight: "0", margin: "0", boxSizing: "border-box", transform: "none", opacity: item.opacity, pointerEvents: "none" });
						if (item.el.dataset.dsgNest === "1") clone.style.setProperty("padding-left", "30px", "important");
						clone.style.setProperty("animation", "none", "important"); clone.style.setProperty("transition", "none", "important");
						layer.appendChild(clone); clones.push(clone);
					}
					document.body.appendChild(layer);
					const record = { owner: after.root, kill: null };
					let timer;
					const motions = clones.map((el) => uiAnimate(el, [{ opacity: el.style.opacity, transform: "none" }, { opacity: 0, transform: "translateY(-3px) scale(.985)" }], { id: "dsg-scene-exit", duration: 150, fill: "both" }));
					record.kill = () => { clearTimeout(timer); for (const motion of motions) motion?.cancel(); layer.remove(); uiLayers.delete(record); };
					uiLayers.add(record);
					Promise.all(motions.map((a) => a?.finished.catch(() => {}))).then(record.kill);
					timer = setTimeout(record.kill, 320);
				}
				for (const [key, item] of after.items) {
					const old = before.items.get(key);
					if (old?.el !== item.el) {
						if (item.parent && !before.items.has(item.parent)) continue;
						uiAnimate(item.el, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { id: "dsg-scene-enter", duration: 220 });
						if (highlight && item.el.classList.contains("dsg-row")) uiArrival(item.el);
					} else if (reorder) {
						const dx = old.rect.left - item.rect.left, dy = old.rect.top - item.rect.top;
						if (Math.abs(dx) > .5 || Math.abs(dy) > .5) uiAnimate(item.el, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { id: "dsg-search-reorder", duration: 200 });
					}
				}
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

			/**
			 * 顶部固定项的顺序。
			 *
			 * 这些是宿主自带的入口，不参与分组，但**顺序和显隐可以调** ——
			 * 显式记在 `coreOrder` 里，没记过的按台账 order 接在后面。
			 */
			const coreIds = () => {
				const alive = rowIds();
				const hidden = new Set(state.hidden);
				const out = [];
				for (const id of state.coreOrder) {
					if (!alive.has(id) || hidden.has(id) || !isCore(id) || out.includes(id)) continue;
					out.push(id);
				}
				const known = new Set(out);
				for (const r of rows) {
					if (!isCore(r.id) || hidden.has(r.id) || known.has(r.id)) continue;
					out.push(r.id);
				}
				return out;
			};

			/**
			 * 顶层顺序：核心项和分组**混排**在同一串里。
			 *
			 * 以前核心项和分组是两个独立数组，分组只能排在所有核心项之后 ——
			 * 所以「把分组拖到上面」永远落在核心区底下。现在只有这一份真相：
			 * `topOrder` 存 `c:<id>` / `g:<gid>`，没记过的按默认顺序补在末尾。
			 */
			const resolvedTopOrder = () => {
				const alive = rowIds();
				const hidden = new Set(state.hidden);
				const out = [];
				const seen = new Set();
				for (const token of state.topOrder) {
					if (typeof token !== "string" || token.length < 3) continue;
					const kind = token[0] === "c" ? "core" : token[0] === "g" ? "group" : "";
					const id = token.slice(2);
					if (kind === "core") {
						if (!alive.has(id) || hidden.has(id) || !isCore(id) || seen.has(token)) continue;
						seen.add(token);
						out.push({ kind, id });
					} else if (kind === "group") {
						if (!state.groups.some((g) => g.id === id) || seen.has(token)) continue;
						seen.add(token);
						out.push({ kind, id });
					}
				}
				for (const id of coreIds()) {
					const token = `c:${id}`;
					if (seen.has(token)) continue;
					seen.add(token);
					out.push({ kind: "core", id });
				}
				for (const g of state.groups) {
					const token = `g:${g.id}`;
					if (seen.has(token)) continue;
					seen.add(token);
					out.push({ kind: "group", id: g.id });
				}
				return out;
			};

			/** 把顶层顺序写回配置。 */
			const commitTopOrder = (list) => {
				state.topOrder = list.map((x) => `${x.kind === "core" ? "c" : "g"}:${x.id}`);
				state.coreOrder = list.filter((x) => x.kind === "core").map((x) => x.id);
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
				// 搜索框：细边框 + 放大镜，跟宿主导航项（前面都带图标）同一路子。
				// 早先是灰底方块，贴着顶边、还比下面的图标靠左，看着像误入的外来控件。
				".dsg-search{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;width:auto;margin:8px 6px}",
				".dsg-search-row{display:flex;align-items:center;gap:7px;box-sizing:border-box;height:30px;padding:0 11px;border-radius:8px;border:1px solid rgba(127,127,127,.2);background:transparent;transition:border-color .16s ease,background .16s ease}",
				// 聚焦要有「荧光」反馈，但颜色得跟宿主统一 —— 宿主是纯黑白灰，
				// 所以发光也做成灰的：边框压深 + 一圈向外扩散的淡灰 shadow，
				// 效果和之前的蓝光一样明显，只是不跳色。
				".dsg-search-row{transition:border-color .16s ease,box-shadow .2s ease,background .2s ease}",
				".dsg-search-row:hover{border-color:rgba(127,127,127,.34)}",
				".dsg-search-row:focus-within{border-color:rgba(127,127,127,.62);box-shadow:0 0 0 3px rgba(127,127,127,.13);background:rgba(127,127,127,.035)}",
				".dsg-search-icon{flex:none;opacity:.55;transition:opacity .16s ease}",
				".dsg-search-row:hover .dsg-search-icon{opacity:.75}",
				".dsg-search-row:focus-within .dsg-search-icon{opacity:.95}",
				".dsg-search-empty{padding:2px 2px 0;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#999)}",
				".dsg-search-input{flex:1;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:12.5px;line-height:28px;outline:none;padding:0}",
				".dsg-search-input::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}",
				".dsg-search-clear{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#999);font-family:inherit;font-size:11px;line-height:1;padding:0 2px;cursor:pointer;opacity:0;transition:opacity .15s ease}",
				".dsg-search[data-filled=\"1\"] .dsg-search-clear{opacity:.7}",
				".dsg-search[data-filled=\"1\"] .dsg-search-clear:hover{opacity:1}",
				// 搜索中：只留命中项。用 !important 压过行内的 display:none，
				// 所以收起的分组里命中的条目也会露出来，收完不用再手动展开。
				`[data-dsg-search=\"1\"] > button:not(.dsg-chip):not([data-dsg-hit=\"1\"]){display:none !important}`,
				`[data-dsg-search=\"1\"] > .dsg-chip:not([data-dsg-hit=\"1\"]){display:none !important}`,
				`[data-dsg-search=\"1\"] > button[data-dsg-hit=\"1\"]{display:flex !important}`,
				// —— 分组标签（chip）：比官方 item（40px）明显小一圈 ——
				// 层级要像 H1 压正文：分组标签比它下面的设置项更大、更粗、更深。
				// 之前 12px + 灰字，比宿主条目（14px + 图标）还轻，看着层级是反的。
				".dsg-chip{display:flex;align-items:center;gap:7px;box-sizing:border-box;width:100%;height:32px;margin:6px 0 2px;padding:0 9px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#2b2b2b);font-family:inherit;font-size:15px;line-height:32px;text-align:left;cursor:pointer;user-select:none;transition:background .15s ease,color .15s ease,transform .12s ease}",
				".dsg-chip:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#333)}",
				".dsg-chip:active{transform:scale(.97)}",
				".dsg-chip[aria-current=\"true\"]{color:var(--dsw-alias-label-primary,#333)}",
				// 小三角：细线 chevron（`>` 形状），展开时转成 `v`。
				// 用两条边框拼 L 形再转 -45°，比实心三角轻，跟宿主自己的展开箭头同一种观感。
				".dsg-caret{flex:none;display:inline-flex;align-items:center;justify-content:center;width:11px;height:11px;opacity:.7;transform-origin:50% 50%;transition:transform .34s cubic-bezier(.34,1.7,.5,1),opacity .22s ease}",
				".dsg-caret::before{content:\"\";display:block;width:5px;height:5px;border-right:1.7px solid currentColor;border-bottom:1.7px solid currentColor;border-radius:.5px;transform:rotate(-45deg);margin:0 0 0 -1px}",
				".dsg-chip:hover .dsg-caret{opacity:.95}",
				".dsg-chip[aria-expanded=\"true\"] .dsg-caret{transform:rotate(90deg) scale(1.15);opacity:1}",
				// 组内条目缩进一级：宿主按钮的 padding 是 12px，这里推到 30px，
				// 让它的图标落在分组标签文字的下方，层级一眼可见。
				"[data-dsg-item][data-dsg-nest=\"1\"]{padding-left:30px !important}",
				".dsg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;letter-spacing:.01em}",
				".dsg-count{flex:none;height:18px;line-height:18px;min-width:18px;text-align:center;padding:0 6px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary,#8a8a8a);font-size:11px;font-weight:500;opacity:.9}",
				".dsg-grip{flex:none;font-size:10px;opacity:0;cursor:grab;transition:opacity .15s ease}",
				".dsg-chip:hover .dsg-grip{opacity:.55}",
				"[data-dsg-sidebar-drag=\"0\"] .dsg-grip{opacity:0;cursor:inherit}",
				// —— 拖拽反馈 ——
				".dsg-chip[data-dsg-drop=\"into\"]{background:color-mix(in srgb, var(--dsg-accent,#4a7cf5) 15%, transparent);color:var(--dsg-accent,#4a7cf5);outline:1px solid color-mix(in srgb, var(--dsg-accent,#4a7cf5) 55%, transparent);outline-offset:-1px}",
				"[data-dsg-drop=\"before\"]{box-shadow:inset 0 2px 0 0 var(--dsg-accent,#4a7cf5)}",
				"[data-dsg-drop=\"after\"]{box-shadow:inset 0 -2px 0 0 var(--dsg-accent,#4a7cf5)}",
				"[data-dsg-dragging=\"1\"]{opacity:.4}",
				// —— 条目展开 / 收起：高度 + 淡入淡出 + 轻微位移 ——
				// height / padding / margin 也一起过渡，否则条目淡出后下面的内容
				// 会「啪」地往上跳一格（这才是收起动画最容易露馅的地方）。
				// 顺带把宿主原本的 hover 底色过渡带上，免得覆盖掉它自己那套手感。
				// 超出列表时滚动，避免 flex 再次压缩动画行高、结束时突然弹回。
				"[data-dsg-item]{flex-shrink:0;transform-origin:center top;transition:background-color .15s ease,color .15s ease}",
				// 只在动画那一下提层，平时不占合成层
				"[data-dsg-item][data-dsg-anim]{will-change:opacity,transform}",
				// 全部条目先批量测量，再统一写动画；尺寸与内边距同步，避免零高度被撑住。
				// 几何属性只走 keyframes，结束后不再触发第二段 transition。
				"@keyframes dsgItemIn{from{height:var(--dsg-from-h);padding-top:var(--dsg-from-pt);padding-bottom:var(--dsg-from-pb);margin-top:var(--dsg-from-mt);margin-bottom:var(--dsg-from-mb);opacity:var(--dsg-from-opacity);transform:var(--dsg-from-transform)}to{height:var(--dsg-h);padding-top:var(--dsg-pt);padding-bottom:var(--dsg-pb);margin-top:var(--dsg-mt);margin-bottom:var(--dsg-mb);opacity:1;transform:none}}",
				"@keyframes dsgItemOut{from{height:var(--dsg-from-h);padding-top:var(--dsg-from-pt);padding-bottom:var(--dsg-from-pb);margin-top:var(--dsg-from-mt);margin-bottom:var(--dsg-from-mb);opacity:var(--dsg-from-opacity);transform:var(--dsg-from-transform)}to{height:0;padding-top:0;padding-bottom:0;margin-top:0;margin-bottom:0;opacity:0;transform:translateY(-4px)}}",
				"[data-dsg-item][data-dsg-anim]{overflow:hidden;box-sizing:border-box;min-height:0 !important;contain:layout style}",
				"[data-dsg-item][data-dsg-anim=\"in\"]{animation:dsgItemIn .22s cubic-bezier(.2,.7,.3,1) both}",
				"[data-dsg-item][data-dsg-anim=\"out\"]{animation:dsgItemOut .2s cubic-bezier(.4,.6,.35,1) both}",
				"@media(prefers-reduced-motion:reduce){[data-dsg-item][data-dsg-anim]{animation-duration:.001ms}}",
				// —— 管理页 ——
				// 管理页是「我自己的页面」，可以用自己的设计语言（导航区还是得跟宿主灰调）：
				// 大圆角卡片 + 超大标题 + 浅灰子卡片 + 紫蓝强调色 + 状态徽章。
				// 强调色走宿主变量，深色主题自动跟着换。
				".dsg-page{overflow-anchor:none;--dsg-accent:var(--dsw-alias-state-info-primary,#5b5bf6);display:flex;flex-direction:column;gap:18px;box-sizing:border-box;width:100%;max-width:100%;min-width:0;font-size:14px}",
				".dsg-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 2px 8px}",
				".dsg-hero-left{display:flex;align-items:flex-start;gap:12px;min-width:0}",
				".dsg-hero-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px;background:color-mix(in srgb, var(--dsg-accent,#5b5bf6) 11%, transparent);color:var(--dsg-accent,#5b5bf6)}",
				".dsg-hero-title{margin:0;font-size:21px;line-height:28px;font-weight:700;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,#1f1f22)}",
				".dsg-hero-sub{margin:5px 0 0;font-size:13.5px;line-height:20px;color:var(--dsw-alias-label-secondary,#8a8a8a)}",
				".dsg-hero-tag{flex:none;margin-top:6px;font-size:13px;line-height:18px;font-weight:600;color:var(--dsg-accent)}",
				".dsg-subcard{display:flex;flex-direction:column;gap:6px;padding:16px 18px;border-radius:13px;background:rgba(127,127,127,.055);box-shadow:inset 0 1px 2px rgba(0,0,0,.03)}",
				".dsg-card{display:flex;flex-direction:column;gap:14px;padding:20px 22px;border-radius:16px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid rgba(127,127,127,.1);box-shadow:0 1px 2px rgba(0,0,0,.05),0 6px 20px -6px rgba(0,0,0,.1)}",
				".dsg-card[data-over=\"1\"]{border-color:var(--dsg-accent,#5b5bf6);background:color-mix(in srgb, var(--dsg-accent,#5b5bf6) 5%, transparent)}",
				".dsg-card[draggable=\"true\"]{cursor:grab;transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .16s ease,opacity .16s ease,border-color .15s ease}",
				".dsg-card[draggable=\"true\"]:active{cursor:grabbing}",
				// 「攥在手里」：抬起来一点、微微歪、阴影加重、整体压暗一丝
				".dsg-card[data-dragging=\"1\"]{cursor:grabbing;position:relative;z-index:3;transform:scale(1.014) rotate(-.18deg);box-shadow:0 4px 10px rgba(0,0,0,.09),0 20px 44px -14px rgba(0,0,0,.22);opacity:.94}",
				".dsg-card[data-insert=\"before\"]{box-shadow:inset 0 3px 0 -1px var(--dsg-accent,#5b5bf6),0 1px 2px rgba(0,0,0,.05),0 6px 20px -6px rgba(0,0,0,.1)}",
				".dsg-card[data-insert=\"after\"]{box-shadow:inset 0 -3px 0 -1px var(--dsg-accent,#5b5bf6),0 1px 2px rgba(0,0,0,.05),0 6px 20px -6px rgba(0,0,0,.1)}",
				// 卡片之间单独拉开：只影响"卡→卡"，别把"标题→第一张卡"也一起推远
				".dsg-section > .dsg-card{margin-bottom:10px}",
				".dsg-section > .dsg-card:last-child{margin-bottom:0}",
				".dsg-cardhead{position:relative;display:flex;align-items:center;gap:8px;min-width:0;padding-right:8px}",
				// 删除确认气泡：挂在卡片头下方，就地询问，不弹系统 confirm
				".dsg-confirm{position:absolute;right:0;top:calc(100% + 10px);z-index:6;width:238px;max-width:calc(100vw - 32px);padding:13px 15px;border-radius:12px;border:1px solid rgba(127,127,127,.16);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 14px 36px -10px rgba(0,0,0,.24)}",
				"[data-dsg-presence=\"out\"]{pointer-events:none !important}",
				".dsg-title-stage{display:grid;flex:1;min-width:0}",
				".dsg-title-view{display:flex;position:relative;align-items:center;gap:8px;min-width:0;grid-area:1/1}",
				".dsg-feedback{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:30;max-width:calc(100% - 32px);pointer-events:none}",
				".dsg-toast{padding:9px 15px;border:1px solid rgba(127,127,127,.2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#333);box-shadow:0 6px 20px rgba(0,0,0,.12);font-size:13px;line-height:20px;overflow-wrap:anywhere}",
				".dsg-confirm-text{margin:0 0 11px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-confirm-actions{display:flex;gap:8px;justify-content:flex-end}",
				".dsg-confirm-danger{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}",
				".dsg-confirm-danger:hover{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;opacity:.88}",
				".dsg-cardname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-cardcount{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#999)}",
				// 操作按钮统一细边框；透明底沿用行背景，悬浮时加深边框与图标。
				".dsg-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;padding:0 9px;border:1px solid rgba(127,127,127,.3);border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-family:inherit;font-size:12.5px;line-height:1;cursor:pointer;transition:border-color .14s ease,color .14s ease,transform .1s ease}",
				".dsg-btn:hover{border-color:rgba(127,127,127,.55);background:transparent;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-btn:focus-visible{outline:2px solid var(--dsg-accent,#5b5bf6);outline-offset:2px}",
				".dsg-btn:active{transform:scale(.94)}",
				".dsg-btn[disabled]{opacity:.28;cursor:default;background:transparent;color:var(--dsw-alias-label-tertiary,#9a9a9a)}",
				// 纯图标按钮：正方形，图标靠字符，圆角 7px（不要方角）
				".dsg-icon{width:28px;height:28px;padding:0;font-size:13px}",
				".dsg-btn-ghost{background:transparent;color:var(--dsw-alias-label-tertiary,#9a9a9a)}",
				".dsg-btn-ghost:hover{background:transparent;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 40%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d)}",
				// 删除：平时红图标，悬浮翻成红底白字（主人明确要这个反色）
				".dsg-danger:hover,.dsg-btn.dsg-danger:hover{border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}",
				".dsg-rows{display:flex;flex-direction:column;gap:2px}",
				".dsg-pin,[data-dsg-entry]{cursor:grab;user-select:none}",
				".dsg-rowgrip{touch-action:none}",
				"[data-dsg-page-dragging=\"1\"]{opacity:.25}",
				".dsg-pin:active{cursor:grabbing}",
				".dsg-row{display:flex;align-items:center;gap:8px;min-height:34px;padding:4px 8px;border-radius:7px;color:var(--dsw-alias-label-primary,#333);transition:background .12s ease,opacity .12s ease}",
				".dsg-row:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.1))}",
				".dsg-row[data-dragging=\"1\"]{opacity:.35}",
				".dsg-row[data-over=\"before\"]{box-shadow:inset 0 2px 0 0 var(--dsg-accent,#4a7cf5)}",
				".dsg-row[data-over=\"after\"]{box-shadow:inset 0 -2px 0 0 var(--dsg-accent,#4a7cf5)}",
				".dsg-row[data-stale=\"1\"]{opacity:.55}",
				".dsg-row[data-stale=\"1\"] .dsg-rowname{text-decoration:line-through}",
				".dsg-rowgrip{flex:none;width:13px;color:var(--dsw-alias-label-tertiary,#aaa);cursor:grab;font-size:11px;text-align:center}",
				".dsg-rowname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}",
				// 跟搜索框同一套反馈：悬浮加深边框，聚焦加深 + 灰色荧光圈
				".dsg-input{box-sizing:border-box;flex:1;min-width:0;height:34px;padding:0 11px;border-radius:8px;border:1px solid rgba(127,127,127,.26);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:13.5px;transition:border-color .16s ease,box-shadow .2s ease}",
				".dsg-input:hover{border-color:rgba(127,127,127,.4)}",
				".dsg-input:focus{outline:none;border-color:rgba(127,127,127,.62);box-shadow:0 0 0 3px rgba(127,127,127,.13)}",
				// 「新建」得像个按钮：有边框、跟输入框同高。之前用 .dsg-btn（透明底）看着像超链接
				".dsg-new{display:flex;gap:8px;align-items:center}",
				".dsg-create{flex:none;height:34px;padding:0 15px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#333);font-family:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer;transition:border-color .15s ease,background .15s ease,transform .1s ease}",
				".dsg-create:hover{border-color:rgba(127,127,127,.52);background:rgba(127,127,127,.06)}",
				".dsg-create:active{transform:scale(.97)}",
				".dsg-create[disabled]{opacity:.38;cursor:default;border-color:rgba(127,127,127,.2);background:transparent}",
				".dsg-new{display:flex;gap:8px;align-items:center}",
				// 自定义下拉：按钮 + 浮层，跟 chip 同一套灰调，不用原生 select
				".dsg-picker{position:relative;flex:none}",
				".dsg-picker-btn{display:flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid rgba(127,127,127,.26);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:12.5px;line-height:1;cursor:pointer;transition:border-color .15s ease,color .15s ease}",
				".dsg-picker-btn:hover{border-color:rgba(127,127,127,.45);color:var(--dsw-alias-label-primary,#333)}",
				".dsg-picker-btn[aria-expanded=\"true\"]{border-color:rgba(127,127,127,.52);color:var(--dsw-alias-label-primary,#333)}",
				".dsg-picker-caret{width:4px;height:4px;border-right:1.4px solid currentColor;border-bottom:1.4px solid currentColor;transform:rotate(45deg) translateY(-1px);opacity:.7;transition:transform .16s ease}",
				".dsg-picker-btn[aria-expanded=\"true\"] .dsg-picker-caret{transform:rotate(-135deg) translateY(-1px)}",
				".dsg-picker-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:12;display:flex;flex-direction:column;gap:1px;min-width:112px;max-height:240px;overflow-y:auto;padding:3px;border-radius:8px;border:1px solid rgba(127,127,127,.18);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.14)}",
				"@keyframes dsgMenuIn{from{opacity:0;transform:translateY(-5px) scale(.97)}to{opacity:1;transform:none}}",
				".dsg-picker-item{border:none;background:transparent;text-align:left;padding:6px 10px;border-radius:5px;font-family:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#333);cursor:pointer;white-space:nowrap}",
				".dsg-picker-item:hover{background:rgba(127,127,127,.11)}",
				".dsg-status{display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:12px;background:rgba(127,127,127,.055);box-shadow:0 1px 2px rgba(0,0,0,.03),0 4px 12px -6px rgba(0,0,0,.06);font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary,#8a8a8a)}",
				".dsg-status-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsg-accent,#5b5bf6)}",
				".dsg-hint{margin:0;color:var(--dsw-alias-label-secondary,#999);font-size:12.5px;line-height:19px}",
				".dsg-warn{margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f5a524) 12%, transparent);color:var(--dsw-alias-state-warn-primary,#b8770b);font-size:12px;line-height:18px}",
				".dsg-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}",
				".dsg-toggletext{display:flex;flex-direction:column;gap:2px;min-width:0}",
				".dsg-toggletitle{font-size:14px;color:var(--dsw-alias-label-primary,#333)}",
				".dsg-switch{flex:none;position:relative;width:42px;height:24px;border-radius:999px;border:none;background:rgba(127,127,127,.32);cursor:pointer;padding:0;transition:background .2s ease}",
				".dsg-switch[data-on=\"1\"]{background:var(--dsg-accent,#5b5bf6)}",
				".dsg-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .2s cubic-bezier(.22,.8,.28,1)}",
				".dsg-switch[data-on=\"1\"] .dsg-knob{transform:translateX(18px)}",
				".dsg-section{display:flex;flex-direction:column;gap:8px}",
				".dsg-sectionhead{display:flex;align-items:baseline;gap:8px}",
				".dsg-sectiontitle{font-size:12.5px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#888);text-transform:uppercase}",
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
			const searchQueries = new WeakMap();

			const makeSearchBox = () => {
				const wrap = document.createElement("div");
				wrap.className = "dsg-search";
				wrap.dataset.dsgSearchBox = "1";
				const row = document.createElement("div");
				row.className = "dsg-search-row";
				// 放大镜：跟宿主导航项那些图标一样走细线条，别用 emoji
				const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				icon.setAttribute("class", "dsg-search-icon");
				icon.setAttribute("viewBox", "0 0 16 16");
				icon.setAttribute("width", "13");
				icon.setAttribute("height", "13");
				icon.setAttribute("aria-hidden", "true");
				icon.innerHTML = '<circle cx="6.9" cy="6.9" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.2 10.2 13.7 13.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
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
				row.append(icon, input, clear);
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
				const q = searchQuery.trim().toLowerCase();
				const before = motionAllowed() && searchQueries.has(nav) && searchQueries.get(nav) !== q ? captureScene(nav, ":scope > button") : null;
				searchQueries.set(nav, q);
				if (before) for (const motion of uiMotions) if (nav.contains(motion.effect?.target) && ["dsg-search-reorder", "dsg-scene-enter"].includes(motion.id)) motion.cancel();
				const finish = () => { if (before) playScene(before, captureScene(nav, ":scope > button")); };
				for (const el of nav.querySelectorAll("[data-dsg-hit]")) delete el.dataset.dsgHit;
				const emptyHint = searchBox === null ? null : searchBox.querySelector(".dsg-search-empty");
				if (q === "") {
					delete nav.dataset.dsgSearch;
					if (emptyHint !== null) emptyHint.style.display = "none";
					finish();
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
				finish();
			};

			// ---- chip 构建 ----
			/** 拖动结束时紧跟着的那次 click 要吞掉，否则会顺带切换展开态。 */
			let suppressChipClick = false;
			/** 只保留当前导航拖动，关闭开关时连待触发的长按一起取消。 */
			let navDragCleanup = null;
			const sidebarDragAllowed = () => state.enabled && state.sidebarDrag && !legacyRunning();

			/**
			 * 手机桌面式拖动：按住配置的等待时间（默认 250ms）浮起 → 克隆一份跟着指针 → 经过别处实时让位 → 松手落位。
			 *
			 * 为什么不用 HTML5 DnD：它的拖拽预览是浏览器自己画的（半透明截图），
			 * 没法做成"拿在手里"的样子；而且只有 drop 时才允许改 DOM，
			 * 想要"经过哪儿哪儿就挪开"根本做不到。
			 */
			const bindChipPointerDrag = (el, gid) => {
				let timer = 0;
				let startX = 0;
				let startY = 0;
				let ghost = null;
				let grabX = 0;
				let grabY = 0;
				let lastKey = "\u0000";
				let dragging = false;
				/** 拖动前这个分组是不是展开的 —— 松手要还原回去。 */
				let wasOpen = false;

				const cleanup = () => {
					if (navDragCleanup === cleanup) navDragCleanup = null;
					if (timer !== 0) {
						clearTimeout(timer);
						timer = 0;
					}
					if (ghost !== null) {
						ghost.remove();
						ghost = null;
					}
					if (wasOpen) {
						wasOpen = false;
						const g = groupById(gid);
						if (g !== undefined) {
							g.open = true;
							sync();
						}
					}
					el.style.opacity = "";
					document.body.style.cursor = "";
					document.removeEventListener("pointermove", onMove, true);
					document.removeEventListener("pointerup", onUp, true);
					document.removeEventListener("pointercancel", onUp, true);
					clearDropMarks();
					if (dragging) {
						suppressChipClick = true;
						setTimeout(() => {
							suppressChipClick = false;
						}, 0);
					}
					dragging = false;
				};

				function cancelTimer() { cleanup(); }

				/** 指针下面是什么：另一个分组，或某个核心项。 */
				const hitAt = (x, y) => {
					const raw = document.elementFromPoint(x, y);
					if (raw === null) return null;
					const chip = raw.closest?.(".dsg-chip");
					if (chip !== null && chip !== undefined) {
						if (chip === el) return null;
						if (chip.dataset.dsgChip === "loose") return null;
						const rect = chip.getBoundingClientRect();
						return { gid: chip.dataset.dsgGid, after: y > rect.top + rect.height / 2 };
					}
					const btn = raw.closest?.("button");
					if (btn !== null && btn !== undefined) {
						const id = buttonId(btn);
						if (id !== undefined && isCore(id) && !state.hidden.includes(id)) {
							const rect = btn.getBoundingClientRect();
							return { coreId: id, after: y > rect.top + rect.height / 2 };
						}
					}
					return null;
				};

				const onMove = (e) => {
					if (!dragging) {
						// 未到等待时间就移动了 → 当点击/滚动，取消长按
						if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) cancelTimer();
						return;
					}
					e.preventDefault();
					if (ghost !== null) {
						ghost.style.transform = `translate3d(${Math.round(e.clientX - grabX)}px, ${Math.round(e.clientY - grabY)}px, 0) scale(1.04) rotate(-.4deg)`;
					}
					const hit = hitAt(e.clientX, e.clientY);
					const key = hit === null ? "" : `${hit.gid ?? hit.coreId}:${hit.after}`;
					if (key === lastKey) return;
					lastKey = key;
					if (hit === null) {
						clearDropMarks();
						return;
					}
					// 实时让位：每次落点变化才真的重排一次（不是每帧）
					const before = snapshotRects();
					moveGroupTo(gid, hit);
					sync();
					flipRects(before);
				};

				const onUp = () => cleanup();

				el.addEventListener("pointerdown", (e) => {
					if (!sidebarDragAllowed() || e.button !== 0 || gid === undefined) return;
					navDragCleanup?.();
					navDragCleanup = cleanup;
					startX = e.clientX;
					startY = e.clientY;
					if (timer !== 0) clearTimeout(timer);
					document.addEventListener("pointermove", onMove, true);
					document.addEventListener("pointerup", onUp, true);
					document.addEventListener("pointercancel", onUp, true);
					timer = setTimeout(() => {
						timer = 0;
						if (!el.isConnected || !sidebarDragAllowed()) { cleanup(); return; }
						dragging = true;
						// 抓起来的那个分组先合上：展开着的话它是"标签 + 一整排条目"，
						// 拿在手里太臃肿，也让落点判断更乱。松手再还原。
						const dragged = groupById(gid);
						if (dragged !== undefined && dragged.open !== false) {
							wasOpen = true;
							dragged.open = false;
							sync();
						}
						const rect = el.getBoundingClientRect();
						grabX = startX - rect.left;
						grabY = startY - rect.top;
						ghost = el.cloneNode(true);
						ghost.removeAttribute("draggable");
						ghost.removeAttribute("data-dsg-gid");
						Object.assign(ghost.style, {
							position: "fixed",
							left: "0px",
							top: "0px",
							width: `${Math.round(rect.width)}px`,
							height: `${Math.round(rect.height)}px`,
							margin: "0",
							pointerEvents: "none",
							zIndex: "2147483000",
							transform: `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0) scale(1.04) rotate(-.4deg)`,
							transformOrigin: "center center",
							boxShadow: "0 12px 32px rgba(0,0,0,.24)",
							borderRadius: "9px",
							background: "var(--dsw-alias-bg-layer-1, #fff)",
							transition: "none",
						});
						ghost.dataset.dsgFloating = "1";
						document.body.appendChild(ghost);
						el.style.opacity = "0.22";
						document.body.style.cursor = "grabbing";
						lastKey = "\u0000";
					}, state.sidebarDragDelay);
				});
			};

			/**
			 * 管理页卡片的同款拖拽：长按浮起 → 跟手 → 经过别的卡片实时让位。
			 * 跟导航那套共用一个思路，只是落点判定换成"卡片的上下半区"。
			 */
			const bindCardPointerDrag = (el, gid) => {
				if (el.dataset.dsgPtrBound === "1") return;
				el.dataset.dsgPtrBound = "1";
				let timer = 0;
				let startX = 0;
				let startY = 0;
				let ghost = null;
				let grabX = 0;
				let grabY = 0;
				let lastKey = "\u0000";
				let dragging = false;

				const cleanup = () => {
					if (timer !== 0) {
						clearTimeout(timer);
						timer = 0;
					}
					if (ghost !== null) {
						ghost.remove();
						ghost = null;
					}
					el.style.opacity = "";
					document.body.style.cursor = "";
					document.removeEventListener("pointermove", onMove, true);
					document.removeEventListener("pointerup", onUp, true);
					document.removeEventListener("pointercancel", onUp, true);
					document.removeEventListener("pointerup", cancelTimer, true);
					dragging = false;
				};

				function cancelTimer() {
					if (timer !== 0) {
						clearTimeout(timer);
						timer = 0;
					}
					document.removeEventListener("pointerup", cancelTimer, true);
				}

				const hitAt = (x, y) => {
					const raw = document.elementFromPoint(x, y);
					if (raw === null) return null;
					const card = raw.closest?.(".dsg-card");
					if (card === null || card === undefined || card === el) return null;
					const nameEl = card.querySelector(".dsg-cardname");
					if (nameEl === null) return null;
					const target = resolvedTopOrder()
						.filter((x2) => x2.kind === "group")
						.map((x2) => groupById(x2.id))
						.find((g2) => g2 !== undefined && g2.name === nameEl.textContent);
					if (target === undefined) return null;
					const rect = card.getBoundingClientRect();
					return { gid: target.id, after: y > rect.top + rect.height / 2 };
				};

				const onMove = (e) => {
					if (!dragging) {
						if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) cancelTimer();
						return;
					}
					e.preventDefault();
					if (ghost !== null) {
						ghost.style.transform = `translate3d(${Math.round(e.clientX - grabX)}px, ${Math.round(e.clientY - grabY)}px, 0) scale(1.012) rotate(-.18deg)`;
					}
					const hit = hitAt(e.clientX, e.clientY);
					const key = hit === null ? "" : `${hit.gid}:${hit.after}`;
					if (key === lastKey) return;
					lastKey = key;
					if (hit === null) return;
					moveGroupTo(gid, hit);
					notifyPage();
				};

				const onUp = () => cleanup();

				el.addEventListener("pointerdown", (e) => {
					if (e.button !== 0) return;
					// 分区：卡片头拖整组，组内条目行走它们自己的拖拽。
					// 不排除的话按在条目上会冒泡到这里，整个分组被拎起来。
					if (e.target.closest(".dsg-row, button, input, .dsg-picker") !== null) return;
					startX = e.clientX;
					startY = e.clientY;
					if (timer !== 0) clearTimeout(timer);
					document.addEventListener("pointerup", cancelTimer, true);
					timer = setTimeout(() => {
						timer = 0;
						dragging = true;
						const rect = el.getBoundingClientRect();
						grabX = startX - rect.left;
						grabY = startY - rect.top;
						ghost = el.cloneNode(true);
						Object.assign(ghost.style, {
							position: "fixed",
							left: "0px",
							top: "0px",
							width: `${Math.round(rect.width)}px`,
							pointerEvents: "none",
							zIndex: "2147483000",
							transform: `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0) scale(1.012) rotate(-.18deg)`,
							transformOrigin: "center center",
							boxShadow: "0 4px 10px rgba(0,0,0,.1), 0 24px 48px -16px rgba(0,0,0,.26)",
							transition: "none",
						});
						ghost.dataset.dsgFloating = "1";
						document.body.appendChild(ghost);
						el.style.opacity = "0.25";
						document.body.style.cursor = "grabbing";
						lastKey = "\u0000";
						document.addEventListener("pointermove", onMove, true);
						document.addEventListener("pointerup", onUp, true);
						document.addEventListener("pointercancel", onUp, true);
					}, 250);
				});
			};

			/** 顶部固定项的手指拖拽：跟分组标签同一套，只是被拖的是一整行按钮。 */
			const bindCorePointerDrag = (el, id) => {
				if (el.dataset.dsgPtrBound === "1") return;
				el.dataset.dsgPtrBound = "1";
				let timer = 0;
				let startX = 0;
				let startY = 0;
				let ghost = null;
				let grabX = 0;
				let grabY = 0;
				let lastKey = "\u0000";
				let dragging = false;

				const cleanup = () => {
					if (navDragCleanup === cleanup) navDragCleanup = null;
					if (timer !== 0) {
						clearTimeout(timer);
						timer = 0;
					}
					if (ghost !== null) {
						ghost.remove();
						ghost = null;
					}
					el.style.opacity = "";
					document.body.style.cursor = "";
					document.removeEventListener("pointermove", onMove, true);
					document.removeEventListener("pointerup", onUp, true);
					document.removeEventListener("pointercancel", onUp, true);
					clearDropMarks();
					dragging = false;
				};

				function cancelTimer() { cleanup(); }

				const hitAt = (x, y) => {
					const raw = document.elementFromPoint(x, y);
					if (raw === null) return null;
					const chip = raw.closest?.(".dsg-chip");
					if (chip !== null && chip !== undefined) {
						if (chip.dataset.dsgChip === "loose") return null;
						const rect = chip.getBoundingClientRect();
						return { gid: chip.dataset.dsgGid, after: y > rect.top + rect.height / 2 };
					}
					const btn = raw.closest?.("button");
					if (btn !== null && btn !== undefined && btn !== el) {
						const other = buttonId(btn);
						if (other !== undefined && isCore(other) && !state.hidden.includes(other)) {
							const rect = btn.getBoundingClientRect();
							return { coreId: other, after: y > rect.top + rect.height / 2 };
						}
					}
					return null;
				};

				const onMove = (e) => {
					if (!dragging) {
						if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) cancelTimer();
						return;
					}
					e.preventDefault();
					if (ghost !== null) {
						ghost.style.transform = `translate3d(${Math.round(e.clientX - grabX)}px, ${Math.round(e.clientY - grabY)}px, 0) scale(1.02)`;
					}
					const hit = hitAt(e.clientX, e.clientY);
					const key = hit === null ? "" : `${hit.gid ?? hit.coreId}:${hit.after}`;
					if (key === lastKey) return;
					lastKey = key;
					if (hit === null) return;
					const before = snapshotRects();
					moveCoreTo(id, hit);
					sync();
					flipRects(before);
				};

				const onUp = () => cleanup();

				el.addEventListener("pointerdown", (e) => {
					if (!sidebarDragAllowed() || e.button !== 0) return;
					navDragCleanup?.();
					navDragCleanup = cleanup;
					startX = e.clientX;
					startY = e.clientY;
					if (timer !== 0) clearTimeout(timer);
					document.addEventListener("pointermove", onMove, true);
					document.addEventListener("pointerup", onUp, true);
					document.addEventListener("pointercancel", onUp, true);
					timer = setTimeout(() => {
						timer = 0;
						if (!el.isConnected || !sidebarDragAllowed()) { cleanup(); return; }
						dragging = true;
						const rect = el.getBoundingClientRect();
						grabX = startX - rect.left;
						grabY = startY - rect.top;
						ghost = el.cloneNode(true);
						ghost.removeAttribute("draggable");
						ghost.removeAttribute("data-dsg-id");
						Object.assign(ghost.style, {
							position: "fixed",
							left: "0px",
							top: "0px",
							width: `${Math.round(rect.width)}px`,
							height: `${Math.round(rect.height)}px`,
							margin: "0",
							pointerEvents: "none",
							zIndex: "2147483000",
							transform: `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0) scale(1.02)`,
							transformOrigin: "center center",
							boxShadow: "0 10px 28px rgba(0,0,0,.2)",
							borderRadius: "9px",
							background: "var(--dsw-alias-bg-layer-1, #fff)",
							transition: "none",
						});
						ghost.dataset.dsgFloating = "1";
						document.body.appendChild(ghost);
						el.style.opacity = "0.22";
						document.body.style.cursor = "grabbing";
						lastKey = "\u0000";
					}, state.sidebarDragDelay);
				});
			};

			// 管理页条目与固定项共用手指拖动；文档监听跟随指针，不受 React 跨组重建影响。
			let pageRowDrag = null;
			const bindPageRowDrag = (el, id, pinned = false) => {
				if (pageRowDrag?.id === id && pageRowDrag.pinned === pinned && pageRowDrag.active) el.dataset.dsgPageDragging = "1";
				if (el.dataset.dsgPagePtrBound === "1") return;
				el.dataset.dsgPagePtrBound = "1";
				el.addEventListener("pointerdown", (down) => {
					if (down.button !== 0 || down.target.closest("button,input,a,select,textarea,.dsg-picker")) return;
					pageRowDrag?.cleanup();
					down.stopPropagation();
					const startX = down.clientX, startY = down.clientY;
					const grip = down.target.closest(".dsg-rowgrip") !== null;
					let timer = 0, ghost = null, grabX = 0, grabY = 0, lastKey = "";
					let scrollHost = el.parentElement, scrollFrame = null;
					let point = { x: startX, y: startY };
					while (scrollHost && !(scrollHost.scrollHeight > scrollHost.clientHeight && /auto|scroll/.test(getComputedStyle(scrollHost).overflowY))) scrollHost = scrollHost.parentElement;
					const current = { id, pinned, active: false, cleanup: null };
					const cleanup = () => {
						clearTimeout(timer);
						if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
						ghost?.remove();
						for (const row of document.querySelectorAll("[data-dsg-page-dragging]")) delete row.dataset.dsgPageDragging;
						if (current.active) uiArrival([...document.querySelectorAll(".dsg-page [data-dsg-entry],.dsg-page [data-dsg-pin],.dsg-page [data-dsg-hidden]")].find((row) => (row.dataset.dsgEntry ?? row.dataset.dsgPin ?? row.dataset.dsgHidden) === id));
						document.body.style.cursor = "";
						document.removeEventListener("pointermove", move, true);
						document.removeEventListener("pointerup", up, true);
						document.removeEventListener("pointercancel", up, true);
						window.removeEventListener("blur", cleanup);
						if (pageRowDrag === current) pageRowDrag = null;
					};
					current.cleanup = cleanup;
					pageRowDrag = current;
					const lift = () => {
						clearTimeout(timer);
						if (current.active || !el.isConnected) return;
						current.active = true;
						const rect = el.getBoundingClientRect();
						grabX = startX - rect.left; grabY = startY - rect.top;
						ghost = el.cloneNode(true);
						ghost.removeAttribute("id");
						for (const child of ghost.querySelectorAll("[id]")) child.removeAttribute("id");
						ghost.dataset.dsgRowFloating = "1";
						ghost.setAttribute("aria-hidden", "true");
						ghost.inert = true;
						Object.assign(ghost.style, { position: "fixed", left: "0px", top: "0px", width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", pointerEvents: "none", zIndex: "2147483000", transformOrigin: "center", boxShadow: "0 8px 22px rgba(0,0,0,.16)", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-1,#fff)", transition: "none" });
						document.body.appendChild(ghost);
						el.dataset.dsgPageDragging = "1";
						document.body.style.cursor = "grabbing";
					};
					const moveAt = (x, y) => {
						if (!ghost) return;
						ghost.style.transform = `translate3d(${Math.round(x - grabX)}px,${Math.round(y - grabY)}px,0) scale(1.01)`;
						const raw = document.elementFromPoint(x, y);
						if (!raw?.closest(".dsg-page")) return;
						const row = raw.closest("[data-dsg-pin], [data-dsg-entry]");
						let key = "", action = null;
						if (pinned) {
							const other = row?.dataset.dsgPin;
							if (other && other !== id) {
								const r = row.getBoundingClientRect(), after = y > r.top + r.height / 2;
								key = `p:${other}:${after}`;
								action = () => moveCoreTo(id, { coreId: other, after });
							}
						} else {
							const other = row?.dataset.dsgEntry;
							let where = null, hide = false;
							if (other && other !== id) {
								const r = row.getBoundingClientRect(), after = y > r.top + r.height / 2;
								const gid = groupOf(other)?.id;
								where = { gid, anchorGid: gid, [after ? "after" : "before"]: other };
								key = `r:${other}:${after}`;
							} else if (!row) {
								const card = raw.closest("[data-dsg-gid], [data-dsg-bucket]");
								if (card?.dataset.dsgGid) { where = { gid: card.dataset.dsgGid, anchorGid: card.dataset.dsgGid }; key = `g:${where.gid}`; }
								else if (card?.dataset.dsgBucket === "loose") { where = {}; key = "loose"; }
								else if (card?.dataset.dsgBucket === "hidden") { hide = true; key = "hidden"; }
							}
							if (where || hide) action = () => {
								const before = snapshotPage();
								if (hide) hideEntry(id); else place(id, where);
								save(); flipPage(before);
							};
						}
						if (key === lastKey) return;
						lastKey = key;
						if (action) { action(); sync(); notifyPage(); }
					};
					const scroll = () => {
						scrollFrame = null;
						if (!current.active || !scrollHost) return;
						const rect = scrollHost.getBoundingClientRect();
						const delta = point.y < rect.top + 32 ? -12 : point.y > rect.bottom - 32 ? 12 : 0;
						const before = scrollHost.scrollTop;
						scrollHost.scrollTop += delta;
						if (scrollHost.scrollTop !== before) {
							moveAt(point.x, point.y);
							scrollFrame = requestAnimationFrame(scroll);
						}
					};
					const move = (event) => {
						if (event.pointerId !== down.pointerId) return;
						point = { x: event.clientX, y: event.clientY };
						if (!current.active && Math.hypot(point.x - startX, point.y - startY) > 6) {
							if (down.pointerType === "touch" && !grip) { cleanup(); return; }
							lift();
						}
						if (!current.active) return;
						event.preventDefault();
						moveAt(point.x, point.y);
						if (scrollFrame === null) scrollFrame = requestAnimationFrame(scroll);
					};
					const up = (event) => {
						if (event.pointerId !== down.pointerId) return;
						if (current.active) event.preventDefault();
						cleanup();
					};
					document.addEventListener("pointermove", move, { capture: true, passive: false });
					document.addEventListener("pointerup", up, true);
					document.addEventListener("pointercancel", up, true);
					window.addEventListener("blur", cleanup);
					timer = setTimeout(() => { lift(); moveAt(point.x, point.y); }, 250);
				});
			};
			const bindPinnedPointerDrag = (el, id) => bindPageRowDrag(el, id, true);

			/**
			 * 设置条目（导航里的小行）的手指拖拽。
			 * 跟核心项同一套手感，但落点更多：落到分组标签上 = 归组，落到未分组 = 移出，
			 * 落到另一个条目上 = 在它旁边排序（组内或未分组内）。
			 */
			const bindItemPointerDrag = (el, id) => {
				if (el.dataset.dsgPtrBound === "1") return;
				el.dataset.dsgPtrBound = "1";
				let timer = 0;
				let startX = 0;
				let startY = 0;
				let ghost = null;
				let grabX = 0;
				let grabY = 0;
				let lastKey = "\u0000";
				let dragging = false;

				const cleanup = () => {
					if (navDragCleanup === cleanup) navDragCleanup = null;
					if (timer !== 0) {
						clearTimeout(timer);
						timer = 0;
					}
					if (ghost !== null) {
						ghost.remove();
						ghost = null;
					}
					el.style.opacity = "";
					document.body.style.cursor = "";
					document.removeEventListener("pointermove", onMove, true);
					document.removeEventListener("pointerup", onUp, true);
					document.removeEventListener("pointercancel", onUp, true);
					clearDropMarks();
					dragging = false;
				};

				function cancelTimer() { cleanup(); }

				const hitAt = (x, y) => {
					const raw = document.elementFromPoint(x, y);
					if (raw === null) return null;
					const chip = raw.closest?.(".dsg-chip");
					if (chip !== null && chip !== undefined) {
						if (chip.dataset.dsgChip === "loose") return { kind: "loose" };
						const rect = chip.getBoundingClientRect();
						return { kind: "chip", gid: chip.dataset.dsgGid, after: y > rect.top + rect.height / 2 };
					}
					const btn = raw.closest?.("button");
					if (btn !== null && btn !== undefined && btn !== el) {
						const other = buttonId(btn);
						if (other !== undefined && !isCore(other) && !state.hidden.includes(other)) {
							const rect = btn.getBoundingClientRect();
							const g = groupOf(other);
							return { kind: "item", id: other, gid: g === undefined ? undefined : g.id, after: y > rect.top + rect.height / 2 };
						}
					}
					return null;
				};

				const applyHit = (hit) => {
					if (hit.kind === "loose") {
						place(id, {});
						save();
						return;
					}
					if (hit.kind === "chip") {
						place(id, { gid: hit.gid, anchorGid: hit.gid });
						save();
						return;
					}
					const where = hit.gid === undefined ? {} : { gid: hit.gid, anchorGid: hit.gid };
					if (hit.after) where.after = hit.id;
					else where.before = hit.id;
					place(id, where);
					// 拖动中每次都落盘：写盘本身有 250ms 节流，不会狂写
					save();
				};

				const onMove = (e) => {
					if (!dragging) {
						if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) cancelTimer();
						return;
					}
					e.preventDefault();
					if (ghost !== null) {
						ghost.style.transform = `translate3d(${Math.round(e.clientX - grabX)}px, ${Math.round(e.clientY - grabY)}px, 0) scale(1.02)`;
					}
					const hit = hitAt(e.clientX, e.clientY);
					const key = hit === null ? "" : `${hit.kind}:${hit.gid ?? ""}:${hit.id ?? ""}:${hit.after}`;
					if (key === lastKey) return;
					lastKey = key;
					if (hit === null) return;
					const before = snapshotRects();
					applyHit(hit);
					sync();
					flipRects(before);
				};

				const onUp = () => cleanup();

				el.addEventListener("pointerdown", (e) => {
					if (!sidebarDragAllowed() || e.button !== 0) return;
					navDragCleanup?.();
					navDragCleanup = cleanup;
					startX = e.clientX;
					startY = e.clientY;
					if (timer !== 0) clearTimeout(timer);
					document.addEventListener("pointermove", onMove, true);
					document.addEventListener("pointerup", onUp, true);
					document.addEventListener("pointercancel", onUp, true);
					timer = setTimeout(() => {
						timer = 0;
						if (!el.isConnected || !sidebarDragAllowed()) { cleanup(); return; }
						dragging = true;
						const rect = el.getBoundingClientRect();
						grabX = startX - rect.left;
						grabY = startY - rect.top;
						ghost = el.cloneNode(true);
						ghost.removeAttribute("draggable");
						ghost.removeAttribute("data-dsg-id");
						Object.assign(ghost.style, {
							position: "fixed",
							left: "0px",
							top: "0px",
							width: `${Math.round(rect.width)}px`,
							height: `${Math.round(rect.height)}px`,
							margin: "0",
							pointerEvents: "none",
							zIndex: "2147483000",
							transform: `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0) scale(1.02)`,
							transformOrigin: "center center",
							boxShadow: "0 10px 28px rgba(0,0,0,.2)",
							borderRadius: "8px",
							background: "var(--dsw-alias-bg-layer-1, #fff)",
							transition: "none",
						});
						ghost.dataset.dsgFloating = "1";
						document.body.appendChild(ghost);
						el.style.opacity = "0.22";
						document.body.style.cursor = "grabbing";
						lastKey = "\u0000";
					}, state.sidebarDragDelay);
				});
			};

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

				el.addEventListener("click", (ev) => {
					// 刚拖完松手会补一个 click —— 别让它顺带把分组折起来
					if (suppressChipClick) {
						ev.preventDefault();
						ev.stopPropagation();
						return;
					}
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

				// 拖整组改顺序：手指式拖拽（长按浮起 + 实时让位），不是 HTML5 DnD
				if (kind === "group") bindChipPointerDrag(el, gid);
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
					dragPayload = { kind: "item", id, core: isCore(id) };
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
				const id = buttonId(btn);
				if (id === undefined) return null;
				return { kind: "item", el: btn, id, core: isCore(id) };
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
					// 分组既能和分组换位，也能插到核心项旁边（顶上那几个）
					if (hit.kind === "chip") {
						if (hit.gid === dragPayload.gid) return null;
						const rect = hit.el.getBoundingClientRect();
						return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
					}
					if (hit.kind === "item" && hit.core === true) {
						const rect = hit.el.getBoundingClientRect();
						return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
					}
					return null;
				}
				// 条目
				if (hit.kind === "chip" || hit.kind === "loose") return "into";
				// 顶部固定项和普通条目不能互串：前者只在自己那一区里排，后者不进核心区
				if (dragPayload.core === true && hit.core !== true) return null;
				if (dragPayload.core !== true && hit.core === true) return null;
				const rect = hit.el.getBoundingClientRect();
				return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
			};

			const applyDrop = (hit, mode, e) => {
				if (dragPayload === null) return;
				if (dragPayload.kind === "group") {
					const list = resolvedTopOrder().filter((x) => !(x.kind === "group" && x.id === dragPayload.gid));
					const at = hit.kind === "chip"
						? list.findIndex((x) => x.kind === "group" && x.id === hit.gid)
						: list.findIndex((x) => x.kind === "core" && x.id === hit.id);
					if (at < 0) return;
					list.splice(mode === "after" ? at + 1 : at, 0, { kind: "group", id: dragPayload.gid });
					commitTopOrder(list);
					return;
				}
				const id = dragPayload.id;
				if (dragPayload.core === true) {
					// 拖的是核心项：同样走顶层顺序，这样它也能和分组互换位置
					const list = resolvedTopOrder().filter((x) => !(x.kind === "core" && x.id === id));
					const at = list.findIndex((x) => x.kind === "core" && x.id === hit.id);
					if (at < 0) return;
					list.splice(mode === "after" ? at + 1 : at, 0, { kind: "core", id });
					commitTopOrder(list);
					return;
				}
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

			/** 记下当前所有导航项的位置，拖完用来做 FLIP。 */
			const snapshotRects = () => {
				const nav = findNavList();
				const map = new Map();
				if (nav === null) return map;
				for (const child of nav.children) {
					if (child.tagName !== "BUTTON") continue;
					map.set(child, child.getBoundingClientRect());
				}
				return map;
			};

			/**
			 * FLIP：让重排后的元素从「原来的位置」滑到「新位置」。
			 *
			 * 没有这一步，拖完一次分组，chip 和它底下那一排条目会整体瞬移到位 ——
			 * 眼睛跟不上，看着像闪了一下。用 WAAPI 而不是改 inline style：
			 * 不动元素自身的 transform（那个归显隐动画用），播完自动清理。
			 */
			const flipRects = (before) => {
				if (!motionAllowed()) return;
				for (const [el, oldRect] of before) {
					if (!el.isConnected) continue;
					// 正在播显隐动画的别抢它的 transform
					if (el.dataset.dsgAnim !== undefined) continue;
					const newRect = el.getBoundingClientRect();
					const dx = oldRect.left - newRect.left;
					const dy = oldRect.top - newRect.top;
					if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
					try {
						uiAnimate(el,
							[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
							{ duration: 300, easing: "cubic-bezier(.2,.7,.3,1)" },
						);
					} catch (_ignored) {
						/* 不支持 WAAPI 就直接跳，不影响功能 */
					}
				}
			};

			const onDrop = (e) => {
				if (dragPayload === null) return;
				const hit = hitTest(e.clientX, e.clientY);
				const mode = hit === null ? null : decideDrop(hit, e);
				let before = null;
				if (hit !== null && mode !== null) {
					e.preventDefault();
					before = snapshotRects();
					applyDrop(hit, mode, e);
				}
				dragPayload = null;
				clearDropMarks();
				save();
				sync(true);
				// 必须在 sync 之后：这时 DOM 已经重排完，量到的是新位置
				if (before !== null) flipRects(before);
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
			const itemAnimations = new Map();
			const itemVars = ["h", "pt", "pb", "mt", "mb", "from-h", "from-pt", "from-pb", "from-mt", "from-mb", "from-opacity", "from-transform"];

			/** 清理时撤销旧回调，防止连点或停用后被旧动画改回去。 */
			const resetItemStyles = (btn) => {
				const job = itemAnimations.get(btn);
				if (job !== undefined) {
					clearTimeout(job.timer);
					btn.removeEventListener("animationend", job.end);
					itemAnimations.delete(btn);
				}
				for (const prop of ["height", "overflow", "boxSizing", "paddingTop", "paddingBottom", "marginTop", "marginBottom", "transitionDelay", "transitionTimingFunction", "animationDelay", "minHeight"]) btn.style[prop] = "";
				for (const key of itemVars) btn.style.removeProperty(`--dsg-${key}`);
				delete btn.dataset.dsgAnim;
			};

			const itemMetrics = (btn) => {
				const cs = getComputedStyle(btn);
				return {
					h: `${btn.getBoundingClientRect().height}px`,
					pt: cs.paddingTop, pb: cs.paddingBottom,
					mt: cs.marginTop, mb: cs.marginBottom,
					opacity: cs.opacity, transform: cs.transform,
				};
			};

			const animateItems = (enter, leave) => {
				const jobs = [...enter.map((btn) => ({ btn, direction: "in" })), ...leave.map((btn) => ({ btn, direction: "out" }))];
				// 先读完当前画面；交错读写会让 N 个条目强制布局 N 次。
				for (const job of jobs) {
					job.from = job.btn.style.display === "none"
						? { h: "0px", pt: "0px", pb: "0px", mt: "0px", mb: "0px", opacity: "0", transform: "translateY(-4px)" }
						: itemMetrics(job.btn);
				}
				for (const { btn } of jobs) {
					resetItemStyles(btn);
					btn.style.display = "";
				}
				// 所有条目恢复自然尺寸后再读展开目标，只触发一轮布局。
				for (const job of jobs) if (job.direction === "in") job.to = itemMetrics(job.btn);
				for (const job of jobs) {
					const { btn, direction } = job;
					for (const [key, value] of Object.entries(job.from)) btn.style.setProperty(`--dsg-from-${key}`, value);
					if (job.to !== undefined) for (const [key, value] of Object.entries(job.to)) {
						if (key !== "opacity" && key !== "transform") btn.style.setProperty(`--dsg-${key}`, value);
					}
					btn.dataset.dsgAnim = direction;
					const finish = () => {
						if (itemAnimations.get(btn) !== job) return;
						btn.style.display = direction === "out" ? "none" : "";
						resetItemStyles(btn);
					};
					job.finish = finish;
					job.end = (event) => {
						if (event.target === btn && event.animationName === (direction === "in" ? "dsgItemIn" : "dsgItemOut")) finish();
					};
					job.timer = setTimeout(finish, ANIM_MS + 80);
					itemAnimations.set(btn, job);
					btn.addEventListener("animationend", job.end);
				}
			};

			const applyVisibility = (animate) => {
				animate = animate && motionAllowed();
				const enter = [];
				const leave = [];
				for (const r of rows) {
					const btn = refs.get(r.id);
					if (btn === undefined) continue;
					const g = groupOf(r.id);
					// 隐藏优先于一切：藏起来的条目不管在不在组里、组展没展开，都不显示。
					// 顶部固定项只受隐藏影响（它们没有"组展开"这回事）。
					// 没有分组的时候「折叠未分组」这个状态没有意义，全部视为展开。
					const visible = state.hidden.includes(r.id)
						? false
						: isCore(r.id)
							? true
							: (g === undefined ? (state.groups.length === 0 || !state.folded) : g.open !== false);
					const prev = shownState.get(btn);
					shownState.set(btn, visible);
					// 目标未变就保留动画；目标反转则从当前帧接续。
					if (prev === visible && btn.dataset.dsgAnim !== undefined) continue;
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
						resetItemStyles(btn);
					}
					for (const btn of leave) {
						btn.style.display = "none";
						resetItemStyles(btn);
					}
					return;
				}
				animateItems(enter, leave);
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

				// 核心项和分组走同一串顺序：分组可以插在核心项之间，不再永远排在下面
				for (const item of resolvedTopOrder()) {
					if (item.kind === "core") {
						const btn = refs.get(item.id);
						if (btn !== undefined) {
							delete btn.dataset.dsgNest;
							seq.push(btn);
						}
						continue;
					}
					const g = groupById(item.id);
					if (g === undefined) continue;
					seq.push(ensureChip(g));
					for (const id of entriesOf(g)) {
						const btn = refs.get(id);
						if (btn === undefined) continue;
						// 组内条目缩进一级，看得出"它在谁下面"
						btn.dataset.dsgNest = "1";
						seq.push(btn);
					}
				}
				const loose = looseIds();
				// 未分组里没有东西就不显示这一行 —— 光秃秃一个「未分组 (0)」只是碍眼。
				// 代价是少了「拖出分组」的投放目标，但管理页每条都有「移出」按钮兜底。
				if (state.groups.length > 0 && loose.length > 0) {
					seq.push(ensureLooseChip());
				} else if (looseChip !== null && looseChip.parentNode !== null) {
					looseChip.remove();
				}
				for (const id of loose) {
					const btn = refs.get(id);
					if (btn === undefined) continue;
					delete btn.dataset.dsgNest;
					seq.push(btn);
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
				// 不只遍历 chips 这张表：nav 重建过的话表里会丢条目，
				// 而 DOM 里的旧 chip 还挂着 —— 直接扫一遍最稳
				for (const el of document.querySelectorAll(".dsg-chip")) el.remove();
				chips.clear();
				looseChip = null;
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
				if (!sidebarDragAllowed()) navDragCleanup?.();
				if (inSync) {
					pendingSync = true;
					if (animate) animatePending = true;
					return;
				}
				inSync = true;
				try {
					const nav = findNavList();
					if (nav === null) { navDragCleanup?.(); return; }
					nav.dataset.dsgSidebarDrag = state.sidebarDrag ? "1" : "0";
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
					// 全部导航条目走长按拖动；开关在 pointerdown 时读取，随时切换立即生效。
					for (const r of rows) {
						const btn = refs.get(r.id);
						if (btn === undefined) continue;
						// 标记放在这里而不是 bindItemDrag 里：核心项已经不走那条路径了，
						// 但悬停/选中的样式是按这个属性挂的。
						btn.dataset.dsgItem = "1";
						btn.draggable = false;
						if (isCore(r.id)) bindCorePointerDrag(btn, r.id);
						else bindItemPointerDrag(btn, r.id);
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
					navDragCleanup?.();
					for (const nav of document.querySelectorAll("[data-dsg-sidebar-drag]")) delete nav.dataset.dsgSidebarDrag;
					if (stormTimer !== null) clearTimeout(stormTimer);
					for (const el of document.querySelectorAll(".dsg-chip")) el.remove();
					chips.clear();
					looseChip = null;
					if (searchBox !== null) searchBox.remove();
					searchBox = null;
					for (const btn of [...itemAnimations.keys()]) resetItemStyles(btn);
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

			/** 分组上移/下移：管理页每次移动到相邻分组旁边，跳过混排中的固定项。 */
			const moveGroup = (gid, delta) => {
				const groups = resolvedTopOrder().filter((x) => x.kind === "group");
				const index = groups.findIndex((x) => x.id === gid);
				const target = groups[index + delta];
				if (index >= 0 && target !== undefined) moveGroupTo(gid, { gid: target.id, after: delta > 0 });
			};

			/** 记下管理页所有卡片/行的位置，用来给 ↑↓ 做过渡。 */
			const snapshotPage = () => {
				const map = new Map();
				for (const el of document.querySelectorAll(".dsg-page .dsg-card, .dsg-page .dsg-row")) {
					map.set(el, el.getBoundingClientRect());
				}
				return map;
			};

			// 在 React 提交新顺序前保留当前画面，layout effect 在浏览器绘制前接上动画。
			let pendingPageFlip = null;
			const flipPage = (before) => {
				if (before.size === 0) return;
				if (pendingPageFlip === null) pendingPageFlip = new Map();
				for (const [el, rect] of before) if (!pendingPageFlip.has(el)) pendingPageFlip.set(el, rect);
			};
			const playPageFlip = () => {
				const before = pendingPageFlip;
				pendingPageFlip = null;
				if (before === null) return;
				// 连点时先采过当前画面，再撤掉旧动画读真实终点，避免两段变换相互叠加。
				for (const el of before.keys()) {
					if (!el.isConnected) continue;
					for (const motion of el.getAnimations()) if (motion.id === "dsg-page-reorder") motion.cancel();
				}
				if (!motionAllowed()) return;
				const moves = new Map();
				for (const [el, oldRect] of before) {
					if (!el.isConnected) continue;
					const now = el.getBoundingClientRect();
					moves.set(el, { dx: oldRect.left - now.left, dy: oldRect.top - now.top });
				}
				for (const [el, delta] of moves) {
					if (el.dataset.dsgPageDragging === "1" || el.style.opacity === "0.25") continue;
					// 行所在的卡片也会补位；行只播放相对卡片的那部分位移。
					const parent = el.classList.contains("dsg-row") ? moves.get(el.closest(".dsg-card")) : null;
					const dx = delta.dx - (parent?.dx ?? 0), dy = delta.dy - (parent?.dy ?? 0);
					if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
					try {
						uiAnimate(el,
							[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
							{ id: "dsg-page-reorder", duration: 280, easing: "cubic-bezier(.2,.7,.3,1)" },
						);
					} catch (_ignored) { /* 不支持 WAAPI 时保留排序结果。 */ }
				}
			};

			/** 把某个核心项挪到目标旁边（目标是核心项或分组都行）。 */
			const moveCoreTo = (id, target) => {
				if (target === null || target === undefined) return;
				if (target.coreId === id) return;
				const list = resolvedTopOrder().filter((x) => !(x.kind === "core" && x.id === id));
				const at = target.gid !== undefined
					? list.findIndex((x) => x.kind === "group" && x.id === target.gid)
					: list.findIndex((x) => x.kind === "core" && x.id === target.coreId);
				if (at < 0) return;
				const before = snapshotPage();
				list.splice(target.after === true ? at + 1 : at, 0, { kind: "core", id });
				commitTopOrder(list);
				save();
				flipPage(before);
			};

			const moveGroupTo = (gid, target) => {
				if (target === null || target === undefined) return;
				if (target.gid === gid) return;
				const list = resolvedTopOrder().filter((x) => !(x.kind === "group" && x.id === gid));
				const at = target.gid !== undefined
					? list.findIndex((x) => x.kind === "group" && x.id === target.gid)
					: list.findIndex((x) => x.kind === "core" && x.id === target.coreId);
				if (at < 0) return;
				const before = snapshotPage();
				list.splice(target.after === true ? at + 1 : at, 0, { kind: "group", id: gid });
				commitTopOrder(list);
				save();
				flipPage(before);
			};

			const moveCore = (id, delta) => {
				const core = resolvedTopOrder().filter((x) => x.kind === "core");
				const target = core[core.findIndex((x) => x.id === id) + delta];
				if (target !== undefined) moveCoreTo(id, { coreId: target.id, after: delta > 0 });
			};

			/** 组内上移/下移 */
			const moveEntry = (gid, id, delta) => {
				const g = gid === undefined ? undefined : groupById(gid);
				const list = g === undefined ? looseIds() : [...g.entries];
				const idx = list.indexOf(id);
				const to = idx + delta;
				if (idx < 0 || to < 0 || to >= list.length) return;
				const before = snapshotPage();
				list.splice(idx, 1);
				list.splice(to, 0, id);
				if (g === undefined) state.loose = list;
				else g.entries = list;
				save();
				flipPage(before);
			};

			/**
			 * 自定义下拉：原生 <select> 在浅色主题里是「白底 + 蓝条 + 黑边框」，
			 * 跟整套灰调格格不入，而且没法跟主题变量走。这里自己画一个。
			 */
			function GroupPicker({ groups: list, label, onPick }) {
				const [open, setOpen] = React.useState(false);
				const boxRef = React.useRef(null);
				React.useEffect(() => {
					if (!open) return;
					const away = (ev) => {
						if (boxRef.current !== null && !boxRef.current.contains(ev.target)) setOpen(false);
					};
					const esc = (ev) => {
						if (ev.key === "Escape") { setOpen(false); boxRef.current?.querySelector(".dsg-picker-btn")?.focus(); }
					};
					document.addEventListener("pointerdown", away);
					document.addEventListener("keydown", esc);
					return () => {
						document.removeEventListener("pointerdown", away);
						document.removeEventListener("keydown", esc);
					};
				}, [open]);
				return h("div", { className: "dsg-picker", ref: boxRef },
					h("button", {
						type: "button",
						className: "dsg-picker-btn",
						"aria-haspopup": "listbox",
						"aria-expanded": open ? "true" : "false",
						onClick: () => setOpen((v) => !v),
					},
					h("span", null, label),
					h("span", { className: "dsg-picker-caret" }),
					),
					h(MotionBox, { show: open, className: "dsg-picker-menu", role: "listbox" },
							list.map((g) => h("button", {
								key: g.id,
								type: "button",
								role: "option",
								className: "dsg-picker-item",
								onClick: () => {
									setOpen(false);
									onPick(g.id);
								},
							}, g.name)),
						),
				);
			}


			function GroupsPage(props) {
				const tPage = props?.t ?? t;
				const [, setTick] = React.useState(0);
				const [draft, setDraft] = React.useState("");
				const [delayDraft, setDelayDraft] = React.useState(String(state.sidebarDragDelay));
				React.useEffect(() => { setDelayDraft(String(state.sidebarDragDelay)); }, [state.sidebarDragDelay]);
				const [renaming, setRenaming] = React.useState(null); // gid
				const [renameText, setRenameText] = React.useState("");
				const [dragId, setDragId] = React.useState(null); // 被拖的条目（渲染用）
				const [dragGid, setDragGid] = React.useState(null); // 被拖的分组卡片（渲染用）
				const [confirmGid, setConfirmGid] = React.useState(null); // 正在等确认删除的分组
				// setState 是异步的：dragstart 与 drop 若在同一 tick 里连发，
				// 事件处理里读 state 还是旧值 —— 真正判落点要用这两个 ref。
				const dragIdRef = React.useRef(null);
				const dragGidRef = React.useRef(null);
				const [dropTarget, setDropTarget] = React.useState(null); // gid | "__loose" | "row:<id>:before"
				const [flash, setFlash] = React.useState("");
				const pageRef = React.useRef(null), sceneBefore = React.useRef(null), renameFeedback = React.useRef(null);
				const flashTimer = React.useRef(null), flashText = React.useRef("");
				if (flash) flashText.current = flash;

				React.useLayoutEffect(() => {
					playPageFlip();
					if (sceneBefore.current && pageRef.current) {
						playScene(sceneBefore.current, captureScene(pageRef.current, ".dsg-card,.dsg-row", sceneKey), { reorder: false, highlight: true });
						sceneBefore.current = null;
					}
					if (renameFeedback.current && pageRef.current) {
						const card = [...pageRef.current.querySelectorAll(".dsg-card[data-dsg-gid]")].find((el) => el.dataset.dsgGid === renameFeedback.current);
						uiArrival(card?.querySelector(".dsg-cardname"));
						renameFeedback.current = null;
					}
				});
				React.useEffect(() => {
					const bump = () => setTick((v) => v + 1);
					pageListeners.add(bump);
					return () => { pageListeners.delete(bump); pageRowDrag?.cleanup(); pendingPageFlip = null; clearTimeout(flashTimer.current); };
				}, []);

				React.useEffect(() => {
					// 进入管理页时补一次台账刷新（面板刚打开时可能还没同步）
					refreshRows();
					setTick((v) => v + 1);
				}, []);

				// 管理页的分组顺序必须跟导航同源（topOrder），不能读 state.groups 的数组顺序 ——
				// 拖拽只改 topOrder，读数组会看到「导航变了、页面没变」。
				const groups = resolvedTopOrder()
					.filter((x) => x.kind === "group")
					.map((x) => groupById(x.id))
					.filter((g) => g !== undefined);
				const coreList = resolvedTopOrder().filter((x) => x.kind === "core").map((x) => x.id);
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
					clearTimeout(flashTimer.current);
					setFlash(msg);
					flashTimer.current = setTimeout(() => setFlash(""), 1600);
				};

				const commit = (msg) => {
					if (pageRef.current && motionAllowed()) {
						sceneBefore.current ??= captureScene(pageRef.current, ".dsg-card,.dsg-row", sceneKey);
						flipPage(snapshotPage());
					}
					save();
					// 带动画同步：隐藏/移出时右侧导航里那一条应该淡出塌掉，而不是凭空消失
					sync(true);
					notifyPage();
					if (msg !== undefined) say(msg);
				};
				const saveSidebarDragDelay = () => {
					const parsed = Number(delayDraft);
					if (delayDraft.trim() === "" || !Number.isFinite(parsed)) {
						setDelayDraft(String(state.sidebarDragDelay));
						return;
					}
					const delay = normalizeSidebarDragDelay(parsed);
					setDelayDraft(String(delay));
					if (delay === state.sidebarDragDelay) return;
					state.sidebarDragDelay = delay;
					commit();
				};
				const finishRename = (g) => {
					const name = renameText.trim();
					if (!name) return;
					g.name = name; renameFeedback.current = g.id;
					setRenaming(null); commit(tPage("renamed"));
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
					draggable: false,
					"data-dsg-entry": id,
					ref: (el) => { if (el !== null) bindPageRowDrag(el, id); },
					"data-dragging": dragId === id ? "1" : undefined,
					"data-over": dropTarget !== null && dropTarget.startsWith(`row:${id}:`) ? dropTarget.split(":").at(-1) : undefined,
					onDragStart: (e) => {
						dragIdRef.current = id;
						setDragId(id);
						e.dataTransfer.effectAllowed = "move";
						try {
							e.dataTransfer.setData("text/plain", id);
						} catch (_ignored) {
							/* noop */
						}
					},
					onDragEnd: () => {
						dragIdRef.current = null;
						setDragId(null);
						setDropTarget(null);
					},
					onDragOver: (e) => {
						if (dragIdRef.current === null || dragIdRef.current === id) return;
						e.preventDefault();
						const rect = e.currentTarget.getBoundingClientRect();
						const before = e.clientY < rect.top + rect.height / 2;
						setDropTarget(`row:${id}:${before ? "before" : "after"}`);
					},
					onDrop: (e) => {
						e.preventDefault();
						if (dragIdRef.current === null || dragIdRef.current === id) return;
						const rect = e.currentTarget.getBoundingClientRect();
						const before = e.clientY < rect.top + rect.height / 2;
						const where = gid === undefined ? {} : { gid, anchorGid: gid };
						if (before) where.before = id;
						else where.after = id;
						place(dragIdRef.current, where);
						dragIdRef.current = null;
						setDragId(null);
						setDropTarget(null);
						commit();
					},
				},
				h("span", { className: "dsg-rowgrip", title: tPage("dragRowHint") }, "⠿"),
				h("span", { className: "dsg-rowname", title: labelOf(id) }, labelOf(id)),
				h("button", {
					type: "button",
					className: "dsg-btn dsg-btn-ghost dsg-icon",
					title: tPage("up"),
					onClick: () => {
						moveEntry(gid, id, -1);
						commit();
					},
				}, iconEl(ICON_UP, undefined, 2)),
				h("button", {
					type: "button",
					className: "dsg-btn dsg-btn-ghost dsg-icon",
					title: tPage("down"),
					onClick: () => {
						moveEntry(gid, id, 1);
						commit();
					},
				}, iconEl(ICON_DOWN, undefined, 2)),
				gid === undefined
					? h(GroupPicker, {
						groups,
						label: tPage("toGroup"),
						onPick: (target) => {
							place(id, { gid: target, anchorGid: target });
							const g = groupById(target);
							commit(g === undefined ? undefined : tPage("movedTo").replace("{name}", g.name));
						},
					})
					: h("button", {
						type: "button",
						className: "dsg-btn dsg-icon",
						title: tPage("remove"),
						onClick: () => {
							place(id, {});
							commit(tPage("movedOut"));
						},
					}, iconEl(ICON_EXIT, ICON_EXIT_ARROW)),
				// 隐藏：从导航里彻底拿掉，但配置留着，随时能从「已隐藏」放回来
				h("button", {
					type: "button",
					className: "dsg-btn dsg-icon dsg-hide",
					title: tPage("hideHint"),
					onClick: () => {
						hideEntry(id);
						commit(tPage("hiddenDone"));
					},
				}, iconEl(ICON_HIDE, ICON_HIDE_SLASH)),
				);

				/**
				 * 细线图标。字符版（✎ ↺ ✕）笔画太细，在小字号下糊成一团；
				 * 用 SVG 才能跟放大镜保持同一条线宽。
				 */
				const iconEl = (d, extra, weight = 1.6) => h("svg", {
					viewBox: "0 0 16 16",
					width: 15,
					height: 15,
					"aria-hidden": "true",
					style: { display: "block", flex: "none" },
				},
				h("path", {
					d,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: weight,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
				extra === undefined ? null : h("path", {
					d: extra,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: weight,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
				);

				const ICON_PENCIL = "M3 13l.6-2.6 7.3-7.3a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7l-7.3 7.3L3 13z";
				const ICON_PENCIL_TIP = "M9.8 4.2l2 2";
				const ICON_TRASH = "M3.5 5h9M6.5 5V3.2h3V5M5 5l.5 8h5L11 5";
				const ICON_TRASH_LINES = "M7 7.5v3.5M9 7.5v3.5";
				/** 插件标记：三条长短不一的横线（分组列表）+ 一个指向右的折角（展开）。 */
				const LOGO_MARK = h("svg", {
					viewBox: "0 0 20 20",
					width: 18,
					height: 18,
					"aria-hidden": "true",
					style: { display: "block" },
				},
				h("path", { d: "M2.5 5.5h9M2.5 10h6M2.5 14.5h11", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
				h("path", { d: "M15 7.5 17.5 10 15 12.5", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }),
				);

				const ICON_HIDE = "M2.2 8s2.2-3.9 5.8-3.9S13.8 8 13.8 8s-2.2 3.9-5.8 3.9S2.2 8 2.2 8z";
				const ICON_HIDE_SLASH = "M3 13 13 3";
				const ICON_UP = "M8 12.5V3.5M8 3.5 4.2 7.3M8 3.5l3.8 3.8";
				const ICON_DOWN = "M8 3.5v9M8 12.5 4.2 8.7M8 12.5l3.8-3.8";
				const ICON_EXIT = "M9.5 3H12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9.5";
				const ICON_EXIT_ARROW = "M8.5 8H2.5M5.5 5.5 2.5 8l3 2.5";


				/** 顶部固定项：只有排序和隐藏，没有分组。 */
				const pinnedRow = (id, index) => h("div", {
					key: `p-${id}`,
					className: "dsg-row dsg-pin",
					"data-dsg-pin": id,
					ref: (el) => {
						if (el !== null) bindPinnedPointerDrag(el, id);
					},
				},
					// 抓手显示出来 —— 它是"这一行能拖"的信号
					h("span", { className: "dsg-rowgrip" }, "⠿"),
					h("span", { className: "dsg-rowname", title: labelOf(id) }, labelOf(id)),
					h("button", {
						type: "button",
						className: "dsg-btn dsg-btn-ghost dsg-icon",
						title: tPage("up"),
						disabled: index === 0,
						onClick: () => {
							moveCore(id, -1);
							commit();
						},
					}, iconEl(ICON_UP, undefined, 2)),
					h("button", {
						type: "button",
						className: "dsg-btn dsg-btn-ghost dsg-icon",
						title: tPage("down"),
						disabled: index === coreList.length - 1,
						onClick: () => {
							moveCore(id, 1);
							commit();
						},
					}, iconEl(ICON_DOWN, undefined, 2)),
					h("button", {
						type: "button",
						className: "dsg-btn dsg-icon dsg-hide",
						title: tPage("hideHint"),
						onClick: () => {
							hideEntry(id);
							commit(tPage("hiddenDone"));
						},
					}, iconEl(ICON_HIDE, ICON_HIDE_SLASH)),
				);

				const groupCard = (g, index) => {
					const items = entriesOf(g);
					const isOver = dropTarget === g.id;
					return h("div", {
						key: g.id,
						className: "dsg-card",
						"data-dsg-gid": g.id,
						// 卡片自己走「长按浮起」那套；这里的 ref 只负责挂上监听
						ref: (el) => {
							if (el !== null) bindCardPointerDrag(el, g.id);
						},
						"data-over": isOver ? "1" : undefined,
						onDragOver: (e) => {
							// 只剩「条目被拖进来」这一种情况了（卡片自己的拖动走 pointer）
							if (dragIdRef.current === null) return;
							e.preventDefault();
							setDropTarget(g.id);
						},
						onDragLeave: (e) => {
							if (e.currentTarget.contains(e.relatedTarget)) return;
							setDropTarget((cur) => (cur === g.id ? null : cur));
						},
						onDrop: (e) => {
							e.preventDefault();
							if (dragIdRef.current !== null) {
								place(dragIdRef.current, { gid: g.id, anchorGid: g.id });
								dragIdRef.current = null;
								setDragId(null);
								setDropTarget(null);
								commit(tPage("movedTo").replace("{name}", g.name));
							}
						},
					},
					h("div", { className: "dsg-cardhead" },
						h("div", { className: "dsg-title-stage" },
						h(MotionBox, { show: renaming === g.id, className: "dsg-title-view" },
								h("input", {
									className: "dsg-input",
									value: renameText,
									autoFocus: true,
									onChange: (e) => setRenameText(e.target.value),
									onKeyDown: (e) => {
										if (e.key === "Enter") {
											finishRename(g);
										}
										if (e.key === "Escape") setRenaming(null);
									},
								}),
								h("button", {
									type: "button",
									className: "dsg-btn",
									onClick: () => {
										finishRename(g);
									},
								}, tPage("save")),
								h("button", { type: "button", className: "dsg-btn dsg-btn-ghost", onClick: () => setRenaming(null) }, tPage("cancel")),
							),
							h(MotionBox, { show: renaming !== g.id, className: "dsg-title-view" },
								h("span", { className: "dsg-cardname" }, g.name),
								h("span", { className: "dsg-cardcount" }, tPage("itemsCount").replace("{n}", String(items.length))),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost dsg-icon",
									title: tPage("up"),
									disabled: index === 0,
									onClick: () => {
										moveGroup(g.id, -1);
										commit();
									},
								}, iconEl(ICON_UP, undefined, 2)),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-btn-ghost dsg-icon",
									title: tPage("down"),
									disabled: index === groups.length - 1,
									onClick: () => {
										moveGroup(g.id, 1);
										commit();
									},
								}, iconEl(ICON_DOWN, undefined, 2)),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-icon",
									title: tPage("rename"),
									onClick: () => {
										setRenaming(g.id);
										setRenameText(g.name);
									},
								}, iconEl(ICON_PENCIL, ICON_PENCIL_TIP)),
								h("button", {
									type: "button",
									className: "dsg-btn dsg-icon dsg-danger",
									title: tPage("removeGroupHint"),
									onClick: () => setConfirmGid((cur) => (cur === g.id ? null : g.id)),
								}, iconEl(ICON_TRASH, ICON_TRASH_LINES)),
								// 就地确认：气泡挂在卡片头下方，不弹系统 confirm
								h(MotionBox, { show: confirmGid === g.id, className: "dsg-confirm" },
										h("p", { className: "dsg-confirm-text" }, tPage("confirmDelete").replace("{name}", g.name)),
										h("div", { className: "dsg-confirm-actions" },
											h("button", {
												type: "button",
												className: "dsg-btn",
												onClick: () => setConfirmGid(null),
											}, tPage("delCancel")),
											h("button", {
												type: "button",
												className: "dsg-btn dsg-confirm-danger",
												onClick: () => {
													// 删除也共用补位，避免两次 requestAnimationFrame 先跳到终点。
													const cardEl = [...document.querySelectorAll(".dsg-page .dsg-card[data-dsg-gid]")].find((c) => c.dataset.dsgGid === g.id);
													let done = false;
													const finish = () => {
														if (done) return;
														done = true;
														removeGroup(g.id); setConfirmGid(null); commit();
													};
													const anim = uiAnimate(cardEl, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.98)" }], { id: "dsg-group-delete", duration: 170, fill: "forwards" });
													if (anim) anim.finished.then(finish, () => {}); else finish();
												},
											}, tPage("delConfirm")),
										),
									),
							),
						),
					),
					items.length === 0
						? h("p", { className: "dsg-empty" }, tPage("groupEmpty"))
						: h("div", { className: "dsg-rows" }, items.map((id) => entryRow(id, g.id))),
					);
				};

				return h("div", { className: "dsg-page", ref: pageRef },
					// 主标题区：图标 + 大标题 + 副标题 + 右上角标签
					h("div", { className: "dsg-hero" },
						h("div", { className: "dsg-hero-left" },
							h("span", { className: "dsg-hero-mark" }, LOGO_MARK),
							h("div", { style: { minWidth: 0 } },
								h("div", { className: "dsg-hero-title" }, tPage("heroTitle")),
								h("p", { className: "dsg-hero-sub" }, tPage("heroSub")),
							),
						),
					),
					legacyRunning()
						? h("p", { className: "dsg-warn" }, tPage("legacyWarn"))
						: null,
					h("div", { className: "dsg-card" },
						h("div", { className: "dsg-subcard" },
							h("div", { className: "dsg-toggle" },
								h("div", { className: "dsg-toggletext" },
									h("span", { className: "dsg-toggletitle" }, tPage("enabled")),
									h("span", { className: "dsg-hint" }, tPage("enabledDesc")),
								),
								h("button", {
									type: "button",
									className: "dsg-switch",
									role: "switch",
									"aria-label": tPage("enabled"),
									"aria-checked": state.enabled,
									"data-dsg-control": "groups",
									"data-on": state.enabled ? "1" : "0",
									onClick: () => {
										state.enabled = !state.enabled;
										commit();
									},
								}, h("span", { className: "dsg-knob" })),
							),
						),
						h("div", { className: "dsg-subcard" },
							h("div", { className: "dsg-toggle" },
								h("div", { className: "dsg-toggletext" },
									h("span", { className: "dsg-toggletitle" }, tPage("animations")),
									h("span", { className: "dsg-hint" }, tPage("animationsDesc")),
								),
								h("button", {
									type: "button", className: "dsg-switch", role: "switch",
									"aria-label": tPage("animations"), "aria-checked": state.animations,
									"data-dsg-control": "animations", "data-on": state.animations ? "1" : "0",
									onClick: () => { state.animations = !state.animations; commit(); },
								}, h("span", { className: "dsg-knob" })),
							),
						),
						h("div", { className: "dsg-subcard" },
							h("div", { className: "dsg-toggle" },
								h("div", { className: "dsg-toggletext" },
									h("span", { className: "dsg-toggletitle" }, tPage("sidebarDrag")),
									h("span", { className: "dsg-hint" }, tPage("sidebarDragDesc").replace("{ms}", state.sidebarDragDelay)),
								),
								h("button", {
									type: "button", className: "dsg-switch", role: "switch",
									"aria-label": tPage("sidebarDrag"), "aria-checked": state.sidebarDrag,
									"data-dsg-control": "sidebar-drag", "data-on": state.sidebarDrag ? "1" : "0",
									onClick: () => { state.sidebarDrag = !state.sidebarDrag; commit(); },
								}, h("span", { className: "dsg-knob" })),
							),
							h("div", { className: "dsg-toggle" },
								h("div", { className: "dsg-toggletext" },
									h("label", { className: "dsg-toggletitle", htmlFor: "dsg-sidebar-drag-delay" }, tPage("sidebarDragDelay")),
									h("span", { className: "dsg-hint" }, tPage("sidebarDragDelayDesc")),
								),
								h("div", { style: { display: "flex", alignItems: "center", gap: 6, flex: "none" } },
									h("input", {
										id: "dsg-sidebar-drag-delay", className: "dsg-input", type: "text", inputMode: "numeric",
										style: { width: 84, textAlign: "right" }, value: delayDraft,
										onChange: (e) => setDelayDraft(e.target.value), onBlur: saveSidebarDragDelay,
										onKeyDown: (e) => {
											if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
											if (e.key === "Escape") { e.preventDefault(); setDelayDraft(String(state.sidebarDragDelay)); }
										},
									}),
									h("span", { className: "dsg-hint" }, "ms"),
								),
							),
						),
					),
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
						h("button", { type: "button", className: "dsg-create", onClick: addGroup, disabled: draft.trim() === "" }, tPage("create")),
					),
					h("div", { className: "dsg-section" },
						h("div", { className: "dsg-sectionhead" },
							h("span", { className: "dsg-sectiontitle" }, tPage("pinnedHead")),
							h("span", { className: "dsg-cardcount" }, String(coreList.length)),
						),
						h("div", { className: "dsg-card" },
							h("p", { className: "dsg-hint" }, tPage("pinnedHint")),
							h("div", { className: "dsg-rows" }, coreList.map((id, i) => pinnedRow(id, i))),
						),
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
							if (dragIdRef.current === null) return;
							e.preventDefault();
							setDropTarget("__loose");
						},
						onDrop: (e) => {
							e.preventDefault();
							if (dragIdRef.current !== null) {
								place(dragIdRef.current, {});
								dragIdRef.current = null;
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
							"data-dsg-bucket": "loose",
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
							if (dragIdRef.current === null) return;
							e.preventDefault();
							setDropTarget("__hidden");
						},
						onDrop: (e) => {
							e.preventDefault();
							if (dragIdRef.current !== null) {
								hideEntry(dragIdRef.current);
								dragIdRef.current = null;
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
							"data-dsg-bucket": "hidden",
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
									"data-dsg-hidden": id,
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
					// 底部状态条：一眼看到"现在到底有多少东西被这样管着"
					h("div", { className: "dsg-status" },
						h("span", { className: "dsg-status-dot" }),
						h("span", null, tPage("statusBar")
							.replace("{groups}", String(groups.length))
							.replace("{items}", String(total))
							.replace("{hidden}", String(hiddenIds.length))),
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
								state.animations = fresh.animations;
								commit(tPage("resetDone"));
							},
						}, tPage("reset")),
					),
					h("div", { className: "dsg-feedback", role: "status", "aria-live": "polite", "aria-atomic": "true" },
						h(MotionBox, { show: flash !== "", className: "dsg-toast" }, flash || flashText.current),
					),
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
			const ptFitters = new WeakMap();
			const ptViewport = () => {
				const view = window.visualViewport;
				return { x: view?.offsetLeft ?? 0, y: view?.offsetTop ?? 0, w: view?.width ?? window.innerWidth, h: view?.height ?? window.innerHeight };
			};
			const ptOffset = (panel) => {
				const match = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(panel.style.transform || "");
				return { x: match ? Number(match[1]) : 0, y: match ? Number(match[2]) : 0 };
			};
			// 这些位置按下时不算"拖面板"：除了原生控件，还包括管理页里自己画的可拖区域 ——
		// 不然按住卡片头会把整个面板跟着拖走。
		const PT_HIT = "button,a,input,select,textarea,[role='button'],.dsg-cardhead,.dsg-row,.dsg-picker";

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
			// 按实际布局位置纠偏，兼容居中 overlay；入场 scale 不计入真实边界。
			const ptFitPosition = (panel, x, y) => {
				const view = ptViewport();
				const rect = panel.getBoundingClientRect();
				const current = ptOffset(panel);
				const w = panel.offsetWidth;
				const h = panel.offsetHeight;
				// 独立 scale 属性也会缩放 translate3d 的位移，先还原未平移的布局原点。
				const left = rect.left - (w - rect.width) / 2 - current.x * (w ? rect.width / w : 1);
				const top = rect.top - (h - rect.height) / 2 - current.y * (h ? rect.height / h : 1);
				const dx = ptClamp(x, view.x + 8 - left, view.x + view.w - 8 - left - w);
				const dy = ptClamp(y, view.y + 8 - top, view.y + view.h - 8 - top - h);
				panel.style.transform = dx === 0 && dy === 0 ? "" : ptTransform(dx, dy);
			};

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
				// —— 面板开关的进出场 ——
				// 入：面板挂载时淡入 + 轻微放大到位。用独立的 scale 属性，不碰 transform
				// —— 那个位置归拖拽用（inline transform 存着位移）。
				"@keyframes dsgPanelIn{from{opacity:0;scale:.965}to{opacity:1;scale:1}}",
				`${PT_SEL}{animation:dsgPanelIn .24s cubic-bezier(.2,.7,.3,1)}`,
				`${PT_SEL}[data-dsh-ptweak="1"]{box-sizing:border-box;min-width:min(440px,calc(100vw - 16px));min-height:min(300px,calc(100vh - 16px))}`,
				`${PT_SEL}[data-dsh-ptweak="1"] > nav ~ div:not(.dsh-ptweak-split):not(.dsh-ptweak-rz){min-width:0}`,
				// 出：宿主直接把 dialog 卸掉，我们来不及在它身上播动画。
				// 所以移除瞬间留一张同尺寸快照在原地淡出，人眼看就是面板在退场。
				// 整个面板同步淡出；内部快照冻结，防止切页动画在克隆体里重播。
				"@keyframes dsgPanelOut{from{opacity:var(--dsg-exit-opacity,1)}to{opacity:0}}",
				"[data-dsg-ghost=\"1\"]{animation:dsgPanelOut .18s cubic-bezier(.3,0,.7,1) both}",
				"[data-dsg-ghost=\"1\"] *{animation:none !important;transition:none !important;caret-color:transparent !important}",
				// ⚠️ 这里**不要**常驻 `will-change:transform`。
				// 常驻会让设置面板整个生命周期都待在 GPU 合成层上，合成层里的文字
				// 不走 subpixel antialiasing（LCD 次像素渲染），只剩灰度抗锯齿 ——
				// 看上去就是"设置变糊了"。改成拖动时临时提层，松手就撤（见 ptLift/ptDrop）。
				// 切换左侧设置项时，右侧内容区淡入 + 从模糊拉清楚。
				// 用 animation 而不是 transition：切换是"内容被换掉"，没有可过渡的前后值。
				// 不写 fill-mode，动画一结束元素就回到没有 filter 的状态，不会常驻合成层。
				"@keyframes dsgPageIn{from{opacity:.25;filter:blur(7px)}to{opacity:1;filter:blur(0)}}",
				"[data-dsg-page=\"in\"]{animation:dsgPageIn .3s cubic-bezier(.22,.8,.26,1)}",
				// smooth-option-switcher 的持久指示器思路，适配宿主的纵向、可变行高导航。
				// 伪元素不进入 React 子节点列表，也不占空间或接管按钮语义。
				"[data-dsg-switch-track]{position:relative;isolation:isolate}",
				"[data-dsg-switch-track]::before{content:'';display:none;position:absolute;left:0;top:0;z-index:0;pointer-events:none;width:var(--dsg-switch-w,0px);height:var(--dsg-switch-h,0px);border-radius:var(--dsg-switch-radius,10px);background:var(--dsg-switch-bg,rgba(127,127,127,.12));opacity:0;transform:var(--dsg-switch-transform,translate(var(--dsg-switch-x,0px),var(--dsg-switch-y,0px)))}",
				"[data-dsg-switch-track][data-dsg-switch-ready]::before{display:block;opacity:var(--dsg-switch-opacity,1)}",
				"[data-dsg-switch-track][data-dsg-switch-motion]::before{transition:transform .28s cubic-bezier(.34,.96,.6,.99),width .28s cubic-bezier(.34,.96,.6,.99),height .28s cubic-bezier(.34,.96,.6,.99),opacity .12s ease}",
				"[data-dsg-switch-track] > button{position:relative;z-index:1}",
				"[data-dsg-switch-active]{background:transparent !important;transition-property:color,box-shadow !important}",
				"[data-dsg-ghost] [data-dsg-switch-track]::before{transition:none !important}",
				"@media(prefers-reduced-motion:reduce){[data-dsg-switch-track]::before{transition:none !important}[data-dsg-page=\"in\"]{animation:none !important}}",
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

			/** 面板最后一次可见时的位置/尺寸，退场快照要靠它定位。 */
			let ptLastRect = null;
			/** 持续跟踪面板尺寸（挂载那一帧量到的常常是 0）。 */
			let ptRectObs = null;

			// 只缓存面板、导航和正文的样式；关闭时不对整棵设置树逐项计算样式。
			let ptFrame = null;
			const ptScrolls = new Map();
			const ptGhosts = new Map();
			const ptSnapshotProps = ["display", "flex-direction", "align-items", "justify-content", "gap", "padding", "border", "border-radius", "background", "box-shadow", "font", "color", "overflow-x", "overflow-y", "opacity", "filter"];
			const ptCapturePanel = (panel) => {
				if (!panel?.isConnected) return;
				const nav = panel.querySelector(":scope > nav"), content = ptContentOf(panel);
				if (!nav || !content) return;
				const rect = panel.getBoundingClientRect();
				const regions = [panel, nav, content].map((el) => {
					const cs = getComputedStyle(el), box = el.getBoundingClientRect();
					return { index: el === panel ? -1 : [...panel.children].indexOf(el), width: box.width, height: box.height,
						styles: ptSnapshotProps.map((key) => [key, cs.getPropertyValue(key)]) };
				});
				for (const el of [nav.lastElementChild, content]) if (el) ptScrolls.set(el, { x: el.scrollLeft, y: el.scrollTop });
				const scrolls = [];
				for (const [el, offset] of ptScrolls) {
					if (!panel.contains(el)) { ptScrolls.delete(el); continue; }
					const path = [];
					let cursor = el;
					while (cursor !== panel) {
						path.unshift([...cursor.parentElement.children].indexOf(cursor));
						cursor = cursor.parentElement;
					}
					scrolls.push({ path, ...offset });
				}
				ptLastRect = rect;
				const track = nav.querySelector("[data-dsg-switch-track]");
				const indicator = track ? getComputedStyle(track, "::before") : null;
				const switcher = indicator ? { transform: indicator.transform, opacity: indicator.opacity, width: indicator.width, height: indicator.height } : null;
				const moving = new Set([...panel.querySelectorAll("[data-dsg-presence]")]);
				for (const motion of uiMotions) if (motion.effect?.target instanceof Element && panel.contains(motion.effect.target)) moving.add(motion.effect.target);
				const motions = [];
				for (const el of moving) {
					const path = [];
					for (let cursor = el; cursor !== panel; cursor = cursor.parentElement) path.unshift([...cursor.parentElement.children].indexOf(cursor));
					const cs = getComputedStyle(el);
					motions.push({ path, opacity: cs.opacity, transform: cs.transform, boxShadow: cs.boxShadow });
				}
				ptFrame = { panel, rect, regions, scrolls, switcher, motions };
			};

			/** 真正卸载后冻结一份静态画面，整块同步淡出；重新打开时立即清掉旧快照。 */
			const ptGhostOut = (node) => {
				if (node.isConnected || document.querySelector(PT_SEL) !== null) return;
				if (!motionAllowed()) return;
				const frame = ptFrame?.panel === node ? ptFrame : null;
				const rect = frame?.rect ?? ptLastRect;
				if (!rect || rect.width < 80 || rect.height < 80 || node.dataset.dsgGhosted === "1") return;
				node.dataset.dsgGhosted = "1";
				for (const kill of [...ptGhosts.values()]) kill();
				try {
					const ghost = node.cloneNode(true);
					ghost.removeAttribute("id");
					for (const el of ghost.querySelectorAll("[id]")) el.removeAttribute("id");
					for (const el of ghost.querySelectorAll("[data-dsg-page]")) el.removeAttribute("data-dsg-page");
					ghost.removeAttribute("data-dsh-ptweak");
					ghost.removeAttribute("data-shortcut-modal");
					ghost.removeAttribute("aria-modal");
					ghost.setAttribute("data-dsg-ghost", "1");
					ghost.setAttribute("aria-hidden", "true");
					ghost.inert = true;
					for (const region of frame?.regions ?? []) {
						const el = region.index < 0 ? ghost : ghost.children[region.index];
						if (!el) continue;
						for (const [key, value] of region.styles) el.style.setProperty(key, value);
						Object.assign(el.style, { boxSizing: "border-box", width: `${region.width}px`, height: `${region.height}px`, minWidth: "0", minHeight: "0", maxWidth: "none", maxHeight: "none", flex: "none" });
					}
					// 关闭发生在滑动中间时，也冻结指示器当前画面，避免快照跳到终点。
					const track = ghost.querySelector("[data-dsg-switch-track]");
					if (track && frame?.switcher) {
						for (const [key, value] of Object.entries(frame.switcher)) {
							track.style.setProperty(`--dsg-switch-${key === "width" ? "w" : key === "height" ? "h" : key}`, value);
						}
					}
					for (const { path, ...styles } of frame?.motions ?? []) {
						let el = ghost;
						for (const index of path) el = el?.children[index];
						if (el) Object.assign(el.style, styles);
					}
					const st = ghost.style;
					Object.assign(st, { position: "fixed", inset: "auto", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: "border-box", margin: "0", transform: "none", scale: "none", translate: "none", rotate: "none", pointerEvents: "none", zIndex: "2147483000", transition: "none" });
					st.setProperty("--dsg-exit-opacity", st.opacity || "1");
					st.setProperty("animation", "dsgPanelOut .18s cubic-bezier(.3,0,.7,1) both", "important");
					document.body.appendChild(ghost);
					for (const { path, x, y } of frame?.scrolls ?? []) {
						let el = ghost;
						for (const index of path) el = el?.children[index];
						if (el) { el.scrollLeft = x; el.scrollTop = y; }
					}
					let timer;
					const kill = () => { clearTimeout(timer); ghost.remove(); ptGhosts.delete(ghost); };
					ptGhosts.set(ghost, kill);
					ghost.addEventListener("animationend", (event) => {
						if (event.target === ghost && event.animationName === "dsgPanelOut") kill();
					});
					timer = setTimeout(kill, 400);
				} catch (_ignored) { /* 快照失败时正常关闭。 */ }
			};

			/** 指示器始终留在同一轨道，CSS transition 从当前帧接续反向切换。 */
			let ptSwitch = null;
			const ptSwitchMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
			const ptStopSwitch = () => {
				if (!ptSwitch) return;
				const job = ptSwitch;
				ptSwitch = null;
				cancelAnimationFrame(job.raf);
				job.watch.disconnect(); job.resize.disconnect();
				job.theme.disconnect();
				ptSwitchMedia.removeEventListener("change", job.schedule);
				for (const el of job.list.querySelectorAll("[data-dsg-switch-active]")) delete el.dataset.dsgSwitchActive;
				for (const key of ["dsgSwitchTrack", "dsgSwitchReady", "dsgSwitchMotion"]) delete job.list.dataset[key];
				for (const key of ["x", "y", "w", "h", "radius", "bg"]) job.list.style.removeProperty(`--dsg-switch-${key}`);
			};
			const ptEnsureSwitch = (panel) => {
				const list = panel.querySelector(":scope > nav > div:last-child");
				if (!list || ptSwitch?.list === list) return;
				ptStopSwitch();
				const job = { list, active: null, last: null, raf: 0, followUntil: 0, appearance: true, initialized: false };
				ptSwitch = job;
				list.dataset.dsgSwitchTrack = "1";
				const update = () => {
					job.raf = 0;
					if (ptSwitch !== job || !list.isConnected) return;
					const active = [...list.children].find((el) => el.tagName === "BUTTON" && !el.classList.contains("dsg-chip") && el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") ?? null;
					if (job.initialized && active && job.last !== active) ptPlayPageIn(panel);
					job.initialized = true; job.last = active;
					const box = active?.getBoundingClientRect();
					const cs = active ? getComputedStyle(active) : null;
					const visible = box && box.width > 0 && box.height > 1 && cs.visibility !== "hidden" && active.dataset.dsgAnim !== "out" && !active.dataset.dsgDragging;
					if (!visible) {
						delete list.dataset.dsgSwitchReady;
						delete list.dataset.dsgSwitchMotion;
						if (job.active) delete job.active.dataset.dsgSwitchActive;
						job.active = null;
					} else {
						const bounds = list.getBoundingClientRect();
						const sx = bounds.width / list.offsetWidth || 1, sy = bounds.height / list.offsetHeight || 1;
						const geometry = Object.entries({ x: (box.left - bounds.left) / sx + list.scrollLeft - list.clientLeft, y: (box.top - bounds.top) / sy + list.scrollTop - list.clientTop, w: box.width / sx, h: box.height / sy }).map(([key, value]) => [`--dsg-switch-${key}`, `${value.toFixed(3)}px`]);
						const followLayout = job.active === active && geometry.some(([key, value]) => list.style.getPropertyValue(key) !== value);
						if (followLayout) delete list.dataset.dsgSwitchMotion;
						if (job.active !== active || job.appearance) {
							if (job.active) delete job.active.dataset.dsgSwitchActive;
							// 临时停止宿主的背景过渡，读取它的最终选中色和圆角，然后原样还回。
							const transition = active.style.getPropertyValue("transition"), priority = active.style.getPropertyPriority("transition");
							active.style.setProperty("transition", "none", "important");
							delete active.dataset.dsgSwitchActive;
							const theme = getComputedStyle(active);
							list.style.setProperty("--dsg-switch-bg", theme.backgroundColor === "rgba(0, 0, 0, 0)" ? "var(--dsw-specific-sidebar-nav-item-hover,rgba(127,127,127,.12))" : theme.background);
							list.style.setProperty("--dsg-switch-radius", theme.borderRadius);
							active.dataset.dsgSwitchActive = "1";
							if (transition) active.style.setProperty("transition", transition, priority);
							else active.style.removeProperty("transition");
							job.active = active; job.appearance = false;
						}
						for (const [key, value] of geometry) if (list.style.getPropertyValue(key) !== value) list.style.setProperty(key, value);
						// 首次出现、搜索恢复不从坐标原点飞入；普通切换复用同一伪元素。
						if (followLayout || !list.hasAttribute("data-dsg-switch-ready")) {
							list.dataset.dsgSwitchReady = "1";
							void getComputedStyle(list, "::before").transform;
							list.dataset.dsgSwitchMotion = "1";
						}
					}
					if (performance.now() < job.followUntil) job.schedule();
				};
				job.schedule = () => { if (!job.raf) job.raf = requestAnimationFrame(update); };
				job.watch = new MutationObserver((mutations) => {
					if (!mutations.some((m) => m.type === "childList" || m.target !== list || m.attributeName !== "style")) return;
					// 高度动画会改变后面条目的位置，短暂逐帧对齐；平时没有轮询。
						job.followUntil = performance.now() + (motionAllowed() ? 300 : 0);
					job.schedule();
				});
				job.watch.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-expanded", "data-dsg-anim", "data-dsg-search", "data-dsg-hit", "data-dsg-dragging", "style", "class"] });
				job.resize = new ResizeObserver(job.schedule);
				job.resize.observe(list); job.resize.observe(panel);
				job.theme = new MutationObserver(() => { job.appearance = true; job.schedule(); });
				for (const el of [document.documentElement, document.body]) job.theme.observe(el, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
				ptSwitchMedia.addEventListener("change", job.schedule);
				job.schedule();
			};

			/**
			 * 内容区过渡：先摘掉标记、强制回流，再挂回去 —— 同一个 animation 才能重播。
			 * 不加 fill-mode 的话动画一结束元素就回到无 filter 状态，不会一直待在合成层上。
			 */
			const ptPlayPageIn = (panel) => {
				const content = ptContentOf(panel);
				if (content === null) return;
				content.removeAttribute("data-dsg-page");
				if (!motionAllowed()) return;
				void content.offsetWidth;
				content.setAttribute("data-dsg-page", "in");
			};

			/** ① 侧栏右缘分隔条 ② 拖 header 移动面板 ③ 四边四角缩放；都是双击复位。 */
			const ptDecorate = (panel) => {
				delete panel.dataset.dsgGhosted;
				ptEnsureSwitch(panel);
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
					nav.style.transition = motionAllowed() ? "width .28s cubic-bezier(.2,.7,.3,1)" : "";
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
				// ② 拖 header 移动面板 —— 用委托，不绑死在具体元素上。
				// React 重建内容区时旧引用会失效，绑死在元素上会静默失灵（双击复位点不动就是这么来的）。
				const headerOf = (panelEl) => {
					const contentEl = ptContentOf(panelEl);
					return contentEl === null ? null : contentEl.firstElementChild;
				};
				panel.addEventListener("dblclick", (ev) => {
					const header = headerOf(panel);
					if (header === null || !header.contains(ev.target)) return;
					if (ev.target.closest(PT_HIT) !== null) return;
					panel.style.transition = motionAllowed() ? "transform .3s cubic-bezier(.2,.7,.3,1)" : "";
					panel.style.transform = "";
					setTimeout(() => {
						panel.style.transition = "";
					}, 340);
					ptWrite({ dx: 0, dy: 0 });
				});
				panel.addEventListener("pointerdown", (ev) => {
					if (ev.button !== 0) return;
					const header = headerOf(panel);
					if (header === null || !header.contains(ev.target)) return;
					if (ev.target.closest(PT_HIT) !== null) return;
					ev.preventDefault();
					header.classList.add("dsh-ptweak-header");
					// 小窗口里应用的位移可能已被校正，不能拿未裁剪的旧记忆作拖动起点。
					const { x: baseX, y: baseY } = ptOffset(panel);
					const startX = ev.clientX;
					const startY = ev.clientY;
					const move = (e) => {
						ptFitPosition(panel, baseX + (e.clientX - startX), baseY + (e.clientY - startY));
					};
					const up = () => {
						panel.removeEventListener("pointermove", move);
						panel.removeEventListener("pointerup", up);
						panel.removeEventListener("pointercancel", up);
						const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(panel.style.transform || "");
						ptWrite({ dx: m ? Math.round(Number(m[1])) : 0, dy: m ? Math.round(Number(m[2])) : 0 });
					};
					panel.addEventListener("pointermove", move);
					panel.addEventListener("pointerup", up);
					panel.addEventListener("pointercancel", up);
				});

				// ③ 四边 + 四角缩放；默认比宿主大一整圈
				const PT_DEF_W = "min(1080px, calc(100vw - 64px))";
				const PT_DEF_H = "min(920px, calc(100vh - 64px))";
				const fitPanel = () => {
					const view = ptViewport();
					const maxW = Math.max(1, Math.floor(view.w - 16));
					const maxH = Math.max(1, Math.floor(view.h - 16));
					const pref = ptRead();
					const prefW = ptNum(pref.panelW);
					const prefH = ptNum(pref.panelH);
					panel.style.transition = "";
					panel.style.maxWidth = `${maxW}px`;
					panel.style.maxHeight = `${maxH}px`;
					panel.style.width = prefW === null ? PT_DEF_W : `${ptClamp(prefW, Math.min(440, maxW), maxW)}px`;
					panel.style.height = prefH === null ? PT_DEF_H : `${ptClamp(prefH, Math.min(300, maxH), maxH)}px`;
					// 侧栏也要给正文留位置；只改本次显示，不把大窗口偏好写小。
					nav.style.width = ptNum(pref.navW) === null ? "" : `${ptClamp(pref.navW, PT_MIN_NAV, 520)}px`;
					const available = Math.max(0, panel.clientWidth - 6);
					const navMax = Math.max(0, Math.min(available * .38, available - Math.min(PT_MIN_CONTENT, available * .55)) - navPad());
					if (navStyleW() > navMax) setNavStyleW(navMax);
					ptFitPosition(panel, ptNum(pref.dx) ?? 0, ptNum(pref.dy) ?? 0);
					ptLastRect = panel.getBoundingClientRect();
				};
				ptFitters.set(panel, fitPanel);
				fitPanel();

				const resetBox = () => {
					panel.style.transition = motionAllowed() ? "width .3s cubic-bezier(.2,.7,.3,1), height .3s cubic-bezier(.2,.7,.3,1)" : "";
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
						const { x: baseDx, y: baseDy } = ptOffset(panel);
						const startX = ev.clientX;
						const startY = ev.clientY;
						const view = ptViewport();
						const maxW = Math.max(1, view.w - 16);
						const maxH = Math.max(1, view.h - 16);
						const move = (e) => {
							const w = sx ? ptClamp(rect.width + sx * (e.clientX - startX), Math.min(440, maxW), maxW) : rect.width;
							const h = sy ? ptClamp(rect.height + sy * (e.clientY - startY), Math.min(300, maxH), maxH) : rect.height;
							panel.style.width = `${Math.round(w)}px`;
							panel.style.height = `${Math.round(h)}px`;
							// 面板在 overlay 里是 flex 居中的：改尺寸会左右/上下各长一半，
							// 把平移补回一半，被拖的那条边才会咬住鼠标（否则手感像从中心缩放）
							const ndx = sx ? baseDx + (sx * (w - rect.width)) / 2 : baseDx;
							const ndy = sy ? baseDy + (sy * (h - rect.height)) / 2 : baseDy;
							ptFitPosition(panel, ndx, ndy);
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
					// 拖完立刻记一次：不然关面板时的退场快照会停在拖动前的位置
					ptLastRect = panel.getBoundingClientRect();
				};
				panel.addEventListener("pointerup", dropLayer, true);
				panel.addEventListener("pointercancel", dropLayer, true);
				ptCapturePanel(panel);
			};

			let ptQueued = false;
			const ptObserver = new MutationObserver((mutations) => {
				// 先看有没有面板被摘掉 —— 这一步必须在扫描新 panel 之前，
				// 否则 ptLastRect 会被下一次的布局覆盖成 null。
				// 注意不能只比 matches：宿主很可能把 dialog 包在一层 overlay 里整个摘掉，
				// 那时被移除的节点是 overlay，dialog 只是它的后代。
				for (const m of mutations) {
					for (const node of m.removedNodes) {
						if (!(node instanceof Element)) continue;
						if (node.matches?.(PT_SEL)) {
							ptGhostOut(node);
							continue;
						}
						const inner = node.querySelector?.(PT_SEL);
						if (inner !== null && inner !== undefined) ptGhostOut(inner);
					}
				}
				if (ptQueued) return;
				ptQueued = true;
				setTimeout(() => {
					ptQueued = false;
					const panel = document.querySelector(PT_SEL);
					if (panel !== null) {
						try {
							for (const kill of [...ptGhosts.values()]) kill();
							ptDecorate(panel);
							ptCapturePanel(panel);
							// 持续跟踪：挂载那一帧常常还没布局完（rect 全 0），
							// 只靠"补测一次"仍会漏（面板被重建、入场动画改尺寸都会错过）。
							if (ptRectObs === null) ptRectObs = new ResizeObserver(() => {
								const live = document.querySelector(PT_SEL);
								if (live !== null) ptCapturePanel(live);
							});
							ptRectObs.disconnect();
							ptRectObs.observe(panel);
							// 位置变化不触发 ResizeObserver（拖动），所以拖动结束也要补一次
							setTimeout(() => {
								const live = document.querySelector(PT_SEL);
								if (live !== null) ptCapturePanel(live);
							}, 300);
						} catch (error) {
							console.warn("[dsh-settings-groups] panel tweak failed", error);
						}
					} else {
						ptStopSwitch();
					}
				}, 0);
			});

			ctx.effect(() => {
				ptStyle.textContent = PT_CSS;
				document.head.appendChild(ptStyle);
				const captureBeforeClose = (event) => {
					if (event.type === "keydown" && event.key !== "Escape") return;
					const panel = document.querySelector(PT_SEL);
					if (panel !== null) ptCapturePanel(panel);
				};
				const captureScroll = (event) => {
					const panel = document.querySelector(PT_SEL), el = event.target;
					if (panel?.contains(el) && el instanceof Element) {
						ptScrolls.set(el, { x: el.scrollLeft, y: el.scrollTop });
						ptCapturePanel(panel);
					}
				};
				for (const type of ["pointerdown", "click", "keydown"]) document.addEventListener(type, captureBeforeClose, true);
				document.addEventListener("scroll", captureScroll, true);
				let resizeFrame = null;
				const fitViewport = () => {
					if (resizeFrame !== null) return;
					resizeFrame = requestAnimationFrame(() => {
						resizeFrame = null;
						const panel = document.querySelector(PT_SEL);
						if (panel !== null) ptFitters.get(panel)?.();
					});
				};
				window.addEventListener("resize", fitViewport);
				window.visualViewport?.addEventListener("resize", fitViewport);
				const scan = () => {
					const panel = document.querySelector(PT_SEL);
					if (panel !== null) ptDecorate(panel);
				};
				scan();
				ptObserver.observe(document.body, { childList: true, subtree: true });
				return () => {
					for (const type of ["pointerdown", "click", "keydown"]) document.removeEventListener(type, captureBeforeClose, true);
					document.removeEventListener("scroll", captureScroll, true);
					for (const kill of [...ptGhosts.values()]) kill();
					ptScrolls.clear(); ptFrame = null;
					window.removeEventListener("resize", fitViewport);
					window.visualViewport?.removeEventListener("resize", fitViewport);
					if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
					ptObserver.disconnect();
					ptStopSwitch();
					if (ptRectObs !== null) {
						ptRectObs.disconnect();
						ptRectObs = null;
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

			// 所有动效共用一个策略；关闭途中立即落到最终状态，不把内容留在半透明/半收起。
			settleMotion = () => {
				for (const job of [...itemAnimations.values()]) job.finish();
				for (const motion of [...uiMotions]) { try { motion.finish(); } catch (_ignored) { motion.cancel(); } }
				for (const layer of [...uiLayers]) layer.kill();
				for (const kill of [...ptGhosts.values()]) kill();
				for (const content of document.querySelectorAll("[data-dsg-page]")) content.removeAttribute("data-dsg-page");
				ptSwitch?.schedule();
			};

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
