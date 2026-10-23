// 抓收起动画的关键帧，用来肉眼验收"高度是不是真的在塌"。
// 用法：node test/shot-anim.mjs   → test/frames/*.png
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const VENDOR = process.env.DSG_VENDOR || join(ROOT, 'node_modules')
const require = createRequire(join(VENDOR, 'noop.js'))
const { chromium } = require('playwright')

const server = createServer(async (req, res) => {
	const u = new URL(req.url, 'http://x')
	const f = u.pathname === '/' ? join(HERE, 'harness.html')
		: u.pathname === '/client.js' ? join(ROOT, 'client.js')
		: u.pathname.startsWith('/vendor/') ? join(VENDOR, u.pathname.slice(8))
		: null
	if (f === null) {
		res.writeHead(404).end()
		return
	}
	try {
		res.writeHead(200, { 'content-type': extname(f) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript' }).end(await readFile(f))
	} catch {
		res.writeHead(404).end()
	}
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1000, height: 960 }, deviceScaleFactor: 2 })
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' })
await page.waitForTimeout(400)

const input = page.locator('.dsg-new .dsg-input')
await input.fill('开发工具')
await input.press('Enter')
await page.waitForTimeout(200)
for (const label of ['语音朗读', 'Command Code', 'Codex 订阅']) {
	await page.evaluate(({ label }) => {
		const src = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === label)
		const dst = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具')
		const r = dst.getBoundingClientRect()
		const dt = new DataTransfer()
		const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 8 }))
		fire(src, 'dragstart')
		fire(dst, 'dragover')
		fire(dst, 'drop')
		fire(src, 'dragend')
	}, { label })
	await page.waitForTimeout(220)
}
await page.waitForTimeout(400)

// 只截「分组区」，把注意力收在 chip 和它下面那几条上
const box = await page.evaluate(() => {
	const chip = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具')
	const nav = document.querySelector('[role="dialog"] > nav')
	const r = chip.getBoundingClientRect()
	const n = nav.getBoundingClientRect()
	return { x: n.left, y: r.top - 10, width: n.width, height: Math.min(n.bottom - r.top + 10, 480) }
})
const clip = { x: box.x, y: box.y, width: box.width, height: box.height }
mkdirSync(join(HERE, "frames"), { recursive: true })

// 收起过程中按时间取样
const shots = [
	{ at: 0, name: 'f0' },
	{ at: 70, name: 'f1' },
	{ at: 140, name: 'f2' },
	{ at: 210, name: 'f3' },
	{ at: 420, name: 'f4' },
]

let started = 0
await page.evaluate(() => {
	[...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具').click()
	window.__collapseAt = performance.now()
})
started = await page.evaluate(() => window.__collapseAt)

for (const shot of shots) {
	const wait = shot.at - (await page.evaluate(() => performance.now() - window.__collapseAt))
	if (wait > 0) await page.waitForTimeout(wait)
	await page.screenshot({ path: join(HERE, 'frames', `${shot.name}.png`), clip })
}
console.log(JSON.stringify({ started: Math.round(started), clip, frames: shots.length }))

await browser.close()
server.close()
