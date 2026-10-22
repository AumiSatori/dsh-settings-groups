// 宿主端（index.js）的单元测试：不启 DSH，直接喂一个假的 ctx.webServer。
//   node test/host.mjs
// 验证：路由注册、GET/POST 往返、文件真的写出来、非回环请求被拒。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先把 DSH_HOME 指到临时目录，别碰真实的 ~/.dsh
const sandbox = mkdtempSync(join(tmpdir(), 'dsg-host-'))
process.env.DSH_HOME = sandbox

const { apply } = await import('../index.js')

const results = []
const check = (name, pass, detail = '') => {
	results.push({ name, pass })
	console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const routes = []
const ctx = {
	effect(fn) {
		return fn()
	},
	webServer: {
		register(route) {
			routes.push(route)
			return () => {}
		},
	},
}
apply(ctx)

check('注册了一条路由', routes.length === 1, `${routes.length}`)
const route = routes[0]
check('路由路径正确', route.path === '/api/dsh-settings-groups/config', route.path)

/** 造一个假请求：loopback 地址 + 同源 host。 */
const makeReq = (method, body, overrides = {}) => {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
	return {
		method,
		socket: { remoteAddress: '127.0.0.1' },
		headers: { host: '127.0.0.1:65412', origin: 'http://127.0.0.1:65412', ...overrides },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		},
	}
}

/** 收集响应。 */
const makeRes = () => {
	const out = { status: 0, body: null }
	return {
		out,
		writeHead(status) {
			out.status = status
		},
		setHeader() {},
		end(payload) {
			try {
				out.body = JSON.parse(payload)
			} catch {
				out.body = payload
			}
		},
	}
}

// 空文件时 GET
{
	const res = makeRes()
	await route.handler(makeReq('GET'), res)
	check('空配置时 GET 返回 ok 且 config 为 null', res.out.status === 200 && res.out.body.config === null, JSON.stringify(res.out.body))
}

// POST 写入
const sample = { v: 1, updatedAt: 1750000000000, enabled: true, folded: true, groups: [{ id: 'g1', name: '开发工具', entries: ['dsh-read-aloud'], open: false }], loose: [] }
{
	const res = makeRes()
	await route.handler(makeReq('POST', sample), res)
	check('POST 返回 ok', res.out.status === 200 && res.out.body.ok === true, JSON.stringify(res.out.body))
}

// 文件真的落地了
{
	let disk = null
	try {
		disk = JSON.parse(readFileSync(join(sandbox, 'dsh-settings-groups.json'), 'utf8'))
	} catch (error) {
		disk = null
	}
	check('配置写到了 DSH_HOME 下的 json', disk !== null && disk.groups?.[0]?.open === false, disk === null ? '文件没写出来' : '')
}

// 读回来
{
	const res = makeRes()
	await route.handler(makeReq('GET'), res)
	check('GET 能读回刚写的内容', res.out.body.config?.groups?.[0]?.name === '开发工具' && res.out.body.config?.folded === true, JSON.stringify(res.out.body.config?.groups?.[0]))
}

// 非回环：外部地址
{
	const res = makeRes()
	await route.handler(makeReq('POST', sample, { host: 'evil.example.com', origin: 'http://evil.example.com' }), res)
	check('跨源请求被拒', res.out.status === 403, `${res.out.status}`)
}
{
	const res = makeRes()
	await route.handler(makeReq('GET', undefined, { origin: 'http://evil.example.com' }), res)
	check('跨源 origin 被拒', res.out.status === 403, `${res.out.status}`)
}

// 坏 body
{
	const res = makeRes()
	const req = {
		method: 'POST',
		socket: { remoteAddress: '127.0.0.1' },
		headers: { host: '127.0.0.1:65412' },
		async *[Symbol.asyncIterator]() {
			yield Buffer.from('not json')
		},
	}
	await route.handler(req, res)
	check('坏 JSON 返回 400', res.out.status === 400, `${res.out.status}`)
}

// 错误方法
{
	const res = makeRes()
	await route.handler(makeReq('DELETE'), res)
	check('不支持的方法返回 405', res.out.status === 405, `${res.out.status}`)
}

rmSync(sandbox, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
