// 宿主端：只干一件事 —— 把分组配置落成文件。
//
// 客户端本来把配置存在 localStorage 里，够用。但 localStorage 是按「来源」分的
// （换了 origin / 清了缓存 / 换了窗口分区就是另一份），而主人要的是「关了 DSH
// 再开，收起的分组还是收起的」。所以再落一份磁盘：~/.dsh/dsh-settings-groups.json。
//
// 两边靠 updatedAt 比新旧，谁新听谁的，不会互相覆盖。
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const name = "dsh-settings-groups";
/** webServer 用来注册回环 HTTP 路由。 */
export const inject = ["webServer"];

const BASE = "/api/dsh-settings-groups";
const MAX_BODY = 256 * 1024;

const configPath = () =>
	join(process.env.DSH_HOME || join(homedir(), ".dsh"), "dsh-settings-groups.json");

/** 只放行本机窗口发来的请求：别的机器/网站不该能改这份配置。 */
function isLoopback(request) {
	const address = request.socket?.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) return undefined;
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function readConfig() {
	try {
		const raw = readFileSync(configPath(), "utf8");
		const data = JSON.parse(raw);
		return data !== null && typeof data === "object" ? data : null;
	} catch {
		return null;
	}
}

/** 先写临时文件再改名：中途崩掉也不会留下半个 JSON。 */
function writeConfig(data) {
	const target = configPath();
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, target);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch (_ignored) {
			/* 临时文件清不掉也不影响主流程 */
		}
		throw error;
	}
}

export function apply(ctx) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: `${BASE}/config`,
			handler: async (req, res) => {
				if (!isLoopback(req)) {
					writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
					return;
				}
				if (req.method === "GET") {
					writeJson(res, 200, { ok: true, config: readConfig() });
					return;
				}
				if (req.method === "POST") {
					const body = await readBody(req);
					if (body === undefined || body === null || typeof body !== "object") {
						writeJson(res, 400, { ok: false, error: "bad-body" });
						return;
					}
					try {
						writeConfig(body);
						writeJson(res, 200, { ok: true });
					} catch (error) {
						writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
					}
					return;
				}
				writeJson(res, 405, { ok: false, error: "method-not-allowed" });
			},
		});
		return () => dispose();
	}, "settings-groups: config file route");
}
