import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const vendor = process.env.DSG_VENDOR || join(root, 'node_modules')
const { chromium } = createRequire(join(vendor, 'noop.js'))('playwright')
const files = new Map([
	['/test/harness.html', join(root, 'test/harness.html')],
	['/client.js', join(root, 'client.js')],
	['/vendor/react/umd/react.development.js', join(vendor, 'react/umd/react.development.js')],
	['/vendor/react-dom/umd/react-dom.development.js', join(vendor, 'react-dom/umd/react-dom.development.js')],
])
const browser = await chromium.launch({ channel: process.env.DSG_BROWSER_CHANNEL || 'chrome' })
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 950 } })
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.route('http://dsg.test/**', async (route) => {
		const path = new URL(route.request().url()).pathname
		const file = files.get(path)
		if (file) {
			const contentType = path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'
			return route.fulfill({ contentType, body: await readFile(file) })
		}
		if (path === '/api/dsh-settings-groups/config') return route.fulfill({ json: { ok: true, config: null } })
		return route.fulfill({ status: 404 })
	})
	await page.addInitScript(() => {
		localStorage.setItem('dsh.settingsPanelTweak.v1', JSON.stringify({ panelW: 900, panelH: 700, navW: 240, dx: 0, dy: 0 }))
		localStorage.setItem('dsh.settingsGroups.v1', JSON.stringify({
			v: 1, enabled: true, updatedAt: Date.now(),
			groups: [{ id: 'audio', name: '语音', entries: ['dsh-read-aloud'], open: true }],
		}))
	})
	await page.goto('http://dsg.test/test/harness.html?grid')
	const panel = page.locator('[data-shortcut-modal="settings"]')
	const nav = panel.locator('nav')
	const split = panel.locator('.dsh-ptweak-split')
	const title = panel.locator('#settings-title')
	const actions = panel.locator('#settings-actions')
	const content = panel.locator('#content')
	const group = nav.locator('.dsg-chip[data-dsg-gid="audio"]')
	const row = nav.locator('[data-section="dsh-read-aloud"]')
	const next = nav.locator('.dsg-chip').last()
	await panel.locator('[data-dsg-switch-ready]').waitFor({ state: 'attached' })
	await panel.evaluate(async (el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
	const box = async (locator) => {
		const bounds = await locator.boundingBox()
		assert.ok(bounds)
		return bounds
	}
	const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual}, expected ${expected}`)
	const drag = async (locator, dx, dy, x = 0.5) => {
		const bounds = await box(locator)
		await page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height / 2)
		await page.mouse.down()
		await page.mouse.move(bounds.x + bounds.width * x + dx, bounds.y + bounds.height / 2 + dy, { steps: 8 })
		await page.mouse.up()
	}

	near((await box(nav)).width, 240, 'Restored grid column')
	near((await box(nav)).y, (await box(content)).y, 'Navigation and content share a grid row')
	near((await box(split)).x + 3, (await box(content)).x, 'Splitter sits on the column boundary')
	await drag(split, 65, 0)
	near((await box(nav)).width, 305, 'Dragging splitter resizes the grid column')
	near((await box(title)).width, 305, 'Title follows the column')
	const before = await box(panel)
	await drag(title, 54, 33)
	await drag(actions, -12, -8, 0.12)
	near((await box(panel)).x, before.x + 42, 'Title and action bar move the panel')
	near((await box(panel)).y, before.y + 25, 'Panel follows vertical movement')
	await drag(panel.locator('.dsh-ptweak-rz[data-dir="se"]'), 60, 35)
	const resized = await box(panel)
	near(resized.width, 960, 'Corner resize changes width')
	near(resized.height, 735, 'Corner resize changes height')
	near(resized.x, before.x + 42, 'Corner resize holds opposite edge')

	const expandedHeight = (await box(row)).height
	const expandedY = (await box(next)).y
	const middle = await group.evaluate((button) => {
		button.click()
		const row = document.querySelector('[data-section="dsh-read-aloud"]')
		const animation = row.getAnimations().find((item) => item.animationName === 'dsgItemOut')
		animation.pause()
		animation.currentTime = 95
		return { height: row.getBoundingClientRect().height, margin: parseFloat(getComputedStyle(row).marginBottom) }
	})
	assert.ok(middle.height > 0 && middle.height < expandedHeight && middle.margin > 0 && middle.margin < 4)
	assert.ok((await box(next)).y < expandedY, 'Following group moves during the collapse')
	await row.evaluate((el) => el.getAnimations().forEach((animation) => animation.finish()))
	await row.waitFor({ state: 'hidden' })
	await nav.locator('[data-section="models"]').click()
	await panel.locator('#content[data-dsg-page="in"]').waitFor({ state: 'attached' })
	assert.ok(await content.evaluate((el) => {
		const animation = el.getAnimations().find((item) => item.animationName === 'dsgPageIn')
		if (!animation) return false
		animation.currentTime = 75
		const blur = parseFloat(getComputedStyle(el).filter.slice(5))
		return blur > 0 && blur < 7
	}), 'Content blurs mid-transition')
	assert.equal(await actions.getAttribute('data-dsg-page'), null)
	assert.equal(await content.locator('select,input[type="checkbox"]').count(), 0)

	await actions.getByRole('button', { name: '关闭设置' }).click()
	await panel.waitFor({ state: 'detached' })
	const ghost = page.locator('[data-dsg-ghost="1"]')
	near((await box(ghost.locator('nav'))).width, 305, 'Exit snapshot preserves the resized grid')
	await page.evaluate(() => document.getElementById('btn-open').click())
	await split.waitFor()
	await panel.evaluate(async (el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
	near((await box(panel)).x, resized.x, 'Reopen restores position')
	near((await box(panel)).width, resized.width, 'Reopen restores size')

	await page.setViewportSize({ width: 700, height: 650 })
	await split.waitFor({ state: 'detached' })
	assert.equal(await group.count(), 0)
	assert.equal(await nav.locator('#navlist').evaluate((el) => getComputedStyle(el).flexDirection), 'row')
	near((await box(panel)).width, 700, 'Narrow layout keeps the native full-width panel')
	await page.setViewportSize({ width: 1280, height: 950 })
	await split.waitFor()
	near((await box(nav)).width, 305, 'Returning from narrow layout restores the sidebar width')
	await title.dblclick()
	await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh.settingsPanelTweak.v1')).dx === 0)
	await split.dblclick()
	await page.waitForFunction(() => document.querySelector('[data-shortcut-modal="settings"] > nav').offsetWidth === 188)
	assert.deepEqual(errors, [])
	console.log('DSH 0.2.2 grid panel regression passed')
} finally {
	await browser.close()
}
