// 录制 README 用的动图：Playwright 录 webm → ffmpeg 裁成 GIF。
//
//   node test/record.mjs
//
// 三段：导航的展开/收起与搜索、长按拖拽、管理页。
// 需要 ffmpeg（本机在 ~/.local/bin/ffmpeg.exe）。
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DOCS = join(ROOT, 'docs')
const VENDOR = process.env.DSG_VENDOR || join(ROOT, 'node_modules')
const FFMPEG = process.env.FFMPEG || 'C:/Users/Yi/.local/bin/ffmpeg.exe'
const require = createRequire(join(VENDOR, 'noop.js'))
const { chromium } = require('playwright')

const server = createServer(async (req, res) => {
	const u = new URL(req.url, 'http://x')
	const f = u.pathname === '/' ? join(HERE, 'harness.html')
		: u.pathname === '/client.js' ? join(ROOT, 'client.js')
		: u.pathname.startsWith('/vendor/') ? join(VENDOR, u.pathname.slice(8)) : null
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
await new Promise((d) => server.listen(0, '127.0.0.1', d))
// 别叫 URL —— 会盖住全局的 URL 构造函数
const BASE = `http://127.0.0.1:${server.address().port}/`

mkdirSync(DOCS, { recursive: true })
const VIDEO = join(HERE, 'video')
rmSync(VIDEO, { recursive: true, force: true })
mkdirSync(VIDEO, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })

/** 录一段：setup 准备场景，script 做动作，最后裁成 GIF。 */
async function record({ name, size, setup, script, crop, fps = 14, width = 320 }) {
	const dir = join(VIDEO, name)
	mkdirSync(dir, { recursive: true })
	const ctx = await browser.newContext({
		viewport: size,
		recordVideo: { dir, size },
		deviceScaleFactor: 2,
	})
	const page = await ctx.newPage()
	await page.goto(BASE, { waitUntil: 'load' })
	await page.waitForTimeout(500)
	if (setup) await setup(page)
	await page.waitForTimeout(400)
	await script(page)
	await page.waitForTimeout(500)
	const videoPath = await page.video().path()
	await ctx.close()

	const gif = join(DOCS, `${name}.gif`)
	const vf = `crop=${crop},fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`
	await run(FFMPEG, ['-y', '-i', videoPath, '-vf', vf, '-loop', '0', gif])
	console.log(`  ✓ ${name}.gif`)
}

/** 建两个分组，各塞几条进去（导航场景的公共准备）。 */
const seedGroups = async (page) => {
	const input = page.locator('.dsg-input').first()
	await input.fill('界面美化')
	await input.press('Enter')
	await page.waitForTimeout(250)
	await input.fill('模型接入')
	await input.press('Enter')
	await page.waitForTimeout(250)
	for (const [label, chip] of [['Claude 美化', '界面美化'], ['表情包', '界面美化'], ['Codex 订阅', '模型接入'], ['Command Code', '模型接入']]) {
		await page.evaluate(({ label, chip }) => {
			const src = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === label)
			const dst = [...document.querySelectorAll('.dsg-chip')].find((c) => c.children[1].textContent === chip)
			const r = dst.getBoundingClientRect()
			const dt = new DataTransfer()
			const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 6 }))
			fire(src, 'dragstart')
			fire(dst, 'dragover')
			fire(dst, 'drop')
			fire(src, 'dragend')
		}, { label, chip })
		await page.waitForTimeout(220)
	}
	await page.waitForTimeout(400)
}

// ---- 1. 导航：展开 / 收起 / 搜索 ----
await record({
	name: 'nav-collapse',
	size: { width: 1000, height: 900 },
	crop: '210:470:16:74',
	setup: seedGroups,
	script: async (page) => {
		const chip = (n) => page.locator(`.dsg-chip:has-text("${n}")`).first()
		await chip('界面美化').click()
		await page.waitForTimeout(700)
		await chip('界面美化').click()
		await page.waitForTimeout(700)
		await chip('模型接入').click()
		await page.waitForTimeout(600)
		await page.fill('.dsg-search-input', '美化')
		await page.waitForTimeout(900)
		await page.fill('.dsg-search-input', '')
		await page.waitForTimeout(600)
	},
})

// ---- 2. 长按拖拽分组 ----
await record({
	name: 'nav-drag',
	size: { width: 1000, height: 900 },
	crop: '210:470:16:74',
	setup: seedGroups,
	script: async (page) => {
		await page.evaluate(async () => {
			const chips = [...document.querySelectorAll('.dsg-chip')]
			const src = chips.find((c) => c.children[1].textContent === '模型接入')
			const dst = chips.find((c) => c.children[1].textContent === '界面美化')
			if (src === undefined || dst === undefined) return
			const a = src.getBoundingClientRect()
			const b = dst.getBoundingClientRect()
			const sx = a.left + a.width / 2
			const sy = a.top + a.height / 2
			const tx = b.left + b.width / 2
			const ty = b.top + 4
			const fire = (el, t, x, y) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }))
			fire(src, 'pointerdown', sx, sy)
			await new Promise((r) => setTimeout(r, 320))
			for (let i = 1; i <= 10; i += 1) {
				fire(document, 'pointermove', sx + ((tx - sx) * i) / 10, sy + ((ty - sy) * i) / 10)
				await new Promise((r) => setTimeout(r, 60))
			}
			await new Promise((r) => setTimeout(r, 300))
			fire(document, 'pointerup', tx, ty)
		})
		await page.waitForTimeout(800)
	},
})

// ---- 3. 管理页 ----
await record({
	name: 'admin-page',
	size: { width: 1100, height: 900 },
	crop: '760:470:330:60',
	setup: seedGroups,
	script: async (page) => {
		await page.evaluate(() => {
			const sw = document.querySelector('.dsg-switch')
			if (sw !== null) sw.click()
			if (sw !== null) sw.click()
		})
		await page.waitForTimeout(500)
		await page.evaluate(() => window.scrollTo(0, 120))
		await page.waitForTimeout(500)
		await page.evaluate(() => window.scrollTo(0, 0))
		await page.waitForTimeout(500)
		// 打开一次「加入分组」下拉，展示自绘组件
		await page.evaluate(() => document.querySelector('.dsg-picker-btn')?.click())
		await page.waitForTimeout(900)
		await page.mouse.click(10, 10)
		await page.waitForTimeout(400)
	},
	fps: 14,
	width: 560,
})

await browser.close()
server.close()
rmSync(VIDEO, { recursive: true, force: true })
console.log('done →', DOCS)
