// 截 chip 特写：收起（>）vs 展开（v），用来肉眼核对箭头样式与动画
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
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
		: u.pathname.startsWith('/vendor/') ? join(VENDOR, u.pathname.slice(8)) : null
	if (f === null) { res.writeHead(404).end(); return }
	try { res.writeHead(200, { 'content-type': extname(f) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript' }).end(await readFile(f)) } catch { res.writeHead(404).end() }
})
await new Promise((d) => server.listen(0, '127.0.0.1', d))

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 4 })
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' })
await page.waitForTimeout(400)

const input = page.locator('.dsg-input').first()
await input.fill('开发工具')
await input.press('Enter')
await page.waitForTimeout(200)
for (const label of ['语音朗读', 'Command Code']) {
	await page.evaluate(({ label }) => {
		const src = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === label)
		const dst = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具')
		const r = dst.getBoundingClientRect()
		const dt = new DataTransfer()
		const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 6 }))
		fire(src, 'dragstart'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend')
	}, { label })
	await page.waitForTimeout(200)
}
await page.waitForTimeout(400)

const box = await page.evaluate(() => {
	const chip = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具')
	const r = chip.getBoundingClientRect()
	return { x: r.left - 6, y: r.top - 8, width: 196, height: 150 }
})

await page.screenshot({ path: join(HERE, 'frames', 'caret-closed.png'), clip: box })
await page.evaluate(() => {
	[...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === '开发工具').click()
})
await page.waitForTimeout(500)
await page.screenshot({ path: join(HERE, 'frames', 'caret-open.png'), clip: box })
console.log('ok')
await browser.close()
server.close()
