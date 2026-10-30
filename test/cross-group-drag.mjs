// Isolated headless harness: no real DSH instance, profile or desktop is touched.
// DSG_SOURCE_ROOT selects the checkout under test; DSG_VENDOR selects its dependencies.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.env.DSG_SOURCE_ROOT || join(HERE, '..'))
const VENDOR = process.env.DSG_VENDOR || join(ROOT, 'node_modules')
const require = createRequire(join(VENDOR, 'noop.js'))
const { chromium } = require('playwright')
const STORE = 'dsh.settingsGroups.v1'
const ENTRY = 'dsh-read-aloud'
const ENTRIES = ['dsh-claude-beautify', ENTRY, 'dsh-commandcode', 'dsh-codex-subscription', 'dsh-skills-manager', 'dsh-meme', 'dsh-remotion']
const seed = {
	v: 1, enabled: true, animations: false, sidebarDrag: true, sidebarDragDelay: 100,
	updatedAt: Date.now(), coreExtra: ['settings-groups-manage'], hidden: [], loose: [], folded: false,
	groups: [
		{ id: 'a', name: '来源组', entries: ENTRIES.filter((id) => id !== 'dsh-meme' && id !== 'dsh-commandcode'), open: true },
		{ id: 'b', name: '目标组', entries: ['dsh-meme'], open: true },
		{ id: 'empty', name: '空分组', entries: [], open: true },
		{ id: 'folded', name: '折叠分组', entries: ['dsh-commandcode'], open: false },
	],
}
let fileStore = null
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://127.0.0.1')
		if (url.pathname === '/api/dsh-settings-groups/config') {
			if (req.method === 'POST') {
				let body = ''
				for await (const chunk of req) body += chunk
				fileStore = JSON.parse(body)
			}
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(req.method === 'GET' ? { ok: true, config: fileStore } : { ok: true }))
			return
		}
		const file = url.pathname === '/' || url.pathname === '/harness.html'
			? join(ROOT, 'test', 'harness.html')
			: url.pathname === '/client.js' ? join(ROOT, 'client.js')
				: url.pathname.startsWith('/vendor/') ? join(VENDOR, url.pathname.slice('/vendor/'.length)) : null
		if (file === null) { res.writeHead(404).end(); return }
		const data = await readFile(file)
		const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' }
		res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }).end(data)
	} catch (error) {
		res.writeHead(500).end(String(error))
	}
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
let checks = 0
const check = (name, condition, detail = '') => {
	assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`)
	checks += 1
	console.log(`  ✓ ${name}`)
}

try {
	browser = await chromium.launch({ headless: true, channel: process.env.DSG_BROWSER_CHANNEL || 'chrome' })
	for (const side of ['左侧导航', '右侧管理页']) {
		fileStore = null
		const context = await browser.newContext({ viewport: { width: 1280, height: 3200 } })
		const page = await context.newPage()
		page.setDefaultTimeout(5000)
		const errors = []
		page.on('pageerror', (error) => errors.push(String(error)))
		await page.addInitScript(({ seed, store }) => {
			if (!localStorage.getItem(store)) localStorage.setItem(store, JSON.stringify(seed))
			localStorage.setItem('dsh.settingsPanelTweak.v1', JSON.stringify({ panelW: 1100, panelH: 3000 }))
		}, { seed, store: STORE })
		await page.goto(origin, { waitUntil: 'load' })
		await page.waitForFunction(() => window.__APPLIED__ && document.querySelector('.dsg-page [data-dsg-entry="dsh-read-aloud"]'))
		const state = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORE)
		const owners = (config, id) => [
			...config.groups.flatMap((group) => group.entries.filter((entry) => entry === id).map(() => group.id)),
			...config.loose.filter((entry) => entry === id).map(() => 'loose'),
			...config.hidden.filter((entry) => entry === id).map(() => 'hidden'),
		]
		const unique = async (label) => {
			const config = await state()
			check(`${side} ${label}：每条设置只有一个归属`, ENTRIES.every((id) => owners(config, id).length === 1))
		}
		await page.locator('nav .dsg-chip[data-dsg-chip="loose"]').waitFor({ state: 'visible' })
		check(`${side} 所有条目已归组时仍有未分组接收入口`, (await state()).loose.length === 0 && await page.locator('nav .dsg-chip[data-dsg-chip="loose"] .dsg-count').innerText() === '0')
		check(`${side} 右侧空的未分组区仍可见`, await page.locator('.dsg-page [data-dsg-bucket="loose"]').isVisible())
		await unique('初始')

		const rightButton = page.locator('.dsg-page .dsg-create')
		const buttonCursor = await rightButton.evaluate((el) => getComputedStyle(el).cursor)
		const source = page.locator(side === '左侧导航' ? `nav [data-section="${ENTRY}"]` : `.dsg-page [data-dsg-entry="${ENTRY}"]`)
		const box = await source.boundingBox()
		await page.mouse.move(box.x + 10, box.y + box.height / 2)
		await page.mouse.down()
		await page.waitForFunction(() => document.querySelector('[data-dsg-floating],[data-dsg-row-floating]'))
		check(`${side} 拖动时普通按钮也保持箭头`, await rightButton.evaluate((el) => getComputedStyle(el).cursor) === 'default')
		check(`${side} 拖动时导航按钮保持箭头`, await page.locator('nav [data-section="models"]').evaluate((el) => getComputedStyle(el).cursor) === 'default')

		const moveTo = async (kind, gid, anchorId) => {
			const selector = side === '左侧导航'
				? anchorId ? `nav [data-section="${anchorId}"]` : kind === 'loose' ? 'nav .dsg-chip[data-dsg-chip="loose"]' : `nav .dsg-chip[data-dsg-gid="${gid}"]`
				: anchorId ? `.dsg-page [data-dsg-entry="${anchorId}"]` : kind === 'loose' ? '.dsg-page [data-dsg-bucket="loose"]' : `.dsg-page .dsg-card[data-dsg-gid="${gid}"] .dsg-cardhead`
			const target = await page.locator(selector).boundingBox()
			assert.ok(target, `missing visible target: ${selector}`)
			await page.mouse.move(target.x + Math.min(45, target.width / 2), target.y + (anchorId ? 4 : target.height / 2))
			await page.waitForFunction(({ key, entry, group }) => {
				const config = JSON.parse(localStorage.getItem(key))
				return group === 'loose' ? config.loose.includes(entry) : config.groups.find((g) => g.id === group)?.entries.includes(entry)
			}, { key: STORE, entry: ENTRY, group: kind === 'loose' ? 'loose' : gid })
			const destination = kind === 'loose' ? '.dsg-page [data-dsg-bucket="loose"]' : `.dsg-page [data-dsg-gid="${gid}"]`
			await page.locator(`${destination} [data-dsg-entry="${ENTRY}"]`).waitFor({ state: 'visible' })
			check(`${side} → ${kind === 'loose' ? '未分组' : gid}：管理页未松手就更新`, true)
			check(`${side} 跨组重建后浮层仍在`, await page.locator('[data-dsg-floating],[data-dsg-row-floating]').count() === 1)
			await unique(`移动到 ${kind === 'loose' ? '未分组' : gid}`)
		}
		await moveTo('group', 'b', 'dsh-meme')
		check(`${side} 可跨组插入目标条目前方`, (await state()).groups.find((g) => g.id === 'b').entries[0] === ENTRY)
		await moveTo('group', 'empty')
		await moveTo('group', 'folded')
		check(`${side} 接收条目后自动展开折叠组`, (await state()).groups.find((g) => g.id === 'folded').open === true && await page.locator(`nav [data-section="${ENTRY}"]`).isVisible())
		await moveTo('loose')
		await page.mouse.up()
		await page.waitForFunction(() => !document.querySelector('[data-dsg-floating],[data-dsg-row-floating],[data-dsg-page-dragging]'))
		check(`${side} 松手清理浮层和拖动标记`, await page.locator('[data-dsg-floating],[data-dsg-row-floating],[data-dsg-page-dragging]').count() === 0)
		check(`${side} 松手恢复按钮原有光标`, await rightButton.evaluate((el) => getComputedStyle(el).cursor) === buttonCursor)
		check(`${side} 松手恢复 body 光标`, await page.evaluate(() => document.body.style.cursor === ''))
		const savedAt = (await state()).updatedAt
		for (let attempt = 0; attempt < 100 && (!fileStore?.loose.includes(ENTRY) || fileStore.updatedAt !== savedAt); attempt += 1) {
			await page.waitForTimeout(50)
		}
		check(`${side} 跨组结果写入宿主配置`, fileStore?.loose.includes(ENTRY) && fileStore.updatedAt === savedAt)
		await page.reload({ waitUntil: 'load' })
		await page.locator(`.dsg-page [data-dsg-bucket="loose"] [data-dsg-entry="${ENTRY}"]`).waitFor({ state: 'visible' })
		check(`${side} 刷新后保持最终归属和折叠组展开状态`, owners(await state(), ENTRY).join() === 'loose' && (await state()).groups.find((g) => g.id === 'folded').open === true)
		await unique('刷新后')
		check(`${side} 全程无 JavaScript 异常`, errors.length === 0, errors.join(' | '))
		await context.close()
	}

	// Exercise the new sidebar -> management-page FLIP path with motion enabled.
	fileStore = null
	const motionContext = await browser.newContext({ viewport: { width: 1280, height: 3200 } })
	const motionPage = await motionContext.newPage()
	motionPage.setDefaultTimeout(5000)
	await motionPage.addInitScript(({ seed, store }) => {
		localStorage.setItem(store, JSON.stringify({ ...seed, updatedAt: Date.now(), animations: true }))
		localStorage.setItem('dsh.settingsPanelTweak.v1', JSON.stringify({ panelW: 1100, panelH: 3000 }))
	}, { seed, store: STORE })
	await motionPage.goto(origin, { waitUntil: 'load' })
	await motionPage.locator('.dsg-page [data-dsg-entry="dsh-skills-manager"]').waitFor({ state: 'visible' })
	await motionPage.waitForFunction(() => !document.querySelector('.dsg-page').getAnimations({ subtree: true }).some((motion) => motion.playState === 'running'))
	const motionSource = await motionPage.locator(`nav [data-section="${ENTRY}"]`).boundingBox()
	await motionPage.mouse.move(motionSource.x + 10, motionSource.y + motionSource.height / 2)
	await motionPage.mouse.down()
	await motionPage.waitForFunction(() => document.querySelector('[data-dsg-floating]'))
	await motionPage.evaluate(() => {
		const nodes = [
			document.querySelector('.dsg-page [data-dsg-entry="dsh-skills-manager"]'),
			document.querySelector('.dsg-page .dsg-card[data-dsg-gid="b"]'),
		]
		const record = { nodes, before: nodes.map((node) => node.getBoundingClientRect().top), frames: [], frame: 0 }
		window.__crossGroupMotion = record
		const sample = () => {
			record.frames.push(nodes.map((node) => ({ y: node.getBoundingClientRect().top, transform: getComputedStyle(node).transform })))
			record.frame = requestAnimationFrame(sample)
		}
		sample()
	})
	const motionTarget = await motionPage.locator('nav .dsg-chip[data-dsg-gid="b"]').boundingBox()
	await motionPage.mouse.move(motionTarget.x + 45, motionTarget.y + motionTarget.height / 2)
	await motionPage.locator(`.dsg-page [data-dsg-gid="b"] [data-dsg-entry="${ENTRY}"]`).waitFor({ state: 'visible' })
	const movement = await motionPage.evaluate(async () => {
		const record = window.__crossGroupMotion
		await Promise.all(document.querySelector('.dsg-page').getAnimations({ subtree: true }).map((motion) => motion.finished.catch(() => {})))
		await new Promise((done) => requestAnimationFrame(done))
		cancelAnimationFrame(record.frame)
		const result = {
			before: record.before,
			frames: record.frames,
			after: record.nodes.map((node) => ({
				y: node.getBoundingClientRect().top,
				transform: getComputedStyle(node).transform,
				inline: ['transform', 'height', 'paddingTop', 'paddingBottom', 'transitionDelay', 'willChange'].map((property) => node.style[property]),
			})),
		}
		delete window.__crossGroupMotion
		return result
	})
	for (const [index, name] of ['右侧现存行', '右侧后续卡片'].entries()) {
		const before = movement.before[index], after = movement.after[index].y
		const middle = movement.frames.find((frame) => frame[index].y > Math.min(before, after) + .1 && frame[index].y < Math.max(before, after) - .1)
		check(`左侧跨组后${name}经过真实补位中间帧`, Math.abs(after - before) > 2 && Boolean(middle), JSON.stringify({ before, after, frames: movement.frames.map((frame) => frame[index]) }))
		check(`${name}补位结束归位并清理临时样式`, movement.after[index].transform === 'none' && movement.after[index].inline.every((value) => value === ''), JSON.stringify(movement.after[index]))
	}
	await motionPage.mouse.up()
	await motionContext.close()
	console.log(`\n${checks}/${checks} 跨组拖动检查通过`)
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	await browser?.close()
	await new Promise((done) => server.close(done))
}
