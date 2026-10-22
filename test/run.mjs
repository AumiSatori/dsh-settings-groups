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
check('管理页入口已注册', initial.includes('分组管理'), initial.join(' / '))

// ---- 3. 新建分组（走管理页真实输入框）----
const input = page.locator('.dsg-input').first()
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

const dragItemToChip = async (label, chipName) => {
	await dnd({ srcLabel: label, dstChip: chipName, part: 'middle' })
	await page.waitForTimeout(260)
}
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
await dnd({ srcChip: '开发工具', dstChip: '界面增强', part: 'top' })
await page.waitForTimeout(300)
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
	const tick = () => {
		samples.push(Math.round(item.getBoundingClientRect().height))
		if (++n < 7) setTimeout(tick, 40)
		else {
			const cs = getComputedStyle(item)
			resolve({
				h0: Math.round(h0),
				midH: samples[1] ?? 0,
				tail: samples[samples.length - 1],
				samples,
				y0: Math.round(y0),
				midY: Math.round(below.getBoundingClientRect().top),
				filter: cs.filter,
				transform: cs.transform,
			})
		}
	}
	setTimeout(tick, 40)
}))
check('收起过程中高度在塌陷', mid.midH > 0 && mid.midH < mid.h0, `${mid.h0}px → ${mid.midH}px`)
check('下方内容跟着上移', mid.midY < mid.y0, `未分组 top ${mid.y0} → ${mid.midY}`)
check('收起过程中带模糊滤镜', /blur/.test(mid.filter), mid.filter)
check('收起过程中带缩放位移', mid.transform !== 'none' && mid.transform !== 'matrix(1, 0, 0, 1, 0, 0)', mid.transform)
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
	const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text)
	if (btn === undefined) return false
	btn.click()
	return true
}, { label, text })

const beforeHide = await navVisible()
check('隐藏前条目在导航里', beforeHide.includes('Codex 订阅'), beforeHide.join(' / '))

check('行内有隐藏按钮', await clickRowButton('Codex 订阅', '⊘'))
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
await clickRowButton('Remotion', '⊘')
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
	const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '↑')
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
	const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '⊘')
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

// ---- 9.7c 核心项在导航里直接拖，且拖完有 FLIP 过渡 ----
const beforeDragCore = await navVisible()
await dnd({ srcLabel: '插件', dstLabel: '模型', part: 'top' })
const flipRunning = await page.evaluate(() => {
	// FLIP 用 WAAPI 播，document.getAnimations() 能抓到正在跑的
	return document.getAnimations().filter((a) => {
		try {
			return a.effect?.getKeyframes?.().some((k) => String(k.transform ?? '').includes('translate')) === true
		} catch {
			return false
		}
	}).length
})
await page.waitForTimeout(500)
const afterDragCore = await navVisible()
check('核心项能在导航里拖动', afterDragCore.indexOf('插件') < beforeDragCore.indexOf('插件'), `${beforeDragCore.slice(0, 4).join('/')} → ${afterDragCore.slice(0, 4).join('/')}`)
check('拖完有 FLIP 过渡', flipRunning > 0, `running=${flipRunning}`)

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
await page.evaluate(() => {
	const sw = document.querySelector('.dsg-switch')
	if (sw !== null) sw.click()
})
// 要等过「写盘节流 250ms + 一次轮询」：否则轮询可能读到上一轮测试写进磁盘的旧配置，
// 把刚关掉的开关又覆盖回 true（表现为偶发的 "还有 chip 残留"）
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

// 关掉面板（harness 的按钮直接 unmount dialog），看有没有留快照
const ghostState = await page.evaluate(async () => {
	document.getElementById('btn-open').click()
	await new Promise((r) => setTimeout(r, 60))
	const g = document.querySelector('[data-dsg-ghost="1"]')
	if (g === null) return { exists: false }
	const cs = getComputedStyle(g)
	return {
		exists: true,
		position: cs.position,
		animation: cs.animationName,
		pointerEvents: cs.pointerEvents,
		// 快照本身就是 dialog 的克隆，属性一模一样 —— 必须排除掉才是在看"真面板没了没"
		origin: document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]:not([data-dsg-ghost])') === null,
	}
})
check('关闭时留了一张快照', ghostState.exists === true, JSON.stringify(ghostState))
check('快照在原地淡出且不吃点击', ghostState.position === 'fixed' && ghostState.animation.includes('dsgPanelOut') && ghostState.pointerEvents === 'none', JSON.stringify(ghostState))
check('快照出现时真面板已消失', ghostState.origin === true, String(ghostState.origin))

await page.waitForTimeout(700)
check('快照会自毁', (await page.evaluate(() => document.querySelector('[data-dsg-ghost="1"]') === null)))


// 重新打开，别把后面晾在关闭状态
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(500)
check('重新打开后面板回来', (await page.locator('[role="dialog"][aria-modal="true"]').count()) >= 1)

// overlay 场景：宿主可能把 dialog 包在一层容器里整个摘掉，被移除的是容器
const wrapped = await page.evaluate(async () => {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]:not([data-dsg-ghost])')
	if (dialog === null) return 'no-dialog'
	const parent = dialog.parentNode
	const next = dialog.nextSibling
	const wrapper = document.createElement('div')
	parent.insertBefore(wrapper, dialog)
	wrapper.appendChild(dialog)
	await new Promise((r) => setTimeout(r, 80))
	wrapper.remove()
	// 插件这会儿应该已经抓到"dialog 被容器带走了"。
	// 但 React 并不知道我们把节点挪过，直接不管会导致它卸载时 removeChild 报错 —— 放回原处。
	parent.insertBefore(dialog, next)
	await new Promise((r) => setTimeout(r, 80))
	return document.querySelector('[data-dsg-ghost="1"]') !== null
})
check('overlay 整体移除也能触发退场', wrapped === true, String(wrapped))
await page.waitForTimeout(800)
// 再打开一次，后面的迁移测试还要用
await page.evaluate(() => document.getElementById('btn-open').click())
await page.waitForTimeout(500)

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
