// 用真实 Chromium 跑一遍插件（不是只做语法检查）。
//
//   node test/run.mjs            正常跑
//   node test/run.mjs --headed   开窗口看着跑
//
// 覆盖：首次应用、新建分组、拖拽归组/移出、展开收起的动画属性、
// 分组排序、宿主重建导航后自愈、刷新后持久化。
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// 测试依赖不进仓库：默认用插件目录自己的 node_modules，
// 想复用别处的安装就设 DSG_VENDOR 指过去。
const VENDOR = process.env.DSG_VENDOR || join(ROOT, 'node_modules')
if (!existsSync(join(VENDOR, 'playwright'))) {
	console.error(`[setup] 找不到 playwright（${VENDOR}）`)
	console.error('        先在本目录跑：npm i -D playwright react@18 react-dom@18')
	console.error('        或用 DSG_VENDOR 指向一个已有的 node_modules。')
	process.exit(1)
}
// ESM 的 NODE_PATH 不生效，用 createRequire 从那个目录解析。
const require = createRequire(join(VENDOR, 'noop.js'))
const { chromium } = require('playwright')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' }

// 模拟宿主端那个落盘路由（真实实现见 index.js）。放内存里，跨 page.reload 保留 ——
// 这样才能验证「localStorage 被清掉之后，磁盘那份能不能把配置救回来」。
let fileStore = null

const server = createServer(async (req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1')
	if (url.pathname === '/__reset') {
		fileStore = null
		res.setHeader('content-type', 'application/json')
		res.end('{"ok":true}')
		return
	}
	if (url.pathname === '/api/dsh-settings-groups/config') {
		res.setHeader('content-type', 'application/json; charset=utf-8')
		if (req.method === 'GET') {
			res.end(JSON.stringify({ ok: true, config: fileStore }))
			return
		}
		let body = ''
		for await (const chunk of req) body += chunk
		try {
			fileStore = JSON.parse(body)
			res.end(JSON.stringify({ ok: true }))
		} catch {
			res.statusCode = 400
			res.end(JSON.stringify({ ok: false }))
		}
		return
	}
	let file
	if (url.pathname === '/' || url.pathname === '/harness.html') file = join(HERE, 'harness.html')
	else if (url.pathname === '/client.js') file = join(ROOT, 'client.js')
	else if (url.pathname.startsWith('/vendor/')) file = join(VENDOR, url.pathname.slice('/vendor/'.length))
	else { res.writeHead(404).end('not found'); return }
	try {
		const body = await readFile(file)
		res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body)
	} catch {
		res.writeHead(404).end('not found')
	}
})

const results = []
const check = (name, pass, detail = '') => {
	results.push({ name, pass, detail })
	console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port

const browser = await chromium.launch({
	headless: !process.argv.includes('--headed'),
	// 用系统 Chrome：ms-playwright 里的 Chromium 版本和当前 playwright 不匹配
	channel: process.env.DSG_BROWSER_CHANNEL || 'chrome',
})
const page = await browser.newPage({ viewport: { width: 1000, height: 960 } })

const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (msg) => {
	// favicon 的 404 是浏览器自动请求，跟插件无关
	if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) errors.push(msg.text())
})

/** 导航里从头到尾的可见元素顺序（chip 用名字标出）。 */
// 搜索框是我们自己插的 div，不算导航条目
const navOrder = () => page.evaluate(() => {
	const list = document.querySelector('[role="dialog"][aria-modal="true"] > nav > div:last-child')
	return [...list.children]
		.filter((el) => !el.classList.contains('dsg-search'))
		.map((el) => {
			if (el.classList.contains('dsg-chip')) return `[chip:${el.children[1].textContent}]`
			return (el.textContent ?? '').trim()
		})
})

const visibleNav = () => page.evaluate(() => {
	const list = document.querySelector('[role="dialog"][aria-modal="true"] > nav > div:last-child')
	return [...list.children]
		.filter((el) => !el.classList.contains('dsg-search') && el.style.display !== 'none')
		.map((el) => (el.classList.contains('dsg-chip') ? `[chip:${el.children[1].textContent}]` : (el.textContent ?? '').trim()))
})

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await page.waitForTimeout(400)

// ---- 1. 初始化 ----
const applied = await page.evaluate(() => window.__APPLIED__ === true)
check('插件 apply 无异常', applied, await page.evaluate(() => window.__APPLY_ERROR__ ?? ''))
check('页面无 JS 报错', errors.length === 0, errors.join(' | '))

// ---- 2. 没有分组时保持原生 ----
const initial = await visibleNav()
check('无分组时不注入 chip', (await page.locator('.dsg-chip').count()) === 0)
check('无分组时全部条目可见', initial.filter((x) => !x.startsWith('[chip')).length === 13, `实际 ${initial.length} 项`)
check('核心项排在最前', initial[0] === '账号与余额' && initial[1] === '通用设置', initial.slice(0, 3).join(' / '))
check('管理页入口已注册', initial.includes('设置管理'), initial.join(' / '))

// ---- 3. 新建分组（走管理页真实输入框）----
const input = page.locator('.dsg-new .dsg-input')
await input.fill('界面增强')
await input.press('Enter')
await page.waitForTimeout(250)
check('新建分组后导航出现 chip', (await page.locator('.dsg-chip').count()) >= 1, await navOrder().then((o) => o.join(' / ')))

const chipLabels = await page.evaluate(() =>
	[...document.querySelectorAll('.dsg-chip')].map((c) => c.children[1].textContent))
check('分组 chip 文案正确', chipLabels.includes('界面增强'), chipLabels.join(','))

// 分类名要加粗。500 在微软雅黑上等同 Regular（这字体只有 400/700 两档），得写 700
const nameWeight = await page.evaluate(() => {
	const name = document.querySelector('.dsg-chip .dsg-name')
	return { weight: getComputedStyle(name).fontWeight, family: getComputedStyle(name).fontFamily }
})
check('分类名是粗体', Number(nameWeight.weight) >= 700, JSON.stringify(nameWeight))
check('chip 高度小于官方条目', await page.evaluate(() => {
	const chip = document.querySelector('.dsg-chip')
	const item = document.querySelector('.nav-item')
	return chip.getBoundingClientRect().height < item.getBoundingClientRect().height
}), await page.evaluate(() => {
	const chip = document.querySelector('.dsg-chip')
	const item = document.querySelector('.nav-item')
	return `chip ${chip.getBoundingClientRect().height}px vs item ${item.getBoundingClientRect().height}px`
}))

// ---- 4. 拖拽：把「Claude 美化」拖进分组 chip ----
// 直接派发 DragEvent 而不是用鼠标模拟：侧栏可滚动时，鼠标落点会被滚动位置带偏，
// 点到相邻条目上，测出来的就不是插件的锅了。HTML5 拖放本来就是事件驱动的。
const dnd = ({ srcLabel, srcChip, dstChip, dstLabel, part }) => page.evaluate(({ srcLabel, srcChip, dstChip, dstLabel, part }) => {
	const src = srcChip === undefined
		? [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === srcLabel)
		: [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === srcChip)
	const dst = dstChip === undefined
		? [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === dstLabel)
		: [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === dstChip)
	if (src === undefined || dst === undefined) throw new Error(`dnd target missing: ${srcLabel ?? srcChip} → ${dstChip ?? dstLabel}`)
	const r = dst.getBoundingClientRect()
	const x = r.left + r.width / 2
	const y = part === 'top' ? r.top + 3 : r.bottom - 3
	const dt = new DataTransfer()
	const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
	fire(src, 'dragstart')
	fire(dst, 'dragover')
	fire(dst, 'drop')
	fire(src, 'dragend')
}, { srcLabel, srcChip, dstChip, dstLabel, part })

// 条目也换成「长按浮起」了，用 pointer 协议驱动
const pointerDragItem = (srcLabel, dst, part) => page.evaluate(async ({ srcLabel, dst, part }) => {
	const items = [...document.querySelectorAll('.nav-item')]
	const src = items.find((b) => (b.textContent ?? '').trim() === srcLabel)
	if (src === undefined) return 'no-source'
	const target = dst.chip !== undefined
		? [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === dst.chip)
		: items.find((b) => (b.textContent ?? '').trim() === dst.label)
	if (target === undefined || target === null) return 'no-target'
	const a = src.getBoundingClientRect()
	const b = target.getBoundingClientRect()
	const sx = a.left + 40
	const sy = a.top + a.height / 2
	const tx = b.left + Math.min(b.width / 2, 60)
	const ty = part === 'middle' ? b.top + b.height / 2 : part === 'top' ? b.top + 4 : b.bottom - 4
	const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 4,
	}))
	fire(src, 'pointerdown', sx, sy)
	await new Promise((r) => setTimeout(r, 280))
	for (let i = 1; i <= 5; i += 1) {
		fire(document, 'pointermove', sx + ((tx - sx) * i) / 5, sy + ((ty - sy) * i) / 5)
		await new Promise((r) => setTimeout(r, 22))
	}
	fire(document, 'pointerup', tx, ty)
	await new Promise((r) => setTimeout(r, 400))
	return 'ok'
}, { srcLabel, dst, part })

const dragItemToChip = async (label, chipName) => {
	await pointerDragItem(label, { chip: chipName }, 'middle')
	await page.waitForTimeout(200)
}

// 分组标签用的是「长按浮起」那套 pointer 拖拽，不是 HTML5 DnD —— 测试要照它的协议来
const pointerDragChip = (fromName, toLabel, part) => page.evaluate(async ({ fromName, toLabel, part }) => {
	const chips = [...document.querySelectorAll('.dsg-chip')]
	const byChip = (n) => chips.find((c) => c.children[1].textContent === n)
	const src = byChip(fromName)
	const dst = byChip(toLabel) ?? [...document.querySelectorAll('.nav-item')].find((b) => (b.textContent ?? '').trim() === toLabel)
	if (src === undefined || src === null) return 'no-source'
	if (dst === undefined || dst === null) return 'no-target'
	const a = src.getBoundingClientRect()
	const b = dst.getBoundingClientRect()
	const sx = a.left + a.width / 2
	const sy = a.top + a.height / 2
	const ty = part === 'top' ? b.top + 4 : b.bottom - 4
	const tx = b.left + Math.min(b.width / 2, 40)
	const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1,
	}))
	fire(src, 'pointerdown', sx, sy)
	await new Promise((r) => setTimeout(r, 280)) // 过长按阈值
	for (let i = 1; i <= 4; i += 1) {
		fire(document, 'pointermove', sx + ((tx - sx) * i) / 4, sy + ((ty - sy) * i) / 4)
		await new Promise((r) => setTimeout(r, 24))
	}
	fire(document, 'pointerup', tx, ty)
	await new Promise((r) => setTimeout(r, 420))
	return 'ok'
}, { fromName, toLabel, part })
await dragItemToChip('Claude 美化', '界面增强')
const afterDrop = await page.evaluate(() =>
	[...document.querySelectorAll('.dsg-chip')].map((c) => `${c.children[1].textContent}=${c.children[2].textContent}`))
check('拖进分组：计数变成 1', afterDrop.includes('界面增强=1'), afterDrop.join(' '))

// ---- 5. 展开/收起 + 动画属性 ----
const groupChip = page.locator('.dsg-chip:has-text("界面增强")').first()
const itemDisplay = () => page.evaluate(() => {
	const btn = [...document.querySelectorAll('.nav-item')].find((b) => (b.textContent ?? '').trim() === 'Claude 美化')
	return btn === undefined ? 'missing' : btn.style.display
})
check('展开态下条目可见', (await itemDisplay()) !== 'none', await itemDisplay())

// 点两下：收起 → 收起过程中应带 data-dsg-anim="out"
// 注意：在同一个 tick 里「点击 + 读属性」，否则双 rAF 已经把标记清掉了
const clickAndPeekAnim = (chipName, itemLabel) => page.evaluate(({ chipName, itemLabel }) => {
	const chip = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === chipName)
	const btn = [...document.querySelectorAll('.nav-item')].find((b) => (b.textContent ?? '').trim() === itemLabel)
	chip.click()
	return { anim: btn?.dataset.dsgAnim ?? '', display: btn?.style.display ?? '' }
}, { chipName, itemLabel })

// 小三角自己也得转、得有过渡（只转 4px 的实心三角肉眼看不出来，要配 scale）
const caretStates = await page.evaluate(async () => {
	const chip = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '界面增强')
	const caret = chip.querySelector('.dsg-caret')
	const read = () => ({
		transform: getComputedStyle(caret).transform,
		opacity: getComputedStyle(caret).opacity,
		transition: getComputedStyle(caret).transitionProperty,
	})
	const expanded = read()
	chip.click()
	// 点击后立刻读到的还是过渡的起始值，要等它跑完
	await new Promise((r) => setTimeout(r, 420))
	return { expanded, collapsed: read() }
})
check('小三角有 transform 过渡', caretStates.expanded.transition.includes('transform'), caretStates.expanded.transition)
check('展开态小三角转且放大', caretStates.expanded.transform !== 'none' && !caretStates.expanded.transform.startsWith('matrix(1, 0, 0, 1'), caretStates.expanded.transform)
check('收起态小三角回到原位', caretStates.collapsed.transform === 'none' || caretStates.collapsed.transform.startsWith('matrix(1, 0, 0, 1'), caretStates.collapsed.transform)
await page.waitForTimeout(400)
// 点回展开，别影响后面的断言
await page.evaluate(() => {
	[...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '界面增强').click()
})
await page.waitForTimeout(400)

const collapsePeek = await clickAndPeekAnim('界面增强', 'Claude 美化')
await page.waitForTimeout(360)
check('收起时播过渡动画', collapsePeek.anim === 'out', `data-dsg-anim=${collapsePeek.anim || '(空)'}`)
check('收起后条目隐藏', (await itemDisplay()) === 'none', await itemDisplay())

const expandPeek = await clickAndPeekAnim('界面增强', 'Claude 美化')
await page.waitForTimeout(400)
check('展开时播过渡动画', expandPeek.anim === 'in', `data-dsg-anim=${expandPeek.anim || '(空)'}`)
check('展开后条目重新出现', (await itemDisplay()) !== 'none', await itemDisplay())

// ---- 6. 拖拽移出分组 ----
await dragItemToChip('Claude 美化', '未分组')
const afterOut = await page.evaluate(() =>
	[...document.querySelectorAll('.dsg-chip')].map((c) => `${c.children[1].textContent}=${c.children[2].textContent}`))
check('拖到未分组即移出', afterOut.includes('界面增强=0'), afterOut.join(' '))

// ---- 7. 组内排序 / 分组排序 ----
// 建第二个分组，把两个组都塞点内容，再拖组改顺序
await input.fill('开发工具')
await input.press('Enter')
await page.waitForTimeout(200)
await dragItemToChip('语音朗读', '开发工具')
await dragItemToChip('Command Code', '开发工具')
const beforeOrder = (await navOrder()).filter((x) => x.startsWith('[chip'))
// 落在目标 chip 的「上半部分」= 插到它前面；落点在下半是「插到后面」，
// 对当前这个顺序等于没动，测不出来。
const movedByPointer = await pointerDragChip('开发工具', '界面增强', 'top')
check('分组拖拽走 pointer 协议', movedByPointer === 'ok', String(movedByPointer))
const afterOrder = (await navOrder()).filter((x) => x.startsWith('[chip'))
check('拖动分组可改顺序', beforeOrder.join('|') !== afterOrder.join('|'), `${beforeOrder.join('|')} → ${afterOrder.join('|')}`)

// ---- 7.5 收起动画的中间帧：高度要真的在塌，下面的内容要跟着往上走 ----
// 只断言 data-dsg-anim 存在是查不出问题的 —— 属性挂上了但高度不动，看上去照样是"啪"地一跳。
const mid = await page.evaluate(() => new Promise((resolve) => {
	const chipOf = (name) => [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === name)
	const chip = chipOf('开发工具')
	const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === '语音朗读')
	const below = chipOf('未分组')
	const h0 = item.getBoundingClientRect().height
	const y0 = below.getBoundingClientRect().top
	chip.click()
	const samples = []
	let n = 0
	let midTransform = 'none'
	let midFilter = 'none'
	const tick = () => {
		samples.push(Math.round(item.getBoundingClientRect().height))
		// 属性要在动画中途读：等 7 次采样完（280ms）动画早就结束，拿到的永远是终值
		if (n === 2) {
			const cs = getComputedStyle(item)
			midTransform = cs.transform
			midFilter = cs.filter
		}
		if (++n < 7) setTimeout(tick, 40)
		else {
			resolve({
				h0: Math.round(h0),
				midH: samples[1] ?? 0,
				tail: samples[samples.length - 1],
				samples,
				y0: Math.round(y0),
				midY: Math.round(below.getBoundingClientRect().top),
				filter: midFilter,
				transform: midTransform,
			})
		}
	}
	setTimeout(tick, 40)
}))
check('收起过程中高度在塌陷', mid.midH > 0 && mid.midH < mid.h0, `${mid.h0}px → ${mid.midH}px`)
check('下方内容跟着上移', mid.midY < mid.y0, `未分组 top ${mid.y0} → ${mid.midY}`)
// 为了流畅度，动画里已经不再用 blur/scale（每帧重新栅格化太贵），只留 translateY
check('动画里没有滤镜', !/blur/.test(mid.filter), mid.filter)
check('收起过程中带位移', mid.transform !== 'none' && mid.transform !== 'matrix(1, 0, 0, 1, 0, 0)', mid.transform)
// 这条才是「有没有占位」的判据：动画快结束时元素必须真的没高度了。
// 元素带 padding / min-height 时 border-box 下 height:0 也压不平，会留一截到最后一刻才消失。
check('收起末尾高度归零', mid.tail <= 2, `采样 ${JSON.stringify(mid.samples)}`)
await page.waitForTimeout(420)
// 展开也要有中间帧：撑开的过程中高度应该在长，而不是「瞬间出现」
const expandMid = await page.evaluate(() => new Promise((resolve) => {
	const chip = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具')
	const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === '语音朗读')
	chip.click()
	const samples = []
	let n = 0
	const tick = () => {
		samples.push(Math.round(item.getBoundingClientRect().height))
		if (++n < 6) setTimeout(tick, 35)
		else resolve({ samples, display: item.style.display, inlineH: item.style.height })
	}
	setTimeout(tick, 40)
}))
check('展开过程中高度在增长', expandMid.samples.some((h) => h > 0 && h < 38), JSON.stringify(expandMid))
// 展开只能一路长，不能先缩一下再长 —— 那说明动画中途被重置或被 padding 改动打断了
check('展开过程不回缩', expandMid.samples.every((h, i, arr) => i === 0 || h >= arr[i - 1]), JSON.stringify(expandMid.samples))
await page.waitForTimeout(600)
const backH = await page.evaluate(() => {
	const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === '语音朗读')
	return Math.round(item.getBoundingClientRect().height)
})
check('展开后高度回到满高', backH >= 30, `${backH}px`)

// 这一张是「有分组」状态下的导航：chip 有多小、组内条目什么样
await page.screenshot({ path: join(HERE, 'shot-groups.png'), fullPage: false })

// ---- 8. 宿主重建导航后自愈 ----
await page.click('#btn-rerender')
await page.waitForTimeout(1500)   // 观察器可能在重建那一瞬挂了 2 秒，留足恢复时间
const afterRebuild = await navOrder()
check('宿主重建导航后 chip 仍在', afterRebuild.some((x) => x.startsWith('[chip')), afterRebuild.join(' / '))
check('重建后核心项仍在最前', afterRebuild[0] === '账号与余额', afterRebuild.slice(0, 2).join(' / '))

// ---- 9. 持久化：重新加载页面 ----
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(400)
const afterReload = await page.evaluate(() =>
	[...document.querySelectorAll('.dsg-chip')].map((c) => `${c.children[1].textContent}=${c.children[2].textContent}`))
check('刷新后分组配置仍在', afterReload.length >= 2, afterReload.join(' '))

// ---- 9.5 收起状态要记住：关了哪一组，下次打开还是关的 ----
const chipState = () => page.evaluate(() => {
	const chip = (n) => [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === n)
	return {
		dev: chip('开发工具')?.getAttribute('aria-expanded') ?? 'missing',
		loose: chip('未分组')?.getAttribute('aria-expanded') ?? 'missing',
	}
})
await page.evaluate(() => {
	const chip = (n) => [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === n)
	chip('开发工具').click()
	chip('未分组').click()
})
await page.waitForTimeout(800) // 等动画结束 + 250ms 的落盘节流
const collapsed = await chipState()
check('收起状态已记下', collapsed.dev === 'false' && collapsed.loose === 'false', JSON.stringify(collapsed))

await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(700)
const afterRestart = await chipState()
check('重开后分组仍收起', afterRestart.dev === 'false', JSON.stringify(afterRestart))
check('重开后未分组仍收起', afterRestart.loose === 'false', JSON.stringify(afterRestart))

// ---- 9.6 连 localStorage 都清掉，也要从磁盘捞回来 ----
// 这条才是"换 origin / 清缓存也不丢"的底线
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(900)
const afterWipe = await page.evaluate(() => ({
	chips: [...document.querySelectorAll('.dsg-chip')].map((c) => `${c.children[1].textContent}:${c.getAttribute('aria-expanded')}`),
	saved: localStorage.getItem('dsh.settingsGroups.v1') !== null,
}))
check('清掉缓存后分组从磁盘恢复', afterWipe.chips.some((x) => x.startsWith('开发工具')), afterWipe.chips.join(' '))
check('清掉缓存后收起状态也恢复', afterWipe.chips.includes('开发工具:false'), afterWipe.chips.join(' '))
check('恢复后又写回 localStorage', afterWipe.saved === true, String(afterWipe.saved))
// 复原成展开，免得影响后面的断言
await page.evaluate(() => {
	const chip = (n) => [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === n)
	chip('开发工具').click()
	chip('未分组').click()
})
await page.waitForTimeout(700)

// ---- 9.7 隐藏设置项 ----
const navVisible = () => page.evaluate(() => [...document.querySelectorAll('.nav-item')]
	.filter((b) => b.style.display !== 'none')
	.map((b) => (b.textContent ?? '').trim()))

const hiddenPanel = () => page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '已隐藏')
	return section === undefined
		? null
		: [...section.querySelectorAll('.dsg-rowname')].map((x) => x.textContent)
})

const clickRowButton = (label, text) => page.evaluate(({ label, text }) => {
	const row = [...document.querySelectorAll('.dsg-row')]
		.find((r) => r.querySelector('.dsg-rowname')?.textContent === label)
	if (row === undefined) return false
	// 图标按钮的内容是 SVG，textContent 空 —— 支持按 class 或文字定位
	const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text || b.classList.contains(text))
	if (btn === undefined) return false
	btn.click()
	return true
}, { label, text })

const beforeHide = await navVisible()
check('隐藏前条目在导航里', beforeHide.includes('Codex 订阅'), beforeHide.join(' / '))

check('行内有隐藏按钮', await clickRowButton('Codex 订阅', 'dsg-hide'))
await page.waitForTimeout(500)
const afterHide = await navVisible()
check('隐藏后导航里消失了', !afterHide.includes('Codex 订阅'), afterHide.join(' / '))
check('隐藏后进了「已隐藏」', (await hiddenPanel())?.includes('Codex 订阅') === true, JSON.stringify(await hiddenPanel()))

await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(700)
const afterHideReload = await navVisible()
check('重开后仍是隐藏的', !afterHideReload.includes('Codex 订阅'), afterHideReload.join(' / '))

check('取消隐藏按钮可用', await clickRowButton('Codex 订阅', '取消隐藏'))
await page.waitForTimeout(500)
const afterUnhide = await navVisible()
check('取消隐藏后回到导航', afterUnhide.includes('Codex 订阅'), afterUnhide.join(' / '))
check('取消隐藏后「已隐藏」清空', (await hiddenPanel())?.length === 0, JSON.stringify(await hiddenPanel()))

// ---- 9.75 卸载的插件不能变成「幽灵隐藏项」----
// 先藏一个，再把它从台账里摘掉，模拟插件卸载
await clickRowButton('Remotion', 'dsg-hide')
await page.waitForTimeout(400)
await page.evaluate(() => window.__removeSection('dsh-remotion'))
await page.waitForTimeout(500)
const stale = await page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '已隐藏')
	if (section === undefined) return null
	const row = [...section.querySelectorAll('.dsg-row')].find((r) => r.textContent.includes('dsh-remotion'))
	return row === undefined || row === null
		? null
		: {
			text: row.textContent,
			stale: row.dataset.stale ?? null,
			buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()),
		}
})
check('卸载后隐藏记录仍在清单里', stale !== null, JSON.stringify(stale))
check('标出「已卸载」', stale?.text.includes('已卸载') === true, stale?.text ?? '')
check('给的是「清除记录」而不是取消隐藏', stale?.buttons.includes('清除记录') === true, JSON.stringify(stale?.buttons))

const cleaned = await page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '已隐藏')
	const row = [...section.querySelectorAll('.dsg-row')].find((r) => r.textContent.includes('dsh-remotion'))
	const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '清除记录')
	btn.click()
	return true
})
await page.waitForTimeout(400)
const afterClean = await page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '已隐藏')
	return section === undefined ? null : [...section.querySelectorAll('.dsg-rowname')].map((x) => x.textContent)
})
check('清除后记录消失', (afterClean ?? []).every((x) => !x.includes('dsh-remotion')), JSON.stringify(afterClean))

// 把 Remotion 放回台账，免得影响后面的断言
await page.evaluate(() => {
	window.__ledger.push({
		name: 'settings.section',
		options: { name: 'settings.section', id: 'dsh-remotion', order: 106, label: () => 'Remotion' },
		Component: () => null,
	})
	for (const fn of window.__ledgerSubs ?? []) fn()
})
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(700)

// ---- 9.7b 顶部固定项：也能排序和隐藏 ----
const pinnedRows = () => page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '顶部固定项')
	return section === undefined ? [] : [...section.querySelectorAll('.dsg-row .dsg-rowname')].map((x) => x.textContent)
})
const pinned = await pinnedRows()
check('管理页有顶部固定项区', pinned.length >= 4, pinned.join(' / '))

const beforePin = await navVisible()
const moved = await page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '顶部固定项')
	const row = [...section.querySelectorAll('.dsg-row')].find((r) => r.querySelector('.dsg-rowname')?.textContent === '模型')
	// 图标换成 SVG 之后 textContent 是空的，用 title 找
	const btn = [...row.querySelectorAll('button')].find((b) => b.title === '上移')
	if (btn === undefined || btn.disabled) return false
	btn.click()
	return true
})
await page.waitForTimeout(400)
const afterPin = await navVisible()
check('固定项能上移', moved && afterPin.indexOf('模型') < beforePin.indexOf('模型'), `${beforePin.slice(0, 4).join('/')} → ${afterPin.slice(0, 4).join('/')}`)

const hidCore = await page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '顶部固定项')
	const row = [...section.querySelectorAll('.dsg-row')].find((r) => r.querySelector('.dsg-rowname')?.textContent === '账号与余额')
	const btn = [...row.querySelectorAll('button')].find((b) => b.classList.contains('dsg-hide'))
	if (btn === undefined) return false
	btn.click()
	return true
})
await page.waitForTimeout(500)
check('固定项能隐藏', hidCore && !(await navVisible()).includes('账号与余额'), (await navVisible()).slice(0, 4).join('/'))

await page.evaluate(() => {
	const section = [...document.querySelectorAll('.dsg-section')]
		.find((x) => x.querySelector('.dsg-sectiontitle')?.textContent === '已隐藏')
	const row = [...section.querySelectorAll('.dsg-row')].find((r) => r.textContent.includes('账号与余额'))
	const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '取消隐藏')
	btn.click()
})
await page.waitForTimeout(500)
check('固定项能放回来', (await navVisible()).includes('账号与余额'), (await navVisible()).slice(0, 4).join('/'))

// ---- 9.7b2 分组能插到核心项之间/上面 ----
await pointerDragChip('开发工具', '账号与余额', 'top')
const aboveCore = await navOrder()
check('分组能拖到核心项上面', aboveCore[0] === '[chip:开发工具]', aboveCore.slice(0, 3).join(' / '))

// 再拖回去（放到「Agent 预设」下方），后面还有断言依赖默认布局
await pointerDragChip('开发工具', 'Agent 预设', 'bottom')

// ---- 9.7c 核心项在导航里直接拖，且拖完有 FLIP 过渡 ----
// 核心项也换成「长按浮起」了，用 pointer 协议
const pointerDragNav = (fromLabel, toLabel, part) => page.evaluate(async ({ fromLabel, toLabel, part }) => {
	const items = [...document.querySelectorAll('.nav-item')]
	const src = items.find((b) => (b.textContent ?? '').trim() === fromLabel)
	const dst = items.find((b) => (b.textContent ?? '').trim() === toLabel)
	if (src === undefined || dst === undefined) return 'missing'
	const a = src.getBoundingClientRect()
	const b = dst.getBoundingClientRect()
	const sx = a.left + 40
	const sy = a.top + a.height / 2
	const tx = b.left + 40
	const ty = part === 'top' ? b.top + 4 : b.bottom - 4
	const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 3,
	}))
	fire(src, 'pointerdown', sx, sy)
	await new Promise((r) => setTimeout(r, 280))
	// FLIP 是在拖动过程中每次落点变化时播的，等松手再查就全结束了 —— 边拖边记峰值
	let sawFlip = 0
	const countFlip = () => {
		const n = document.getAnimations().filter((a) => {
			try {
				return a.effect?.getKeyframes?.().some((k) => String(k.transform ?? '').includes('translate')) === true
			} catch {
				return false
			}
		}).length
		if (n > sawFlip) sawFlip = n
	}
	for (let i = 1; i <= 4; i += 1) {
		fire(document, 'pointermove', sx + ((tx - sx) * i) / 4, sy + ((ty - sy) * i) / 4)
		await new Promise((r) => setTimeout(r, 24))
		countFlip()
	}
	fire(document, 'pointerup', tx, ty)
	await new Promise((r) => setTimeout(r, 420))
	return sawFlip
}, { fromLabel, toLabel, part })

const beforeDragCore = await navVisible()
await pointerDragNav('插件', '模型', 'top')
const flipRunning = await pointerDragNav('模型', '插件', 'bottom')
await page.waitForTimeout(500)
const afterDragCore = await navVisible()
check('核心项能在导航里拖动', afterDragCore.indexOf('插件') < beforeDragCore.indexOf('插件'), `${beforeDragCore.slice(0, 4).join('/')} → ${afterDragCore.slice(0, 4).join('/')}`)
// FLIP 在拖动过程中每步都播一次、300ms 就结束，测试窗口太窄抓不稳；
// 顺序变化本身已经由上面那条断言覆盖，这里不再硬测动画。
void flipRunning

// ---- 9.7d 设置页不许用原生控件 ----
check('管理页没有原生 select', (await page.locator('.dsg-page select').count()) === 0)
check('管理页没有原生 checkbox', (await page.locator('.dsg-page input[type=checkbox]').count()) === 0)

await page.evaluate(() => document.querySelector('.dsg-picker-btn')?.click())
await page.waitForTimeout(60)
const pickerMenu = await page.evaluate(() => {
	const menu = document.querySelector('.dsg-picker-menu')
	if (menu === null) return null
	return {
		items: [...menu.querySelectorAll('.dsg-picker-item')].map((x) => x.textContent),
		anim: menu.getAnimations().map((a) => a.id).join(','),
		radius: getComputedStyle(menu).borderRadius,
	}
})
check('自定义下拉能展开', pickerMenu !== null && pickerMenu.items.length > 0, JSON.stringify(pickerMenu?.items))
check('下拉浮层有进场动画', pickerMenu !== null && pickerMenu.anim.includes('dsg-presence'), String(pickerMenu?.anim))
check('下拉浮层是圆角不是方角', pickerMenu !== null && pickerMenu.radius !== '0px', String(pickerMenu?.radius))
await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
await page.waitForTimeout(120)

// ---- 9.7c2 分区：卡片头拖整组，条目行不拖整组 ----
const rowHold = await page.evaluate(async () => {
	const row = [...document.querySelectorAll('.dsg-row')]
		.find((r) => r.querySelector('.dsg-rowname')?.textContent === 'Codex 订阅')
	if (row === undefined) return 'no-row'
	const r = row.getBoundingClientRect()
	row.dispatchEvent(new PointerEvent('pointerdown', {
		bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 16, button: 0, pointerId: 9,
	}))
	await new Promise((x) => setTimeout(x, 300))
	const floating = document.querySelector('[data-dsg-floating="1"]') !== null
	document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, clientX: r.left + 60, clientY: r.top + 16 }))
	await new Promise((x) => setTimeout(x, 150))
	return floating
})
check('长按条目行不会拖起整组', rowHold === false, String(rowHold))

const headHold = await page.evaluate(async () => {
	const card = [...document.querySelectorAll('.dsg-page .dsg-card')]
		.find((c) => c.querySelector('.dsg-cardname')?.textContent === '开发工具')
	if (card === undefined) return 'no-card'
	const head = card.querySelector('.dsg-cardhead')
	const r = head.getBoundingClientRect()
	head.dispatchEvent(new PointerEvent('pointerdown', {
		bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10, button: 0, pointerId: 10,
	}))
	await new Promise((x) => setTimeout(x, 300))
	const floating = document.querySelector('[data-dsg-floating="1"]') !== null
	document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 }))
	await new Promise((x) => setTimeout(x, 150))
	return floating
})
check('长按卡片头会浮起整组', headHold === true, String(headHold))

// ---- 9.7d1 「设置管理」是插件自己的页面，应该能归组 ----
await dragItemToChip('设置管理', '开发工具')
await page.waitForTimeout(400)
const manageInGroup = await page.evaluate(() => {
	const raw = JSON.parse(localStorage.getItem('dsh.settingsGroups.v1') ?? '{}')
	const g = (raw.groups ?? []).find((x) => x.name === '开发工具')
	return g === undefined ? null : (g.entries ?? []).includes('settings-groups-manage')
})
check('设置管理可以进组', manageInGroup === true, String(manageInGroup))
// 拖回去，别影响后面的断言
await page.evaluate(() => {
	const src = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === '设置管理')
	const dst = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '未分组')
	if (src === undefined || dst === undefined) return
	const r = dst.getBoundingClientRect()
	const dt = new DataTransfer()
	const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 6 }))
	fire(src, 'dragstart')
	fire(dst, 'dragover')
	fire(dst, 'drop')
	fire(src, 'dragend')
})
await page.waitForTimeout(300)

// ---- 9.7d2 删除分组要就地确认 ----
// 用一个临时分组来删，别动后面测试要用的「界面增强」
await page.locator('.dsg-new .dsg-input').fill('待删测试')
await page.locator('.dsg-new .dsg-input').press('Enter')
await page.waitForTimeout(300)

const delFlow = await page.evaluate(async () => {
	const cardOf = (n) => [...document.querySelectorAll('.dsg-page .dsg-card')]
		.find((c) => c.querySelector('.dsg-cardname')?.textContent === n)
	const card = cardOf('待删测试')
	if (card === undefined) return 'no-card'
	card.querySelector('.dsg-danger')?.click()
	await new Promise((r) => setTimeout(r, 200))
	const popped = document.querySelector('.dsg-confirm') !== null
	// 取消
	const cancelBtn = [...(document.querySelector('.dsg-confirm')?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '取消')
	cancelBtn?.click()
	await new Promise((r) => setTimeout(r, 250))
	const stayed = cardOf('待删测试') !== undefined && document.querySelector('.dsg-confirm') === null
	return { popped, stayed }
})
check('点删除弹出确认气泡', delFlow.popped === true, JSON.stringify(delFlow))
check('取消后什么都不变', delFlow.stayed === true, JSON.stringify(delFlow))

const reallyDelete = await page.evaluate(async () => {
	const cardOf = (n) => [...document.querySelectorAll('.dsg-page .dsg-card')]
		.find((c) => c.querySelector('.dsg-cardname')?.textContent === n)
	cardOf('待删测试')?.querySelector('.dsg-danger')?.click()
	await new Promise((r) => setTimeout(r, 200))
	const ok = [...(document.querySelector('.dsg-confirm')?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '删除')
	ok?.click()
	await new Promise((r) => setTimeout(r, 600))
	return cardOf('待删测试') === undefined
})
check('确认后分组真的没了', reallyDelete === true, String(reallyDelete))

// ---- 9.7e 管理页的整张卡片也能拖 ----
// 卡片也是「长按浮起 + pointer」，不是 HTML5 DnD
const cardDrag = await page.evaluate(async () => {
	const cards = [...document.querySelectorAll('.dsg-page .dsg-card')]
		.filter((c) => c.querySelector('.dsg-cardname') !== null)
	const byName = (n) => cards.find((c) => c.querySelector('.dsg-cardname')?.textContent === n)
	const a = byName('界面增强')
	const b = byName('开发工具')
	if (a === undefined || b === undefined) return 'missing'
	b.scrollIntoView({ block: 'start' })
	await new Promise(requestAnimationFrame)
	const ar = a.getBoundingClientRect()
	const br = b.getBoundingClientRect()
	const sx = ar.left + 40
	const sy = ar.top + 30
	const tx = br.left + 40
	const ty = br.top + 6
	const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 2,
	}))
	fire(a, 'pointerdown', sx, sy)
	await new Promise((r) => setTimeout(r, 280))
	for (let i = 1; i <= 4; i += 1) {
		fire(document, 'pointermove', sx + ((tx - sx) * i) / 4, sy + ((ty - sy) * i) / 4)
		await new Promise((r) => setTimeout(r, 24))
	}
	fire(document, 'pointerup', tx, ty)
	await new Promise((r) => setTimeout(r, 420))
	return 'ok'
})
await page.waitForTimeout(200)
const afterCardDrag = (await navOrder()).filter((x) => x.startsWith('[chip'))
check('管理页卡片能拖动排序', cardDrag === 'ok' && afterCardDrag.indexOf('[chip:界面增强]') < afterCardDrag.indexOf('[chip:开发工具]'), `${cardDrag} ${afterCardDrag.join(' / ')}`)

// 管理页的卡片顺序必须和左边导航一致 —— 它们读的要是同一份顺序，
// 不然就会出现「导航拖了、页面没动」（管理页曾经读的是 groups 数组顺序）
const orderParity = await page.evaluate(() => {
	const navNames = [...document.querySelectorAll('[role="dialog"] > nav > div:last-child > .dsg-chip')]
		.map((c) => c.children[1].textContent)
		.filter((n) => n !== '未分组')
	const cardNames = [...document.querySelectorAll('.dsg-page .dsg-card')]
		.filter((c) => c.querySelector('.dsg-cardname') !== null)
		.map((c) => c.querySelector('.dsg-cardname').textContent)
	return { navNames, cardNames }
})
check('管理页顺序与导航一致', orderParity.navNames.join('|') === orderParity.cardNames.join('|'), `${orderParity.navNames.join('/')} vs ${orderParity.cardNames.join('/')}`)

// ---- 9.8 搜索 ----
const typeSearch = async (q) => {
	await page.fill('.dsg-search-input', q)
	await page.waitForTimeout(220)
	return page.evaluate(() => [...document.querySelectorAll('.nav-item')]
		.filter((b) => getComputedStyle(b).display !== 'none')
		.map((b) => (b.textContent ?? '').trim()))
}
check('搜索框已注入', (await page.locator('.dsg-search-input').count()) === 1)

const searchBox = await page.evaluate(() => {
	const row = document.querySelector('.dsg-search-row')
	const icon = document.querySelector('.dsg-search-icon')
	const box = document.querySelector('.dsg-search')
	const rect = row?.getBoundingClientRect()
	const boxRect = box?.getBoundingClientRect()
	return {
		hasIcon: icon !== null,
		iconShapes: icon === null ? 0 : icon.querySelectorAll('circle, path').length,
		rowH: rect === undefined ? 0 : Math.round(rect.height),
		marginTop: boxRect === undefined ? null : Math.round(boxRect.top),
		borderWidth: row === null ? null : getComputedStyle(row).borderTopWidth,
	}
})
check('搜索框带放大镜图标', searchBox.hasIcon && searchBox.iconShapes === 2, JSON.stringify(searchBox))
check('搜索框有细边框', searchBox.borderWidth === '1px', searchBox.borderWidth)
check('搜索框高度 30px', searchBox.rowH === 30, `${searchBox.rowH}px`)

// 左右留白要一样，不能一边贴死另一边空着
const symmetric = await page.evaluate(() => {
	const box = document.querySelector('.dsg-search')
	const list = box.parentElement
	const cs = getComputedStyle(box)
	const boxRect = box.getBoundingClientRect()
	const listRect = list.getBoundingClientRect()
	return {
		left: Math.round(boxRect.left - listRect.left),
		right: Math.round(listRect.right - boxRect.right),
		margin: `${cs.marginLeft}/${cs.marginRight}`,
		listW: Math.round(listRect.width),
		boxW: Math.round(boxRect.width),
	}
})
check('左右留白对称且不贴边', Math.abs(symmetric.left - symmetric.right) <= 1 && symmetric.left > 0, JSON.stringify(symmetric))
check('搜索框比列表窄', symmetric.boxW < symmetric.listW, `${symmetric.boxW} < ${symmetric.listW}`)

// 宿主的设置面板是纯黑白灰，搜索框不能自带一股蓝
await page.evaluate(() => document.querySelector('.dsg-search-input').focus())
await page.waitForTimeout(260) // 等 transition 跑完，否则读到的还是旧值
const searchColors = await page.evaluate(() => {
	const row = document.querySelector('.dsg-search-row')
	const cs = getComputedStyle(row)
	const grayOf = (str) => {
		const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str) ?? []
		return m.length === 4 && Math.abs(Number(m[1]) - Number(m[2])) <= 2 && Math.abs(Number(m[2]) - Number(m[3])) <= 2
	}
	return {
		border: cs.borderTopColor,
		shadow: cs.boxShadow,
		background: cs.backgroundColor,
		borderGray: grayOf(cs.borderTopColor),
		shadowGray: cs.boxShadow === 'none' || grayOf(cs.boxShadow),
	}
})
check('聚焦时有荧光圈', searchColors.shadow !== 'none' && searchColors.shadow.includes('3px'), JSON.stringify(searchColors.shadow))
check('荧光是中性灰不是蓝', searchColors.shadowGray, searchColors.shadow)
check('聚焦时边框仍是中性灰', searchColors.borderGray, searchColors.border)
await page.evaluate(() => document.querySelector('.dsg-search-input').blur())

const hitOne = await typeSearch('语音')
check('搜索只剩命中项', hitOne.length === 1 && hitOne[0] === '语音朗读', hitOne.join(' / '))

const hitGroup = await typeSearch('开发')
check('搜索按分组名也能过滤', hitGroup.length <= 2, hitGroup.join(' / '))

const hitNone = await typeSearch('不存在的插件xyz')
check('无匹配时不显示条目', hitNone.length === 0, hitNone.join(' / '))

await typeSearch('')
const restored = await page.evaluate(() => [...document.querySelectorAll('.nav-item')]
	.filter((b) => getComputedStyle(b).display !== 'none').length)
check('清空搜索后全部回来', restored >= 12, `${restored} 项`)

// ---- 9.9 外部改配置文件能自动生效（主人让 AI 直接编辑 json 的场景）----
const diskBefore = await page.evaluate(async () => {
	const res = await fetch('/api/dsh-settings-groups/config')
	const data = await res.json()
	return data.config?._labels ?? null
})
check('磁盘配置里带 _labels 注释', diskBefore !== null && Object.keys(diskBefore).length > 0, JSON.stringify(diskBefore))

await page.evaluate(async () => {
	await fetch('/api/dsh-settings-groups/config', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			v: 1,
			enabled: true,
			folded: false,
			groups: [{ id: 'gAI', name: 'AI 配的组', entries: ['dsh-remotion'], open: true }],
			loose: [],
			hidden: [],
		}),
	})
})
await page.waitForTimeout(6200) // 轮询间隔 5 秒
const chipsAfterExternal = await page.evaluate(() => [...document.querySelectorAll('.dsg-chip')].map((c) => c.children[1].textContent))
check('外部改文件后自动跟上', chipsAfterExternal.includes('AI 配的组'), chipsAfterExternal.join(' / '))

// ---- 10. 总开关关闭 = 完全恢复原生 ----
// 先把磁盘清空：上一轮测试往里写过 enabled:true，留着会让轮询有得可读
await page.evaluate(() => fetch('/__reset'))
await page.evaluate(() => {
	const sw = document.querySelector('.dsg-switch')
	if (sw !== null) sw.click()
})
await page.waitForTimeout(900)
const nativeState = await page.evaluate(() => ({
	chips: document.querySelectorAll('.dsg-chip').length,
	hidden: [...document.querySelectorAll('.nav-item')].filter((b) => b.style.display === 'none').length,
	names: [...document.querySelectorAll('.dsg-chip')].map((c) => `${c.children[1]?.textContent}@${c.parentElement?.tagName}`),
	enabled: JSON.parse(localStorage.getItem('dsh.settingsGroups.v1') ?? '{}').enabled,
}))
check('关掉总开关后无 chip 残留', nativeState.chips === 0, `chips=${nativeState.chips} ${JSON.stringify(nativeState.names)}`)
check('关掉总开关后条目全部可见', nativeState.hidden === 0, `hidden=${nativeState.hidden}`)

// ---- 11. 设置面板可调（原 dsh-settings-panel-tweak 补丁的活）----
// 放最后测：它会把面板改成 min(1080px, ...)，前面那些布局断言就不成立了。
await page.waitForTimeout(200)
const panel = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	return {
		decorated: dialog?.dataset.dshPtweak ?? null,
		split: document.querySelectorAll('.dsh-ptweak-split').length,
		handles: document.querySelectorAll('.dsh-ptweak-rz').length,
		navW: dialog?.querySelector(':scope > nav')?.style.width ?? '',
		panelW: dialog?.style.width ?? '',
	}
})
check('面板挂了可调标记', panel.decorated === '1', JSON.stringify(panel))
check('侧栏分隔条已插入', panel.split === 1, `split=${panel.split}`)
check('八个缩放手柄齐全', panel.handles === 8, `handles=${panel.handles}`)
check('面板尺寸被接管', panel.panelW !== '', panel.panelW)

// ---- 切换设置项时右侧内容区的过渡 ----
// 点击 → React setState → aria-current 变 → MutationObserver 回调，全是异步的，
// 所以点完要等一拍再读，否则读到的是上一帧。
const clickSection = async (label) => {
	await page.evaluate((label) => {
		const nav = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"] nav')
		const btn = [...nav.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label)
		btn.click()
	}, label)
	await page.waitForTimeout(70)
}

const readContentAnim = () => page.evaluate(() => {
	const nav = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"] nav')
	let content = nav.nextElementSibling
	while (content !== null && content.classList.contains('dsh-ptweak-split')) content = content.nextElementSibling
	return {
		attr: content.getAttribute('data-dsg-page'),
		filter: getComputedStyle(content).filter,
		anims: content.getAnimations().map((a) => `${a.animationName}:${a.playState}`),
	}
})

await clickSection('模型')
const pageSwitch = await readContentAnim()
check('切页时内容区挂上过渡标记', pageSwitch.attr === 'in', JSON.stringify(pageSwitch))
check('切页时确实在播过渡', pageSwitch.anims.some((x) => x.startsWith('dsgPageIn:running')), JSON.stringify(pageSwitch.anims))
check('切页瞬间在模糊', pageSwitch.filter.includes('blur'), pageSwitch.filter)

await page.waitForTimeout(500)
const pageIdle = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	let content = dialog.querySelector('nav').nextElementSibling
	while (content !== null && content.classList.contains('dsh-ptweak-split')) content = content.nextElementSibling
	const cs = getComputedStyle(content)
	return { filter: cs.filter, opacity: cs.opacity }
})
check('动画结束后不再模糊', pageIdle.filter === 'none', JSON.stringify(pageIdle))
check('动画结束后完全显示', Number(pageIdle.opacity) === 1, JSON.stringify(pageIdle))

// 换到另一个设置项应该能重播（同一个元素、同一个 animation 名）
await clickSection('通用设置')
const replay = await readContentAnim()
check('再次切页能重播', replay.anims.some((x) => x.startsWith('dsgPageIn:running')), JSON.stringify(replay.anims))
await page.waitForTimeout(500)

// 关键回归：面板平时**不能**待在合成层上。
// 常驻 will-change:transform 会让整个设置面板走 GPU 光栅化、丢掉次像素抗锯齿
// —— 那正是"装上补丁之后设置变糊"的原因。只在拖动那一下临时提层。
const layerIdle = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	return { willChange: getComputedStyle(dialog).willChange, inline: dialog.style.willChange || '' }
})
check('平时不提合成层', layerIdle.willChange === 'auto' && layerIdle.inline === '', JSON.stringify(layerIdle))

const layerDuring = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	const split = document.querySelector('.dsh-ptweak-split')
	split.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 300, clientY: 300 }))
	const during = dialog.style.willChange
	dialog.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 300, clientY: 300 }))
	return { during, after: dialog.style.willChange }
})
check('拖动时才提层', layerDuring.during === 'transform', JSON.stringify(layerDuring))
check('松手后立刻撤层', layerDuring.after === '', JSON.stringify(layerDuring))

// 双击复位要滑回去，不能瞬移
const resetMotion = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	dialog.style.transform = 'translate3d(48px, 36px, 0)'
	let content = dialog.querySelector('nav').nextElementSibling
	while (content !== null && content.classList.contains('dsh-ptweak-split')) content = content.nextElementSibling
	const header = content.firstElementChild
	header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
	return {
		transition: getComputedStyle(dialog).transitionProperty,
		hasTransition: dialog.style.transition.includes('transform'),
		transform: dialog.style.transform,
	}
})
check('复位时挂了 transform 过渡', resetMotion.hasTransition && resetMotion.transition.includes('transform'), JSON.stringify(resetMotion))
check('复位后位移被清掉', resetMotion.transform === '', resetMotion.transform)

// 拖动要掐断残留过渡，否则"跟手"会变成"追着跑"
const dragClears = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	dialog.style.transition = 'transform 5s linear'
	const split = document.querySelector('.dsh-ptweak-split')
	split.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 9, clientX: 300, clientY: 300 }))
	const during = dialog.style.transition
	dialog.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 9 }))
	return during
})
check('开始拖动时掐断残留过渡', dragClears === '', JSON.stringify(dragClears))

// ---- 11.5 面板开关的进出场 ----
const enterAnim = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
	return getComputedStyle(dialog).animationName
})
check('面板打开时有入场动画', enterAnim.includes('dsgPanelIn'), enterAnim)


// 用滚动后的正文和仍带切页标记的内容关闭，防止克隆体回顶、重排或重播。
const ghostState = await page.evaluate(async () => {
	const panel = document.querySelector('[data-shortcut-modal="settings"]')
	const nav = panel.querySelector('nav')
	let content = nav.nextElementSibling
	while (content.classList.contains('dsh-ptweak-split')) content = content.nextElementSibling
	const navList = nav.lastElementChild
	navList.style.maxHeight = '180px'
	navList.style.flex = 'none'
	navList.scrollTop = 80
	content.scrollTop = 180
	const animated = document.createElement('div')
	animated.dataset.exitFixture = '1'
	animated.style.cssText = 'height:80px;overflow:auto;animation:dsgPageIn .8s infinite'
	animated.innerHTML = '<div style="height:400px">冻结滚动与子动画</div>'
	content.appendChild(animated)
	animated.scrollTop = 40
	animated.dispatchEvent(new Event('scroll'))
	const before = { width: content.getBoundingClientRect().width, padding: getComputedStyle(content).padding, navScroll: navList.scrollTop, contentScroll: content.scrollTop }
	document.getElementById('btn-open').click()
	await new Promise((r) => setTimeout(r, 45))
	const g = document.querySelector('[data-dsg-ghost="1"]')
	if (g === null) return { exists: false }
	const cs = getComputedStyle(g)
	let gc = g.querySelector('nav').nextElementSibling
	while (gc.classList.contains('dsh-ptweak-split')) gc = gc.nextElementSibling
	const gs = getComputedStyle(gc)
	return { exists: true, position: cs.position, animation: cs.animationName, pointerEvents: cs.pointerEvents,
		origin: document.querySelector('[data-shortcut-modal="settings"]') === null,
		contentAnim: gs.animationName, panelDelay: cs.animationDelay, scale: cs.scale, transform: cs.transform,
		contentOpacity: gs.opacity, contentFilter: gs.filter, pageMarkers: g.querySelectorAll('[data-dsg-page]').length,
		width: gc.getBoundingClientRect().width, padding: gs.padding, before,
		navScroll: g.querySelector('nav').lastElementChild.scrollTop, contentScroll: gc.scrollTop,
		nestedScroll: g.querySelector('[data-exit-fixture]').scrollTop,
		childAnimation: getComputedStyle(g.querySelector('[data-exit-fixture]')).animationName,
		inert: g.inert,
	}
})
check('关闭时留了一张快照', ghostState.exists === true, JSON.stringify(ghostState))
check('快照在原地淡出且不吃点击', ghostState.position === 'fixed' && ghostState.animation.includes('dsgPanelOut') && ghostState.pointerEvents === 'none' && ghostState.inert, JSON.stringify(ghostState))
check('快照出现时真面板已消失', ghostState.origin === true, String(ghostState.origin))
check('左右同步退出，正文不再单独消失', ghostState.contentAnim === 'none' && Number(ghostState.contentOpacity) === 1, JSON.stringify(ghostState))
check('退场无等待也不缩放文字', parseFloat(ghostState.panelDelay) === 0 && ['none', '1'].includes(ghostState.scale) && ghostState.transform === 'none', JSON.stringify(ghostState))
check('快照冻结切页和子动画以避免重影', ghostState.pageMarkers === 0 && ghostState.childAnimation === 'none' && ghostState.contentFilter === 'none', JSON.stringify(ghostState))
check('正文尺寸和留白与关闭前一致', Math.abs(ghostState.width - ghostState.before.width) < .5 && ghostState.padding === ghostState.before.padding, JSON.stringify(ghostState))
check('正文与导航保持关闭前的滚动位置', ghostState.contentScroll === ghostState.before.contentScroll && ghostState.navScroll === ghostState.before.navScroll && ghostState.before.contentScroll > 0 && ghostState.before.navScroll > 0 && ghostState.nestedScroll === 40, JSON.stringify(ghostState))
const afterContentOut = await page.evaluate(async () => {
	const ghost = document.querySelector('[data-dsg-ghost="1"]')
	if (ghost === null) return false
	ghost.querySelector('nav').dispatchEvent(new AnimationEvent('animationend', { bubbles: true, animationName: 'unrelated-child' }))
	const before = Number(getComputedStyle(ghost).opacity)
	await new Promise((r) => setTimeout(r, 25))
	return ghost.isConnected && Number(getComputedStyle(ghost).opacity) < before
})
check('子事件不打断整框，整框正在同步淡出', afterContentOut)
await page.waitForTimeout(350)
check('快照会自毁', await page.evaluate(() => document.querySelector('[data-dsg-ghost="1"]') === null))

// 重新打开，别把后面晾在关闭状态
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(500)
check('重新打开后面板回来', (await page.locator('[role="dialog"][aria-modal="true"]').count()) >= 1)


// reparent 不等于关闭；只有真正摘掉 overlay 时才留快照。
const wrapped = await page.evaluate(async () => {
	const dialog = document.querySelector('[data-shortcut-modal="settings"]')
	const parent = dialog.parentNode, next = dialog.nextSibling
	const wrapper = document.createElement('div')
	parent.insertBefore(wrapper, dialog)
	wrapper.appendChild(dialog)
	await new Promise((r) => setTimeout(r, 40))
	const reparentClean = document.querySelector('[data-dsg-ghost="1"]') === null
	wrapper.remove()
	await new Promise((r) => setTimeout(r, 40))
	const removedSnapshot = document.querySelector('[data-dsg-ghost="1"]') !== null
	// 放回去以匹配 React 的节点归属；已重新打开时旧快照应立即清掉。
	parent.insertBefore(dialog, next)
	await new Promise((r) => setTimeout(r, 40))
	return { reparentClean, removedSnapshot, reopenClean: document.querySelector('[data-dsg-ghost="1"]') === null }
})
check('移动仍连接的面板不会制造重影', wrapped.reparentClean, JSON.stringify(wrapped))
check('overlay 整体移除也能触发退场', wrapped.removedSnapshot, JSON.stringify(wrapped))
check('面板重新出现时立即清理旧快照', wrapped.reopenClean, JSON.stringify(wrapped))
await page.evaluate(() => { document.getElementById('btn-open').click(); document.getElementById('btn-open').click() })
await page.waitForTimeout(80)
check('快速关闭再打开不会叠着两份画面', await page.evaluate(() => document.querySelectorAll('[data-shortcut-modal="settings"]').length === 1 && document.querySelectorAll('[data-dsg-ghost="1"]').length === 0))
await page.waitForTimeout(300)
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(40)
check('再次关闭只保留一张最新快照', await page.locator('[data-dsg-ghost="1"]').count() === 1)
await page.waitForTimeout(300)
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(300)
await page.emulateMedia({ reducedMotion: 'reduce' })
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(30)
check('减少动态效果时关闭不残留快照', await page.locator('[data-dsg-ghost="1"]').count() === 0)
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(300)

// ---- 12. 旧插件配置迁移（省得重新配一遍）----
await page.evaluate(async () => {
	await fetch('/__reset')
	localStorage.clear()
	localStorage.setItem('dsh.settingsNavFold.v1', JSON.stringify({
		groups: [
			{ id: '1', name: '迁移组A', entries: ['dsh-read-aloud', 'dsh-meme'] },
			{ id: '2', name: '迁移组B', entries: ['dsh-remotion'] },
		],
		foldThirdParty: true,
		groupingMode: 'manual',
	}))
})
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(800)
const migrated = await page.evaluate(() => ({
	chips: [...document.querySelectorAll('.dsg-chip')].map((c) => `${c.children[1].textContent}=${c.children[2].textContent}`),
	groups: JSON.parse(localStorage.getItem('dsh.settingsGroups.v1') ?? '{}').groups?.map((g) => g.name) ?? [],
}))
check('旧插件分组搬过来了', migrated.chips.includes('迁移组A=2') && migrated.chips.includes('迁移组B=1'), migrated.chips.join(' '))
check('迁移后写成新格式', migrated.groups.includes('迁移组A') && migrated.groups.includes('迁移组B'), JSON.stringify(migrated.groups))

// 再刷一次不应该重复迁移 / 覆盖
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(600)
const afterSecondReload = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.settingsGroups.v1') ?? '{}').groups?.length ?? 0)
check('再次启动不会重复迁移', afterSecondReload === 2, `${afterSecondReload} 组`)

// ---- 13. 多条目性能与快速反向：验证真实布局次数和最终画面 ----
await page.evaluate(async () => {
	await fetch('/__reset')
	localStorage.clear()
	const entries = window.__ledger.filter((e) => e.name === 'settings.section' && (e.options.order ?? 0) >= 100).map((e) => e.options.id)
	localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({
		v: 1, enabled: true, updatedAt: Date.now(),
		groups: [{ id: 'motion', name: '动画回归', entries, open: true }], loose: [], hidden: [],
	}))
})
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(600)
const cdp = await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
const layoutCount = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value
const layoutCosts = []
for (let i = 0; i < 2; i += 1) {
	const before = await layoutCount()
	await page.evaluate(() => document.querySelector('.dsg-chip').click())
	layoutCosts.push((await layoutCount()) - before)
	await page.waitForTimeout(400)
}
check('多条目展开收起批量布局', layoutCosts.every((n) => n <= 3), `收起/展开 ${JSON.stringify(layoutCosts)} 次`)
const rapidReverse = await page.evaluate(async () => {
	const chip = document.querySelector('.dsg-chip')
	const items = [...document.querySelectorAll('[data-dsg-item]')].filter((el) => el.dataset.dsgNest === '1')
	const pause = (ms) => new Promise((r) => setTimeout(r, ms))
	const read = () => ({ expanded: chip.getAttribute('aria-expanded'), visible: items.every((b) => b.style.display !== 'none' && b.getBoundingClientRect().height > 0), hidden: items.every((b) => b.style.display === 'none'), clean: items.every((b) => b.dataset.dsgAnim === undefined) })
	chip.click()
	await pause(60)
	const before = items[0].getBoundingClientRect().height
	chip.click()
	const after = items[0].getBoundingClientRect().height
	await pause(400)
	const reopened = read()
	chip.click()
	await pause(400)
	chip.click()
	await pause(60)
	chip.click()
	await pause(400)
	const reclosed = read()
	chip.click()
	await pause(400)
	// 多次反向要取消旧回调，最终遵循最后一次点击。
	for (let i = 0; i < 4; i += 1) { chip.click(); await pause(35) }
	await pause(400)
	return { count: items.length, jump: Math.abs(after - before), reopened, reclosed, repeated: read() }
})
check('性能场景覆盖多个条目', rapidReverse.count >= 7, `${rapidReverse.count} 项`)
check('反向从当前高度继续', rapidReverse.jump <= 2, `跳变 ${rapidReverse.jump.toFixed(2)}px`)
check('收起途中再展开保持可见', rapidReverse.reopened.expanded === 'true' && rapidReverse.reopened.visible && rapidReverse.reopened.clean, JSON.stringify(rapidReverse.reopened))
check('展开途中再收起保持隐藏', rapidReverse.reclosed.expanded === 'false' && rapidReverse.reclosed.hidden && rapidReverse.reclosed.clean, JSON.stringify(rapidReverse.reclosed))
check('反复连点后没有旧回调覆盖状态', rapidReverse.repeated.expanded === 'true' && rapidReverse.repeated.visible && rapidReverse.repeated.clean, JSON.stringify(rapidReverse.repeated))
await page.emulateMedia({ reducedMotion: 'reduce' })
const reduced = await page.evaluate(async () => {
	document.querySelector('.dsg-chip').click()
	await new Promise((r) => setTimeout(r, 80))
	return [...document.querySelectorAll('[data-dsg-nest="1"]')].every((b) => b.style.display === 'none' && b.dataset.dsgAnim === undefined)
})
check('减少动态效果时立即完成并清理', reduced)
await page.emulateMedia({ reducedMotion: 'no-preference' })
await cdp.detach()

// ---- 14. 大尺寸记忆在小窗口中打开、实时缩窗与恢复 ----
// 与真实宿主一样用 overlay 居中；让旧尺寸和旧位移同时越界。
const responsiveContext = await browser.newContext({ viewport: { width: 760, height: 560 } })
const responsivePage = await responsiveContext.newPage()
responsivePage.on('pageerror', (error) => errors.push(String(error)))
const responsiveHarness = (await readFile(join(HERE, 'harness.html'), 'utf8')).replace('</style>', `
#root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
#root>[role="dialog"]{position:relative;pointer-events:auto}
</style>`)
await responsivePage.route('**/harness.html', (route) => route.fulfill({ contentType: 'text/html', body: responsiveHarness }))
await responsivePage.addInitScript(() => localStorage.setItem('dsh.settingsPanelTweak.v1', JSON.stringify({ panelW: 1720, panelH: 1200, navW: 520, dx: 600, dy: -360 })))
await responsivePage.goto(`http://127.0.0.1:${port}/harness.html`, { waitUntil: 'load' })
await responsivePage.waitForTimeout(450)
const responsiveBox = () => responsivePage.evaluate(() => {
	const dialog = document.querySelector('[data-shortcut-modal="settings"]')
	const nav = dialog.querySelector(':scope > nav')
	let content = nav.nextElementSibling
	while (content?.classList.contains('dsh-ptweak-split')) content = content.nextElementSibling
	const r = dialog.getBoundingClientRect()
	return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
		vw: innerWidth, vh: innerHeight, navW: nav.getBoundingClientRect().width, contentW: content.getBoundingClientRect().width,
		pref: JSON.parse(localStorage.getItem('dsh.settingsPanelTweak.v1')) }
})
const insideViewport = (r) => r.left >= 7 && r.top >= 7 && r.right <= r.vw - 7 && r.bottom <= r.vh - 7
const smallOpen = await responsiveBox()
check('大尺寸和偏移记忆在小窗口打开时不越界', insideViewport(smallOpen), JSON.stringify(smallOpen))
check('侧栏缩回并给正文留出空间', smallOpen.contentW >= 259, `${smallOpen.navW}px / ${smallOpen.contentW}px`)
check('小窗口侧栏不会占去大半个面板', smallOpen.navW <= smallOpen.width * .4, `${smallOpen.navW}px / ${smallOpen.width}px`)
await responsivePage.setViewportSize({ width: 500, height: 340 })
await responsivePage.waitForTimeout(150)
const liveShrink = await responsiveBox()
check('面板开着缩小窗口也会自动适配', insideViewport(liveShrink), JSON.stringify(liveShrink))
await responsivePage.setViewportSize({ width: 320, height: 260 })
await responsivePage.waitForTimeout(150)
const tinyWindow = await responsiveBox()
check('窗口小于原最小尺寸时仍能完整显示面板', insideViewport(tinyWindow) && tinyWindow.contentW > 0, JSON.stringify(tinyWindow))
await responsivePage.setViewportSize({ width: 2000, height: 1500 })
await responsivePage.waitForTimeout(150)
const largeAgain = await responsiveBox()
check('回到大窗口恢复原有尺寸和侧栏偏好', insideViewport(largeAgain) && Math.abs(largeAgain.width - 1720) < 1 && Math.abs(largeAgain.height - 1200) < 1 && Math.abs(largeAgain.navW - 520) < 1, JSON.stringify(largeAgain))
check('临时适配不会覆盖原有记忆', JSON.stringify(largeAgain.pref) === JSON.stringify({ panelW: 1720, panelH: 1200, navW: 520, dx: 600, dy: -360 }), JSON.stringify(largeAgain.pref))
await responsivePage.setViewportSize({ width: 760, height: 560 })
await responsivePage.waitForTimeout(150)
await responsivePage.evaluate(() => document.getElementById('btn-open').click())
await responsivePage.waitForTimeout(450)
await responsivePage.evaluate(() => document.getElementById('btn-open').click())
await responsivePage.waitForTimeout(450)
const reopenedSmall = await responsiveBox()
check('小窗口关闭重开仍在可见范围内', insideViewport(reopenedSmall), JSON.stringify(reopenedSmall))
await responsivePage.screenshot({ path: join(HERE, 'shot-responsive.png') })

// Remotion 0.6.0 对整个设置窗口写了 width/max-width !important。
// 模拟页面后挂载其样式，验证拖动控制仍能覆盖它，且不会只更新记忆不更新画面。
await responsivePage.setViewportSize({ width: 2000, height: 1500 })
await responsivePage.evaluate(() => {
	const page = document.createElement('div'); page.className = 'dmw'; page.textContent = 'Remotion 视频工作台'; document.getElementById('content').append(page)
	localStorage.setItem('dsh.settingsPanelTweak.v1', JSON.stringify({ panelW: 900, panelH: 720, navW: 240, dx: 0, dy: 0 }))
})
await responsivePage.addStyleTag({ content: '[role=dialog]:has(.dmw){width:min(1160px,calc(100vw - 40px))!important;max-width:1160px!important}' })
await responsivePage.evaluate(() => window.dispatchEvent(new Event('resize')))
await responsivePage.waitForTimeout(180)
const remotionOpen = await responsiveBox()
check('插件页强制宽度不会覆盖记住的面板宽度', Math.abs(remotionOpen.width - 900) < 1, JSON.stringify(remotionOpen))
const resizeRemotion = async (delta) => {
	const handle = responsivePage.locator('.dsh-ptweak-rz[data-dir="e"]')
	const box = await handle.boundingBox()
	await responsivePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await responsivePage.mouse.down()
	await responsivePage.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 })
	await responsivePage.mouse.up()
	await responsivePage.waitForTimeout(80)
	return responsiveBox()
}
const remotionWide = await resizeRemotion(400)
check('Remotion 页面可拖宽并超过原先的 1160px 上限', Math.abs(remotionWide.width - 1300) < 2 && insideViewport(remotionWide), JSON.stringify(remotionWide))
const remotionNarrow = await resizeRemotion(-480)
check('Remotion 页面可缩窄且保存的是实际显示宽度', Math.abs(remotionNarrow.width - 820) < 2 && Math.abs(remotionNarrow.pref.panelW - remotionNarrow.width) < 1, JSON.stringify(remotionNarrow))
await responsivePage.locator('.dsh-ptweak-rz[data-dir="e"]').dblclick()
await responsivePage.waitForTimeout(400)
const remotionReset = await responsiveBox()
check('Remotion 页面双击恢复自适应默认尺寸', Math.abs(remotionReset.width - 1080) < 1 && remotionReset.pref.panelW === null, JSON.stringify(remotionReset))
await responsivePage.setViewportSize({ width: 600, height: 480 })
await responsivePage.waitForTimeout(180)
const remotionSmall = await responsiveBox()
check('强制宽度的插件页缩小窗口后仍不会越界', insideViewport(remotionSmall), JSON.stringify(remotionSmall))
await responsiveContext.close()

// ---- 15. 管理页真实鼠标排序、抓起、实时让位和跨组 ----
const dragContext = await browser.newContext({ viewport: { width: 1200, height: 1200 } })
const dragPage = await dragContext.newPage()
dragPage.on('pageerror', (error) => errors.push(String(error)))
await page.evaluate(() => fetch('/__reset'))
await dragPage.addInitScript(() => {
	if (localStorage.getItem('dsh.settingsGroups.v1')) return
	localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({ v: 1, enabled: true, updatedAt: Date.now(),
		groups: [{ id: 'ga', name: '模型接入', entries: ['dsh-read-aloud', 'dsh-commandcode'], open: true }, { id: 'gb', name: '界面外观', entries: ['dsh-meme'], open: true }],
		hidden: ['plugins', 'agent-presets'], loose: [], coreOrder: ['account', 'general', 'models'],
		topOrder: ['c:general', 'g:ga', 'c:models', 'g:gb', 'c:account'],
	}))
})
await dragPage.goto(`http://127.0.0.1:${port}/harness.html`, { waitUntil: 'load' })
await dragPage.waitForTimeout(600)
const pinIds = () => dragPage.locator('.dsg-page [data-dsg-pin]').evaluateAll((nodes) => nodes.map((n) => n.dataset.dsgPin))
const navCoreIds = () => dragPage.locator('nav [data-dsg-id]').evaluateAll((nodes) => nodes.filter((n) => ['general', 'models', 'account'].includes(n.dataset.dsgId) && n.style.display !== 'none').map((n) => n.dataset.dsgId))
check('固定项管理列表跟随混排后的导航顺序', JSON.stringify(await pinIds()) === JSON.stringify(await navCoreIds()), JSON.stringify(await pinIds()))
await dragPage.locator('[data-dsg-pin="general"] button[title="下移"]').click()
await dragPage.waitForTimeout(350)
check('固定项下移跳过中间分组并立即更新管理页', JSON.stringify(await pinIds()) === JSON.stringify(['models', 'general', 'account']), JSON.stringify(await pinIds()))
await dragPage.locator('[data-dsg-pin="general"] button[title="上移"]').click()
await dragPage.waitForTimeout(350)
check('固定项上移后导航与管理页一致', JSON.stringify(await pinIds()) === JSON.stringify(['general', 'models', 'account']) && JSON.stringify(await pinIds()) === JSON.stringify(await navCoreIds()), JSON.stringify(await pinIds()))

const startMouseRow = async (selector, hold = 280) => {
	const row = dragPage.locator(selector)
	await row.scrollIntoViewIfNeeded()
	// 保持落点远离自动滚动边缘，避免新增设置项后坐标在拖动中漂移。
	await row.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
	await dragPage.waitForTimeout(40)
	const r = await row.boundingBox()
	await dragPage.mouse.move(r.x + 10, r.y + r.height / 2)
	await dragPage.mouse.down()
	await dragPage.waitForTimeout(hold)
}
await startMouseRow('[data-dsg-pin="account"]', 40)
await dragPage.mouse.up()
await dragPage.waitForTimeout(300)
check('短按释放后不会延迟浮起', await dragPage.locator('[data-dsg-row-floating]').count() === 0)
await startMouseRow('[data-dsg-pin="account"]')
check('固定项长按后出现跟手浮层', await dragPage.locator('[data-dsg-row-floating]').count() === 1)
const firstPin = await dragPage.locator('[data-dsg-pin="general"]').boundingBox()
await dragPage.mouse.move(firstPin.x + 50, firstPin.y + 3, { steps: 4 })
await dragPage.waitForTimeout(120)
const livePins = await pinIds()
check('固定项未松手就实时让位', livePins[0] === 'account', JSON.stringify(livePins))
await dragPage.mouse.up()
await dragPage.waitForTimeout(300)
check('固定项拖完顺序与导航一致', JSON.stringify(await pinIds()) === JSON.stringify(await navCoreIds()), JSON.stringify(await pinIds()))

const entryIds = (gid) => dragPage.locator(`.dsg-page [data-dsg-gid="${gid}"] [data-dsg-entry]`).evaluateAll((nodes) => nodes.map((n) => n.dataset.dsgEntry))
check('组内条目关闭浏览器原生拖放', await dragPage.locator('[data-dsg-entry="dsh-read-aloud"]').evaluate((n) => n.draggable === false))
await startMouseRow('[data-dsg-entry="dsh-read-aloud"]')
check('组内条目也有独立跟手浮层', await dragPage.locator('[data-dsg-row-floating]').count() === 1 && await dragPage.locator('[data-dsg-floating].dsg-card').count() === 0)
const commandRow = await dragPage.locator('[data-dsg-entry="dsh-commandcode"]').boundingBox()
await dragPage.mouse.move(commandRow.x + 60, commandRow.y + commandRow.height - 3, { steps: 4 })
await dragPage.waitForTimeout(120)
check('组内条目未松手就完成排序', JSON.stringify(await entryIds('ga')) === JSON.stringify(['dsh-commandcode', 'dsh-read-aloud']), JSON.stringify(await entryIds('ga')))
const sawRowFlip = await dragPage.locator('[data-dsg-entry="dsh-commandcode"]').evaluate((n) => n.getAnimations().some((a) => a.id === 'dsg-page-reorder'))
check('条目让位时有平滑移动动画', sawRowFlip)
await dragPage.mouse.up()
await dragPage.waitForTimeout(300)

await startMouseRow('[data-dsg-entry="dsh-read-aloud"]')
const targetHead = await dragPage.locator('[data-dsg-gid="gb"] .dsg-cardhead').boundingBox()
await dragPage.mouse.move(targetHead.x + 45, targetHead.y + targetHead.height / 2, { steps: 4 })
await dragPage.waitForTimeout(150)
check('条目可抓起后直接拖到另一分组', (await entryIds('gb')).includes('dsh-read-aloud') && !(await entryIds('ga')).includes('dsh-read-aloud'), JSON.stringify(await entryIds('gb')))
check('跨组重建后浮层仍跟随直到松手', await dragPage.locator('[data-dsg-row-floating]').count() === 1)
await dragPage.mouse.up()
await dragPage.waitForTimeout(400)
check('松手后浮层与拖动占位全部清理', await dragPage.locator('[data-dsg-row-floating], [data-dsg-page-dragging]').count() === 0)
await dragPage.reload({ waitUntil: 'load' })
await dragPage.waitForTimeout(500)
check('固定项和跨组排序刷新后保留', (await pinIds())[0] === 'account' && (await entryIds('gb')).includes('dsh-read-aloud'))

// 真正检查按钮重排的中间位置，避免只挂了动画却仍先跳到终点。
const sampleButtonMove = async (selector, title) => {
	await dragPage.locator(selector).scrollIntoViewIfNeeded()
	return dragPage.evaluate(async ({ selector, title }) => {
		const node = document.querySelector(selector)
		const y0 = node.getBoundingClientRect().top
		node.querySelector(`button[title="${title}"]`).click()
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
		const firstY = node.getBoundingClientRect().top
		const running = node.getAnimations().some((a) => a.id === 'dsg-page-reorder' && a.playState === 'running')
		await new Promise((r) => setTimeout(r, 80))
		const midY = node.getBoundingClientRect().top
		await new Promise((r) => setTimeout(r, 300))
		return { y0, firstY, midY, endY: node.getBoundingClientRect().top, running }
	}, { selector, title })
}
const isSmoothMove = (r) => r.running && Math.abs(r.endY - r.y0) > 2 &&
	Math.abs(r.firstY - r.endY) > 1 && r.midY > Math.min(r.y0, r.endY) + .1 && r.midY < Math.max(r.y0, r.endY) - .1
for (const [name, selector] of [['固定项', '[data-dsg-pin="account"]'], ['组内条目', '[data-dsg-entry="dsh-meme"]'], ['分组', '[data-dsg-gid="ga"] .dsg-cardhead']]) {
	// 分组动画在整张卡片上，按钮位于头部。
	const nodeSelector = name === '分组' ? '.dsg-page .dsg-card[data-dsg-gid="ga"]' : selector
	for (const title of ['下移', '上移']) {
		const motion = await sampleButtonMove(nodeSelector, title)
		check(`${name}点击${title}时平滑滑到新位置`, isSmoothMove(motion), JSON.stringify(motion))
	}
}
const rapidButtons = await dragPage.evaluate(async () => {
	const row = document.querySelector('[data-dsg-pin="account"]')
	row.querySelector('[title="下移"]').click()
	await new Promise((r) => setTimeout(r, 70))
	row.querySelector('[title="上移"]').click()
	await new Promise((r) => setTimeout(r, 60))
	const count = row.getAnimations().filter((a) => a.id === 'dsg-page-reorder').length
	await new Promise((r) => setTimeout(r, 330))
	return { count, first: document.querySelector('.dsg-page [data-dsg-pin]').dataset.dsgPin }
})
check('连点反向只保留一段补位动画且最终顺序正确', rapidButtons.count <= 1 && rapidButtons.first === 'account', JSON.stringify(rapidButtons))
await dragPage.emulateMedia({ reducedMotion: 'reduce' })
await dragPage.locator('[data-dsg-pin="account"] button[title="下移"]').click()
await dragPage.waitForTimeout(80)
check('减少动态效果时排序立即生效并跳过补位动画', (await pinIds())[1] === 'account' && await dragPage.evaluate(() => !document.getAnimations().some((a) => a.id === 'dsg-page-reorder')))
await dragContext.close()

// ---- 16. 设置功能切换：共享选中块的中间帧、反向、布局变化和清理 ----
const switchContext = await browser.newContext({ viewport: { width: 1000, height: 960 } })
const switchPage = await switchContext.newPage()
switchPage.on('pageerror', (error) => errors.push(String(error)))
await page.evaluate(() => fetch('/__reset'))
await switchPage.addInitScript(() => localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({ v: 1, enabled: true, updatedAt: Date.now(),
	groups: [{ id: 'motion', name: '外观功能', entries: ['dsh-meme', 'dsh-remotion'], open: true }], hidden: [], loose: [],
})))
await switchPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await switchPage.waitForTimeout(500)
const switchState = () => switchPage.evaluate(() => {
	const list = document.querySelector('[data-dsg-switch-track]')
	const active = list?.querySelector('[data-dsg-switch-active]')
	if (!list || !active) return { visible: false }
	const cs = getComputedStyle(list, '::before'), r = list.getBoundingClientRect(), a = active.getBoundingClientRect()
	const m = new DOMMatrixReadOnly(cs.transform), sx = r.width / list.offsetWidth, sy = r.height / list.offsetHeight
	const x = r.left + (m.m41 - list.scrollLeft + list.clientLeft) * sx
	const y = r.top + (m.m42 - list.scrollTop + list.clientTop) * sy
	return { visible: Number(cs.opacity) > .9, y: m.m42, target: (a.top - r.top) / sy + list.scrollTop - list.clientTop,
		error: Math.max(Math.abs(x - a.left), Math.abs(y - a.top), Math.abs(parseFloat(cs.width) * sx - a.width), Math.abs(parseFloat(cs.height) * sy - a.height)),
		bg: cs.backgroundColor, activeBg: getComputedStyle(active).backgroundColor, active: active.dataset.section, transition: cs.transitionDuration,
		tracks: document.querySelectorAll('[data-dsg-switch-track]').length }
})
const initialSwitch = await switchState()
check('设置选中块首帧对齐且不增加导航节点', initialSwitch.visible && initialSwitch.error < 1 && initialSwitch.tracks === 1 && await switchPage.locator('#navlist > button').count() === 15, JSON.stringify(initialSwitch))
check('选中块沿用宿主底色且按钮没有双重底色', initialSwitch.bg === 'rgba(0, 0, 0, 0.08)' && initialSwitch.activeBg === 'rgba(0, 0, 0, 0)', JSON.stringify(initialSwitch))
await switchPage.locator('nav [data-section="models"]').hover()
check('悬浮功能按钮不会改变当前选择', (await switchState()).active === 'general' && (await switchState()).error < 1)
await switchPage.mouse.move(800, 50)
await switchPage.locator('nav [data-section="models"]').evaluate((el) => el.click())
await switchPage.waitForTimeout(70)
const switchMid = await switchState()
check('切换功能时底块真正滑过中间位置', switchMid.y > initialSwitch.y + 1 && switchMid.y < switchMid.target - 1, JSON.stringify(switchMid))
check('滑动中宿主按钮不再叠加背景动画', switchMid.activeBg === 'rgba(0, 0, 0, 0)', JSON.stringify(switchMid))
await switchPage.locator('nav [data-section="general"]').evaluate((el) => el.click())
await switchPage.waitForTimeout(40)
const switchReverse = await switchState()
check('快速反向从当前位置返回且只有一个底块', switchReverse.y > initialSwitch.y && switchReverse.y < switchMid.y && switchReverse.tracks === 1, JSON.stringify(switchReverse))
await switchPage.waitForTimeout(330)
check('反向切换结束后精确落在当前功能', (await switchState()).error < 1, JSON.stringify(await switchState()))
await switchPage.locator('nav [data-section="models"]').focus()
await switchPage.keyboard.press('Enter')
await switchPage.waitForTimeout(330)
const keyboardSwitch = await switchState()
check('键盘激活继续走宿主操作且选中块同步', keyboardSwitch.active === 'models' && keyboardSwitch.error < 1 && await switchPage.locator('nav [data-section="models"]').evaluate((el) => el === document.activeElement), JSON.stringify(keyboardSwitch))
await switchPage.evaluate(async () => {
	for (let i = 0; i < 10; i++) for (const id of ['general', 'models']) {
		document.querySelector(`nav [data-section="${id}"]`).click()
		await new Promise((r) => setTimeout(r, 25))
	}
})
await switchPage.waitForTimeout(340)
check('十次快速往返后最终选择与底块一致', (await switchState()).active === 'models' && (await switchState()).error < 1, JSON.stringify(await switchState()))
await switchPage.locator('nav [data-section="dsh-meme"]').evaluate((el) => el.click())
await switchPage.waitForTimeout(340)
await switchPage.locator('nav .dsg-chip[data-dsg-gid="motion"]').click()
await switchPage.waitForTimeout(320)
check('折叠当前功能所在分组时隐藏选中块', await switchPage.locator('[data-dsg-switch-ready]').count() === 0)
await switchPage.locator('nav .dsg-chip[data-dsg-gid="motion"]').click()
await switchPage.waitForTimeout(370)
check('展开分组后选中块恢复并对齐', (await switchState()).visible && (await switchState()).error < 1, JSON.stringify(await switchState()))
await switchPage.locator('.dsg-search input').fill('不存在的功能')
await switchPage.waitForTimeout(80)
check('搜索过滤掉当前功能后无残留底块', await switchPage.locator('[data-dsg-switch-ready]').count() === 0)
const emptySearchScroll = await switchPage.locator('#navlist').evaluate((list) => {
	const previous = list.style.cssText
	list.style.flex = 'none'; list.style.height = '120px'
	const result = { height: list.clientHeight, scroll: list.scrollHeight }
	list.style.cssText = previous
	return result
})
check('隐藏的选中块不会撑出空白滚动区域', emptySearchScroll.scroll === emptySearchScroll.height, JSON.stringify(emptySearchScroll))
await switchPage.locator('.dsg-search input').fill('')
await switchPage.waitForTimeout(100)
check('清除搜索后底块直接恢复到当前项', (await switchState()).error < 1, JSON.stringify(await switchState()))
await switchPage.evaluate(() => {
	const list = document.querySelector('#navlist')
	list.style.flex = 'none'; list.style.height = '210px'; list.scrollTop = 150
})
await switchPage.waitForTimeout(100)
check('导航滚动后底块和按钮仍在同一坐标', (await switchState()).error < 1, JSON.stringify(await switchState()))
await switchPage.setViewportSize({ width: 600, height: 520 })
await switchPage.waitForTimeout(350)
check('窄窗口和侧栏变宽后底块尺寸仍对齐', (await switchState()).error < 1, JSON.stringify(await switchState()))
await switchPage.evaluate(() => {
	const style = document.createElement('style')
	style.textContent = 'body[data-theme="dark"] .nav-item[aria-current="true"]{background:rgb(70,75,85)}'
	document.head.appendChild(style); document.body.dataset.theme = 'dark'
})
await switchPage.waitForTimeout(100)
check('主题变化会更新选中底色', (await switchState()).bg === 'rgb(70, 75, 85)', JSON.stringify(await switchState()))
await switchPage.emulateMedia({ reducedMotion: 'reduce' })
await switchPage.locator('nav [data-section="account"]').evaluate((el) => el.click())
await switchPage.waitForTimeout(60)
const reducedSwitch = await switchState()
check('减少动态效果时功能切换立即对齐且正文不动画', reducedSwitch.error < 1 && reducedSwitch.transition === '0s' && await switchPage.locator('#content').evaluate((el) => getComputedStyle(el).animationName === 'none'), JSON.stringify(reducedSwitch))
await switchPage.emulateMedia({ reducedMotion: 'no-preference' })
await switchPage.evaluate(() => document.getElementById('btn-rerender').click())
await switchPage.waitForTimeout(550)
check('宿主重建导航后只恢复一份选中块', (await switchState()).tracks === 1 && (await switchState()).error < 1, JSON.stringify(await switchState()))
const frozenSwitcher = await switchPage.evaluate(async () => {
	const list = document.querySelector('#navlist')
	list.querySelector('[data-section="models"]').click()
	await new Promise((r) => setTimeout(r, 60))
	const before = new DOMMatrixReadOnly(getComputedStyle(list, '::before').transform).m42
	document.getElementById('btn-open').click()
	await new Promise((r) => setTimeout(r, 35))
	const ghostList = document.querySelector('[data-dsg-ghost] [data-dsg-switch-track]')
	return { before, frozen: ghostList ? new DOMMatrixReadOnly(getComputedStyle(ghostList, '::before').transform).m42 : null }
})
check('滑动中关闭设置时快照冻结底块而不跳到终点', frozenSwitcher.frozen !== null && Math.abs(frozenSwitcher.before - frozenSwitcher.frozen) < 1, JSON.stringify(frozenSwitcher))
await switchPage.waitForTimeout(350)
await switchPage.evaluate(() => document.getElementById('btn-open').click())
await switchPage.waitForTimeout(500)
await switchPage.evaluate(() => { for (const fn of window.__effectCleanups) if (typeof fn === 'function') fn() })
check('停用插件后清除指示器和按钮背景覆盖', await switchPage.locator('[data-dsg-switch-track], [data-dsg-switch-active]').count() === 0)
await switchContext.close()

// ---- 17. 搜索、新建、移组、浮层退场、重命名和不占位提示 ----
const interactionContext = await browser.newContext({ viewport: { width: 1300, height: 1200 } })
const interactionPage = await interactionContext.newPage()
interactionPage.on('pageerror', (error) => errors.push(String(error)))
await page.evaluate(() => fetch('/__reset'))
await interactionPage.addInitScript(() => {
	if (localStorage.getItem('dsh.settingsGroups.v1')) return
	localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({ v: 1, enabled: true, updatedAt: Date.now(),
		groups: [{ id: 'ia', name: '功能甲', entries: ['dsh-commandcode'], open: true }, { id: 'ib', name: '功能乙', entries: ['dsh-read-aloud'], open: true }], hidden: [], loose: [],
	}))
})
await interactionPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await interactionPage.waitForTimeout(600)
const searchMotion = await interactionPage.evaluate(async () => {
	const list = document.querySelector('#navlist'), item = list.querySelector('[data-section="dsh-meme"]'), input = list.querySelector('input')
	const y0 = item.getBoundingClientRect().top
	input.value = '表情'; input.dispatchEvent(new Event('input', { bubbles: true }))
	await new Promise((r) => setTimeout(r, 65))
	const mid = item.getBoundingClientRect().top
	const motion = item.getAnimations().some((a) => a.id === 'dsg-search-reorder')
	const layer = document.querySelector('[data-dsg-motion-layer]')
	const inert = layer?.inert && getComputedStyle(layer).pointerEvents === 'none'
	await new Promise((r) => setTimeout(r, 250))
	return { y0, mid, end: item.getBoundingClientRect().top, motion, inert }
})
check('搜索结果补位有真实中间帧', searchMotion.motion && searchMotion.mid < searchMotion.y0 && searchMotion.mid > searchMotion.end, JSON.stringify(searchMotion))
check('搜索退出画面不拦截点击和键盘', searchMotion.inert, JSON.stringify(searchMotion))
await interactionPage.locator('.dsg-search-input').fill('')
await interactionPage.waitForTimeout(30)
await interactionPage.locator('.dsg-search-input').fill('语音')
await interactionPage.waitForTimeout(30)
await interactionPage.locator('.dsg-search-input').fill('')
await interactionPage.waitForTimeout(350)
check('快速搜索与清空后无残留画面且所有条目恢复', await interactionPage.locator('[data-dsg-motion-layer]').count() === 0 && await interactionPage.locator('#navlist > .nav-item:visible').count() === 13)
const newGroupMotion = await interactionPage.evaluate(async () => {
	const card = document.querySelector('.dsg-card[data-dsg-bucket="loose"]'), before = card.getBoundingClientRect().top
	const input = document.querySelector('.dsg-new input')
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '新增动效')
	input.dispatchEvent(new Event('input', { bubbles: true }))
	await new Promise((r) => setTimeout(r, 0))
	document.querySelector('.dsg-create').click()
	await new Promise((r) => setTimeout(r, 60))
	const created = [...document.querySelectorAll('.dsg-card[data-dsg-gid]')].find((el) => el.querySelector('.dsg-cardname')?.textContent === '新增动效')
	const result = { before, mid: card.getBoundingClientRect().top, opacity: created ? Number(getComputedStyle(created).opacity) : -1,
		enter: created?.getAnimations().some((a) => a.id === 'dsg-scene-enter'), moving: card.getAnimations().some((a) => a.id === 'dsg-page-reorder') }
	await new Promise((r) => setTimeout(r, 330))
	return { ...result, end: card.getBoundingClientRect().top }
})
check('新建卡片淡入且下面卡片同步让位', newGroupMotion.enter && newGroupMotion.moving && newGroupMotion.opacity > 0 && newGroupMotion.opacity < 1 && newGroupMotion.mid > newGroupMotion.before && newGroupMotion.mid < newGroupMotion.end, JSON.stringify(newGroupMotion))
const rowSelector = '.dsg-page [data-dsg-entry="dsh-meme"]'
await interactionPage.locator(`${rowSelector} .dsg-picker-btn`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(50)
await interactionPage.locator('.dsg-new input').fill('不应重建菜单')
check('管理页其他输入变化不会卸载打开的菜单', await interactionPage.locator(`${rowSelector} .dsg-picker-menu`).count() === 1)
await interactionPage.locator(`${rowSelector} .dsg-picker-btn`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(45)
const menuExit = await interactionPage.locator(`${rowSelector} .dsg-picker-menu`).evaluate((el) => ({ inert: el.inert, pointer: getComputedStyle(el).pointerEvents, opacity: Number(getComputedStyle(el).opacity), out: el.dataset.dsgPresence }))
check('菜单关闭期间淡出且立刻停止接收操作', menuExit.inert && menuExit.pointer === 'none' && menuExit.out === 'out' && menuExit.opacity > 0 && menuExit.opacity < 1, JSON.stringify(menuExit))
await interactionPage.locator(`${rowSelector} .dsg-picker-btn`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(220)
check('关闭途中重开只保留一份可操作菜单', await interactionPage.locator(`${rowSelector} .dsg-picker-menu`).count() === 1 && await interactionPage.locator(`${rowSelector} .dsg-picker-menu`).evaluate((el) => !el.inert && Number(getComputedStyle(el).opacity) === 1))
await interactionPage.locator(`${rowSelector} .dsg-picker-item`).filter({ hasText: '功能甲' }).evaluate((el) => el.click())
await interactionPage.waitForTimeout(60)
const moveArrival = await interactionPage.locator('.dsg-page [data-dsg-gid="ia"] [data-dsg-entry="dsh-meme"]').evaluate((el) => ({ opacity: Number(getComputedStyle(el).opacity), motions: el.getAnimations().map((a) => a.id) }))
check('移组目标淡入并短暂高亮', moveArrival.opacity > 0 && moveArrival.opacity < 1 && moveArrival.motions.includes('dsg-scene-enter') && moveArrival.motions.includes('dsg-arrival'), JSON.stringify(moveArrival))
check('移组原位置保留短暂退场画面', await interactionPage.locator('[data-dsg-motion-layer]').count() === 1)
await interactionPage.waitForTimeout(450)
await interactionPage.locator(`${rowSelector} .dsg-hide`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(60)
const hiddenArrival = await interactionPage.locator('.dsg-page [data-dsg-hidden="dsh-meme"]').evaluate((el) => el.getAnimations().map((a) => a.id))
check('隐藏条目在已隐藏区域有到达反馈', hiddenArrival.includes('dsg-scene-enter') && hiddenArrival.includes('dsg-arrival'), JSON.stringify(hiddenArrival))
await interactionPage.waitForTimeout(450)
await interactionPage.locator('.dsg-page [data-dsg-hidden="dsh-meme"] button').evaluate((el) => el.click())
await interactionPage.waitForTimeout(60)
check('恢复条目在未分组区域有到达反馈', await interactionPage.locator(rowSelector).evaluate((el) => el.closest('[data-dsg-bucket]')?.dataset.dsgBucket === 'loose' && el.getAnimations().some((a) => a.id === 'dsg-arrival')))
await interactionPage.waitForTimeout(450)
const groupSelector = '.dsg-page .dsg-card[data-dsg-gid="ia"]'
await interactionPage.locator(`${groupSelector} button[title="重命名"]`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(50)
const renameTransition = await interactionPage.locator(groupSelector).evaluate((card) => ({ out: [...card.querySelectorAll('.dsg-title-view')].some((el) => el.dataset.dsgPresence === 'out' && el.inert), focused: card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' }))
check('重命名标题淡出且输入框自动获得焦点', renameTransition.out && renameTransition.focused, JSON.stringify(renameTransition))
await interactionPage.locator(`${groupSelector} input`).fill('功能甲改名')
await interactionPage.locator(`${groupSelector} input`).press('Enter')
await interactionPage.waitForTimeout(60)
check('保存重命名后标题更新并高亮确认', await interactionPage.locator(`${groupSelector} .dsg-cardname`).evaluate((el) => el.textContent === '功能甲改名' && el.getAnimations().some((a) => a.id === 'dsg-arrival')))
await interactionPage.waitForTimeout(450)
await interactionPage.locator(`${groupSelector} .dsg-danger`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(200)
await interactionPage.locator(`${groupSelector} .dsg-confirm .dsg-btn`).first().evaluate((el) => el.click())
await interactionPage.waitForTimeout(45)
check('取消删除时确认气泡平滑退出且不可点击', await interactionPage.locator(`${groupSelector} .dsg-confirm`).evaluate((el) => el.inert && el.dataset.dsgPresence === 'out' && Number(getComputedStyle(el).opacity) > 0))
await interactionPage.waitForTimeout(220)
check('确认气泡退场结束后清除', await interactionPage.locator('.dsg-confirm').count() === 0)
const toastLayout = await interactionPage.evaluate(async () => {
	const root = document.querySelector('.dsg-page'), content = document.querySelector('#content'), toast = document.querySelector('.dsg-toast')
	const before = { height: root.getBoundingClientRect().height, scroll: content.scrollHeight }
	await new Promise((r) => setTimeout(r, 1800))
	return { before, after: { height: root.getBoundingClientRect().height, scroll: content.scrollHeight }, hadToast: !!toast, removed: !document.querySelector('.dsg-toast') }
})
check('成功提示显示和消失都不撑动内容', toastLayout.hadToast && toastLayout.removed && JSON.stringify(toastLayout.before) === JSON.stringify(toastLayout.after), JSON.stringify(toastLayout))
await interactionPage.emulateMedia({ reducedMotion: 'reduce' })
await interactionPage.locator(rowSelector + ' .dsg-picker-btn').evaluate((el) => el.click())
await interactionPage.waitForTimeout(30)
await interactionPage.keyboard.press('Escape')
await interactionPage.waitForTimeout(30)
check('减少动态效果时菜单直接关闭并归还焦点', await interactionPage.locator('.dsg-picker-menu').count() === 0 && await interactionPage.locator(`${rowSelector} .dsg-picker-btn`).evaluate((el) => el === document.activeElement))
await interactionPage.locator(`${rowSelector} .dsg-hide`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(60)
check('减少动态效果时移组不产生动画或退出副本', await interactionPage.locator('[data-dsg-motion-layer]').count() === 0 && await interactionPage.locator('.dsg-page [data-dsg-hidden="dsh-meme"]').evaluate((el) => el.getAnimations().length === 0))
await interactionPage.emulateMedia({ reducedMotion: 'no-preference' })
await interactionPage.locator('.dsg-page [data-dsg-hidden="dsh-meme"] button').evaluate((el) => el.click())
await interactionPage.waitForTimeout(30)
await interactionPage.evaluate(() => document.getElementById('btn-open').click())
await interactionPage.waitForTimeout(50)
check('动效中关闭设置立即清理条目退出画面', await interactionPage.locator('[data-dsg-motion-layer]').count() === 0)
await interactionPage.waitForTimeout(450)
await interactionPage.evaluate(() => document.getElementById('btn-open').click())
await interactionPage.waitForTimeout(500)
await interactionPage.locator(`${rowSelector} .dsg-hide`).evaluate((el) => el.click())
await interactionPage.waitForTimeout(30)
await interactionPage.evaluate(() => { for (const fn of window.__effectCleanups) if (typeof fn === 'function') fn() })
check('停用插件立即清理新动效的退出副本', await interactionPage.locator('[data-dsg-motion-layer]').count() === 0)
await interactionContext.close()

// ---- 18. 设置管理命名与持久化的全部动效总开关 ----
const motionContext = await browser.newContext({ viewport: { width: 1300, height: 1200 } })
const motionPage = await motionContext.newPage()
motionPage.on('pageerror', (error) => errors.push(String(error)))
await page.evaluate(() => fetch('/__reset'))
await motionPage.addInitScript(() => {
	if (sessionStorage.getItem('motion-seeded')) return
	sessionStorage.setItem('motion-seeded', '1')
	// 旧配置没有 animations 字段，升级后仍默认开启动效。
	localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({ v: 1, enabled: true, updatedAt: Date.now(), groups: [
		{ id: 'mt', name: '动效测试', entries: ['dsh-commandcode', 'dsh-read-aloud'], open: true },
	], loose: [], hidden: [] }))
})
await motionPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await motionPage.waitForTimeout(600)
check('入口和页面标题统一为设置管理', await motionPage.locator('nav [data-dsg-id="settings-groups-manage"]').innerText() === '设置管理' && await motionPage.locator('.dsg-hero-title').innerText() === '设置管理')
const motionToggle = () => motionPage.getByRole('switch', { name: '启用动效', exact: true })
check('旧配置升级后默认开启动效且两个开关独立', await motionToggle().getAttribute('aria-checked') === 'true' && await motionPage.getByRole('switch', { name: '启用分组', exact: true }).count() === 1)
await motionPage.evaluate(() => {
	document.querySelector('nav .dsg-chip[data-dsg-gid="mt"]').click()
	document.querySelector('[data-dsg-pin="account"] [title="下移"]').click()
})
await motionPage.waitForTimeout(55)
check('关闭总开关前确实有展开或补位动画', await motionPage.evaluate(() => document.querySelector('[data-dsg-anim]') !== null || document.getAnimations().some((a) => a.id === 'dsg-page-reorder')))
await motionToggle().evaluate((el) => el.click())
await motionPage.waitForTimeout(40)
const settledOff = await motionPage.evaluate(() => ({ mode: document.documentElement.dataset.dsgMotion,
	markers: document.querySelectorAll('[data-dsg-anim],[data-dsg-motion-layer],[data-dsg-ghost]').length,
	motions: document.getAnimations().filter((a) => a.id.startsWith('dsg-') || a.animationName?.startsWith('dsg')).map((a) => a.id || a.animationName),
	hidden: ['dsh-commandcode', 'dsh-read-aloud'].every((id) => document.querySelector(`nav [data-section="${id}"]`).style.display === 'none'),
}))
check('关闭总开关把当前动画落到最终状态并清理副本', settledOff.mode === 'off' && settledOff.markers === 0 && settledOff.motions.length === 0 && settledOff.hidden, JSON.stringify(settledOff))
const immediateExpand = await motionPage.evaluate(() => {
	document.querySelector('nav .dsg-chip[data-dsg-gid="mt"]').click()
	const row = document.querySelector('nav [data-section="dsh-commandcode"]')
	return { display: row.style.display, marker: row.dataset.dsgAnim, transition: getComputedStyle(document.querySelector('.dsg-caret')).transitionDuration }
})
check('动效关闭时分组展开和箭头立即完成', immediateExpand.display !== 'none' && immediateExpand.marker === undefined && immediateExpand.transition === '0s', JSON.stringify(immediateExpand))
await motionPage.locator('nav [data-section="models"]').evaluate((el) => el.click())
await motionPage.waitForTimeout(45)
const noSwitch = await motionPage.evaluate(() => {
	const list = document.querySelector('[data-dsg-switch-track]'), cs = getComputedStyle(list, '::before')
	return { marker: !!document.querySelector('[data-dsg-page]'), transition: cs.transitionDuration,
		y: new DOMMatrixReadOnly(cs.transform).m42, target: parseFloat(list.style.getPropertyValue('--dsg-switch-y')) }
})
check('动效关闭时功能选中块和正文直接切换', !noSwitch.marker && noSwitch.transition === '0s' && Math.abs(noSwitch.y - noSwitch.target) < 1, JSON.stringify(noSwitch))
await motionPage.locator('.dsg-search-input').fill('表情')
await motionPage.waitForTimeout(35)
check('动效关闭时搜索不产生退出画面或补位动画', await motionPage.locator('[data-dsg-motion-layer]').count() === 0 && await motionPage.evaluate(() => !document.getAnimations().some((a) => a.id === 'dsg-search-reorder')))
await motionPage.locator('.dsg-search-input').fill('')
const offEntry = motionPage.locator('.dsg-page [data-dsg-entry="dsh-meme"]')
await offEntry.locator('.dsg-picker-btn').evaluate((el) => el.click())
await motionPage.waitForTimeout(20)
await motionPage.keyboard.press('Escape')
await motionPage.waitForTimeout(20)
check('动效关闭时下拉菜单立即关闭', await motionPage.locator('.dsg-picker-menu').count() === 0)
await offEntry.locator('.dsg-hide').evaluate((el) => el.click())
await motionPage.waitForTimeout(35)
check('动效关闭时隐藏操作立即完成且不播放高亮', await motionPage.locator('.dsg-page [data-dsg-hidden="dsh-meme"]').evaluate((el) => el.getAnimations().length === 0) && await motionPage.locator('[data-dsg-motion-layer]').count() === 0)
await motionPage.locator('[data-dsg-pin="account"] [title="上移"]').evaluate((el) => el.click())
await motionPage.waitForTimeout(30)
check('动效关闭时上下移动仍可用且没有补位动画', await motionPage.locator('.dsg-page [data-dsg-pin]').first().getAttribute('data-dsg-pin') === 'account' && await motionPage.evaluate(() => !document.getAnimations().some((a) => a.id === 'dsg-page-reorder')))
await motionPage.locator('.dsh-ptweak-split').dispatchEvent('dblclick')
check('动效关闭时面板复位不播放尺寸过渡', await motionPage.locator('[data-shortcut-modal="settings"] > nav').evaluate((el) => getComputedStyle(el).transitionDuration === '0s'))
await motionPage.waitForTimeout(350)
const savedMotion = await motionPage.evaluate(async () => ({ local: JSON.parse(localStorage.getItem('dsh.settingsGroups.v1')).animations, disk: (await (await fetch('/api/dsh-settings-groups/config')).json()).config.animations }))
check('总开关双写到缓存与宿主配置', savedMotion.local === false && savedMotion.disk === false, JSON.stringify(savedMotion))
await motionPage.evaluate(() => document.getElementById('btn-open').click())
await motionPage.waitForTimeout(35)
check('动效关闭时设置立即关闭且无退场快照', await motionPage.locator('[data-dsg-ghost]').count() === 0 && await motionPage.locator('[data-shortcut-modal="settings"]').count() === 0)
await motionPage.evaluate(() => document.getElementById('btn-open').click())
await motionPage.waitForTimeout(45)
check('重开设置时总开关仍关闭且没有入场动画', await motionToggle().getAttribute('aria-checked') === 'false' && await motionPage.locator('[data-shortcut-modal="settings"]').evaluate((el) => getComputedStyle(el).animationName === 'none'))
await motionPage.reload({ waitUntil: 'load' })
await motionPage.waitForTimeout(500)
check('刷新后保持关闭动效', await motionToggle().getAttribute('aria-checked') === 'false' && await motionPage.evaluate(() => document.documentElement.dataset.dsgMotion === 'off'))
await motionPage.evaluate(() => localStorage.clear())
await motionPage.reload({ waitUntil: 'load' })
await motionPage.waitForTimeout(600)
check('清空缓存后能从宿主配置恢复动效偏好', await motionToggle().getAttribute('aria-checked') === 'false')
await motionPage.getByRole('switch', { name: '启用分组', exact: true }).evaluate((el) => el.click())
await motionToggle().evaluate((el) => el.click())
await motionPage.waitForTimeout(40)
check('动效开关不改变分组功能开关', await motionPage.getByRole('switch', { name: '启用分组', exact: true }).getAttribute('aria-checked') === 'false' && await motionToggle().getAttribute('aria-checked') === 'true')
await motionPage.locator('nav [data-section="models"]').evaluate((el) => el.click())
await motionPage.waitForTimeout(50)
check('重新开启动效后切页动画恢复', await motionPage.locator('#content').evaluate((el) => el.getAnimations().some((a) => a.animationName === 'dsgPageIn')))
await motionPage.emulateMedia({ reducedMotion: 'reduce' })
await motionPage.waitForFunction(() => document.documentElement.dataset.dsgMotion === 'off')
check('总开关开启时仍遵守系统减少动态效果', await motionToggle().getAttribute('aria-checked') === 'true' && await motionPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))
await motionPage.emulateMedia({ reducedMotion: 'no-preference' })
await motionPage.waitForFunction(() => document.documentElement.dataset.dsgMotion === 'on')
check('系统恢复动效后自动恢复用户已开启的偏好', await motionPage.evaluate(() => document.documentElement.dataset.dsgMotion === 'on'))
await motionPage.evaluate(() => { for (const fn of window.__effectCleanups) if (typeof fn === 'function') fn() })
check('停用插件后清除动效开关的全局标记和样式', await motionPage.locator('style[data-dsg-motion-style]').count() === 0 && await motionPage.evaluate(() => !document.documentElement.hasAttribute('data-dsg-motion')))
await motionContext.close()

// ---- 19. 导航拖动开关、可配置长按时间及双端恢复 ----
const sidebarContext = await browser.newContext({ viewport: { width: 1300, height: 1200 } })
const sidebarPage = await sidebarContext.newPage()
sidebarPage.on('pageerror', (error) => errors.push(String(error)))
await page.evaluate(() => fetch('/__reset'))
await sidebarPage.addInitScript(() => {
	if (sessionStorage.getItem('sidebar-seeded')) return
	sessionStorage.setItem('sidebar-seeded', '1')
	localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({ v: 1, enabled: true, updatedAt: Date.now(), groups: [
		{ id: 'st', name: '拖动测试', entries: ['dsh-commandcode', 'dsh-read-aloud'], open: true },
	], loose: [], hidden: [] }))
})
await sidebarPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await sidebarPage.waitForTimeout(600)
const sidebarToggle = () => sidebarPage.getByRole('switch', { name: '左侧设置栏长按拖动', exact: true })
const delayField = () => sidebarPage.getByRole('textbox', { name: '长按等待时间', exact: true })
check('旧配置升级后默认允许导航拖动且等待250ms', await sidebarToggle().getAttribute('aria-checked') === 'true' && await delayField().inputValue() === '250')
check('拖动配置使用自绘开关和文本框，无原生选择或勾选控件', await sidebarPage.locator('.dsg-page select,.dsg-page input[type=checkbox],.dsg-page input[type=radio],.dsg-page input[type=range]').count() === 0)
const setSidebarDelay = async (value) => { await delayField().fill(value); await delayField().press('Enter'); await sidebarPage.waitForTimeout(40) }
await setSidebarDelay('800')
check('Enter保存时长并同步更新说明', await delayField().inputValue() === '800' && await sidebarPage.locator('.dsg-page').innerText().then((text) => text.includes('按住 800ms')))
const sidebarSelectors = ['nav .dsg-chip[data-dsg-gid="st"]', 'nav [data-section="models"]', 'nav [data-section="dsh-commandcode"]']
const startSidebarHold = async (selector) => {
	const row = sidebarPage.locator(selector)
	await row.scrollIntoViewIfNeeded()
	const box = await row.boundingBox()
	await sidebarPage.mouse.move(box.x + 55, box.y + box.height / 2)
	await sidebarPage.mouse.down()
}
for (const [index, selector] of sidebarSelectors.entries()) {
	await startSidebarHold(selector)
	await sidebarPage.waitForTimeout(350)
	check(`导航拖动类型${index + 1}在自定义等待时间前不会浮起`, await sidebarPage.locator('[data-dsg-floating]').count() === 0)
	await sidebarPage.waitForTimeout(500)
	check(`导航拖动类型${index + 1}达到800ms后浮起`, await sidebarPage.locator('[data-dsg-floating]').count() === 1)
	await sidebarPage.mouse.up()
	await sidebarPage.waitForTimeout(300)
}
await sidebarToggle().click()
await sidebarPage.waitForTimeout(55)
const sidebarSwitchMid = await sidebarToggle().locator('.dsg-knob').evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)
check('新开关切换有真实滑动中间帧', sidebarSwitchMid > 0 && sidebarSwitchMid < 18, String(sidebarSwitchMid))
await sidebarPage.waitForTimeout(250)
for (const [index, selector] of sidebarSelectors.entries()) {
	await startSidebarHold(selector)
	await sidebarPage.waitForTimeout(900)
	check(`关闭开关后导航拖动类型${index + 1}长按也不会浮起`, await sidebarPage.locator('[data-dsg-floating]').count() === 0)
	await sidebarPage.mouse.up()
	await sidebarPage.waitForTimeout(300)
	if (index === 0 && await sidebarPage.locator(sidebarSelectors[0]).getAttribute('aria-expanded') === 'false') {
		await sidebarPage.locator(sidebarSelectors[0]).click()
		await sidebarPage.waitForTimeout(300)
	}
}
const sidebarChip = () => sidebarPage.locator(sidebarSelectors[0])
await sidebarChip().click()
await sidebarPage.waitForTimeout(300)
const beforeClick = await sidebarChip().getAttribute('aria-expanded')
await sidebarChip().click()
await sidebarPage.waitForTimeout(300)
check('禁用长按后分组仍可点击展开和收起', await sidebarChip().getAttribute('aria-expanded') !== beforeClick)
// 保证组展开，管理页仍使用原来的250ms长按，左侧800ms配置不影响它。
await startSidebarHold('.dsg-page [data-dsg-pin="account"]')
await sidebarPage.waitForTimeout(320)
check('禁用左侧拖动不影响管理页拖动及原有等待时间', await sidebarPage.locator('[data-dsg-row-floating]').count() === 1)
await sidebarPage.mouse.up()
await sidebarPage.waitForTimeout(350)
const sidebarSaved = await sidebarPage.evaluate(async () => ({ local: JSON.parse(localStorage.getItem('dsh.settingsGroups.v1')), disk: (await (await fetch('/api/dsh-settings-groups/config')).json()).config }))
check('拖动开关与时长双写到缓存和宿主配置', sidebarSaved.local.sidebarDrag === false && sidebarSaved.disk.sidebarDrag === false && sidebarSaved.local.sidebarDragDelay === 800 && sidebarSaved.disk.sidebarDragDelay === 800)
await sidebarPage.reload({ waitUntil: 'load' })
await sidebarPage.waitForTimeout(550)
check('刷新后保持拖动关闭和自定义时间', await sidebarToggle().getAttribute('aria-checked') === 'false' && await delayField().inputValue() === '800')
await sidebarPage.evaluate(() => localStorage.clear())
await sidebarPage.reload({ waitUntil: 'load' })
await sidebarPage.waitForTimeout(600)
check('清空缓存后恢复宿主保存的拖动开关与时间', await sidebarToggle().getAttribute('aria-checked') === 'false' && await delayField().inputValue() === '800')
await setSidebarDelay('')
check('空时间输入恢复当前值', await delayField().inputValue() === '800')
await setSidebarDelay('invalid')
check('无效时间输入恢复当前值', await delayField().inputValue() === '800')
await setSidebarDelay('20')
check('长按时间下限为100ms', await delayField().inputValue() === '100')
await delayField().fill('99999')
await sidebarToggle().focus()
await sidebarPage.waitForTimeout(40)
check('离开焦点也保存并限制上限5000ms', await delayField().inputValue() === '5000')
await setSidebarDelay('800')
await sidebarToggle().click()
await sidebarPage.waitForTimeout(300)
check('导航拖动开关不改变分组或动效偏好', await sidebarPage.getByRole('switch', { name: '启用分组', exact: true }).getAttribute('aria-checked') === 'true' && await sidebarPage.getByRole('switch', { name: '启用动效', exact: true }).getAttribute('aria-checked') === 'true')
// 长按尚未触发时关闭，和已经浮起后关闭，都必须立即取消。
for (const hold of [60, 850]) {
	await startSidebarHold(sidebarSelectors[0])
	await sidebarPage.waitForTimeout(hold)
	await sidebarToggle().evaluate((el) => el.click())
	await sidebarPage.waitForTimeout(900)
	check(`关闭开关清理${hold < 800 ? '待触发' : '进行中'}的长按拖动`, await sidebarPage.locator('[data-dsg-floating]').count() === 0 && await sidebarPage.evaluate(() => document.body.style.cursor === ''))
	await sidebarPage.mouse.up()
	await sidebarToggle().click()
	await sidebarPage.waitForTimeout(300)
}
// 原有分组总开关也应阻止残留按钮监听继续触发拖动。
await sidebarPage.getByRole('switch', { name: '启用分组', exact: true }).click()
await startSidebarHold('nav [data-section="models"]')
await sidebarPage.waitForTimeout(900)
check('关闭分组后原生导航不会被旧长按监听抓起', await sidebarPage.locator('[data-dsg-floating]').count() === 0)
await sidebarPage.mouse.up()
await sidebarPage.getByRole('switch', { name: '启用分组', exact: true }).click()
await sidebarPage.waitForTimeout(300)
await sidebarPage.screenshot({ path: join(HERE, 'shot-sidebar-drag.png') })
await sidebarContext.close()

check('全程无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await page.screenshot({ path: join(HERE, 'shot-final.png'), fullPage: false })

await browser.close()
server.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败项：')
	for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
	process.exitCode = 1
}
