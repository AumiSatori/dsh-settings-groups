// 截导航顶部（搜索框 + 几个条目），用来比对搜索框的观感
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
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
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 3 })
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' })
await page.waitForTimeout(500)
const box = await page.evaluate(() => {
	const nav = document.querySelector('[role="dialog"] > nav')
	const r = nav.getBoundingClientRect()
	return { x: r.left - 6, y: r.top + 4, width: 212, height: 300 }
})
await page.screenshot({ path: join(HERE, 'frames', 'search-idle.png'), clip: box })
await page.fill('.dsg-search-input', '语音')
await page.waitForTimeout(300)
await page.screenshot({ path: join(HERE, 'frames', 'search-active.png'), clip: box })
console.log('ok')
await browser.close()
server.close()
