// 微信助手 HTTP API（quickwin HttpServer）。核心能力：/status —— 微信连接状态；/contacts —— 通讯录联系人；/send —— 发消息/文件。
// 自描述：其余任何请求返回 API 使用说明（见 API_DOC）。
// 绑定 guest 本地 127.0.0.1:8123（VM 内部调用，不做宿主端口映射）。
import { createServer } from 'quickwin/lib/http-server.js'
import { findWeChatHwnd, openContacts, listContacts, listContactsWithAvatar, sendToSession, sendFileToSession, readMessages } from './wechat.ts'
import { readMessagesDb } from './db.ts'

const PORT = 8123

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// ── 自描述：API 使用说明 ──
// 除已知端点（/status /contacts /send）外的任何请求（未知路径 / 错误方法 / GET /）
// 都返回本说明，便于发现端点、调试与机器读取。
const API_DOC = {
    name: 'wechat-assistant',
    description: '微信助手 HTTP API：操作本机 Windows 微信（UIA 枚举 + PostMessage 后台操作，不移动光标、不抢焦点）。',
    base: 'http://127.0.0.1:8123',
    endpoints: [
        {
            method: 'GET',
            path: '/status',
            description: '微信连接状态（仅 FindWindow，不碰 UI、不占 UI 锁）',
            response: { running: true, hwnd: 786792 },
        },
        {
            method: 'GET',
            path: '/contacts',
            description: '通讯录联系人全量列表（滚动收集，约 8-9 秒）',
            query: { avatar: '=1 附带 base64(BMP) 头像；缺省仅名字' },
            response: { contacts: ['张三', '李四'] },
            responseWithAvatar: { contacts: [{ name: '张三', avatar_b64: '<base64 BMP>' }] },
            errors: [
                { status: 503, error: 'wechat not running' },
                { status: 500, error: 'contacts page unavailable' },
            ],
        },
        {
            method: 'POST',
            path: '/send',
            description: '发送消息或文件：先按会话列表直接打开目标（快路径），不在列表则用顶部搜索兜底；选中会话后自动清理搜索态，再输入/粘贴并点发送。message 与 file 二选一。',
            body: {
                session: '文件传输助手',
                message: 'hello',
                file: 'C:\\path\\file.txt',
            },
            bodyNote: {
                message: '与 file 互斥',
                file: '一次只能发一个文件（不支持多文件）；图片→图片消息；与 message 互斥',
            },
            response: { ok: true },
            errors: [
                { status: 400, error: 'missing session/message' },
                { status: 400, error: 'message and file are mutually exclusive' },
                { status: 400, error: 'bad json' },
                { status: 503, error: 'wechat not running' },
                { status: 404, error: 'session not found' },
                { status: 500, error: 'send failed' },
            ],
        },
        {
            method: 'GET',
            path: '/messages',
            description: '读取会话最近 N 条消息（滚动到最新后从底部向上收集；方向由气泡左右位置判定，左=别人 in、右=自己 out；时间取最近的分隔标记）',
            query: { session: '必填，会话名', limit: '可选，条数，默认 20，上限 200' },
            response: { messages: [{ direction: 'out', text: 'hello', time: '12:45' }] },
            errors: [
                { status: 400, error: 'missing session' },
                { status: 503, error: 'wechat not running' },
                { status: 404, error: 'session not found' },
                { status: 500, error: 'read failed' },
            ],
        },
        {
            method: 'GET',
            path: '/messages/db',
            description: '读库增强（混合方案）：从 SQLCipher4 加密库精确读取会话消息。方向/发送人精确（real_sender_id→Name2Id→user_name），支持完整历史分页（offset/limit）。低频调用；读库含 ToS/法律风险，仅作精确校验/历史导出，勿高频。',
            query: { session: '必填，会话名（显示名或 user_name，如 filehelper/谢/wxid_...）', limit: '可选，条数，默认 20，上限 200', offset: '可选，偏移（从最新往回），默认 0' },
            response: { messages: [{ direction: 'out', text: 'hello', time: 1794806346, sender: 'wxid_jfxzqjzuqz0322' }], total: 37 },
            errors: [
                { status: 400, error: 'missing session' },
                { status: 404, error: 'session not found' },
                { status: 500, error: 'read failed' },
            ],
        },
    ],
    notes: [
        '所有操作微信 UI 的请求（/contacts、/send）串行执行（进程内互斥锁），其余排队。',
        '操作会切换微信当前页面：/contacts 切到通讯录页，/send 切到目标会话——这是操作 UI 的必然副作用。',
        '测试发送只允许「文件传输助手」（见 AGENTS.md），避免打扰真实用户。',
    ],
} as const

/** 返回 API 说明（自描述）；extra 用于标注未匹配的请求。 */
function apiDoc(extra?: Record<string, unknown>): Response {
    return json(extra ? { ...API_DOC, ...extra } : API_DOC)
}

// ── 微信 UI 互斥锁 ──
// 所有操作微信 UI 的请求（/contacts 滚动、/send 点击等）必须串行：
// 同一时间仅一个在动 UI，其余排队（防滚动中点击/输入互相干扰）。
// /status 只 FindWindow 不碰 UI，可不锁。
//
// 超时：单个操作超过 timeoutMs 就让调用方先返回（避免客户端无限挂起）。注意锁
// **仍在 fn 真正结束时才释放**（release 挂在 work 上），否则超时后会与下一个请求
// 并发操作 UI。极端情况：fn 永久卡死时，后续请求仍会排队——这是"卡死"本身的代价，
// 好过让所有客户端无限挂起。
let uiLock: Promise<void> = Promise.resolve()
async function withUiLock<T>(fn: () => Promise<T>, timeoutMs = 60000): Promise<T> {
    const prev = uiLock
    let release!: () => void
    uiLock = new Promise<void>((r) => { release = r })
    await prev
    const work = fn().finally(release)
    work.catch(() => { /* 超时后 work 才失败时避免未处理拒绝 */ })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('ui operation timeout')), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/** 当前 API server 句柄（模块级：stopApiServer 需访问；托盘"重启"前先关旧实例释放端口）。 */
let server: ReturnType<typeof createServer> | null = null

/** 启动 API server（幂等：已监听则不重复）。返回监听结果（0=成功）。 */
export function startApiServer(): number {
    const srv = createServer(async (req) => {
        // 兜底：任何未捕获异常（含 withUiLock 超时）都转成 500 JSON，不让连接悬挂/断开
        try {
            return await handle(req)
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e)
            return json({ ok: false, error: 'internal error', detail }, 500)
        }
    })
    async function handle(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname
        if (req.method === 'GET' && path === '/status') {
            const hwnd = findWeChatHwnd()
            return json({
                running: !!hwnd,
                hwnd: hwnd ? Number(hwnd) : 0,
            })
        }
        if (req.method === 'GET' && path === '/contacts') {
            return await withUiLock(async () => {
                const hwnd = findWeChatHwnd()
                if (!hwnd) return json({ error: 'wechat not running' }, 503)
                if (!openContacts(hwnd)) {
                    return json({ error: 'contacts page unavailable' }, 500)
                }
                await delay(800)            // 等 UI 切到通讯录页（非阻塞）
                const withAvatar = new URL(req.url).searchParams.get('avatar') === '1'
                if (withAvatar) {
                    const items = await listContactsWithAvatar(hwnd)
                    return json({ contacts: items.map(i => ({ name: i.name, avatar_b64: i.avatarB64 })) })
                }
                return json({ contacts: await listContacts(hwnd) })
            })
        }
        if (req.method === 'POST' && path === '/send') {
            return await withUiLock(async () => {
                const hwnd = findWeChatHwnd()
                if (!hwnd) return json({ ok: false, error: 'wechat not running' }, 503)
                let body: { session?: unknown; message?: unknown; file?: unknown }
                try { body = await req.json() } catch {
                    return json({ ok: false, error: 'bad json' }, 400)
                }
                const session = typeof body?.session === 'string' ? body.session.trim() : ''
                const message = typeof body?.message === 'string' ? body.message : ''
                const file = typeof body?.file === 'string' ? body.file.trim() : ''
                if (!session || (!message && !file)) {
                    return json({ ok: false, error: 'missing session/message' }, 400)
                }
                if (message && file) {
                    return json({ ok: false, error: 'message and file are mutually exclusive' }, 400)
                }
                const result = file
                    ? await sendFileToSession(hwnd, session, file)
                    : await sendToSession(hwnd, session, message)
                if (result === 'sent') return json({ ok: true })
                if (result === 'not-found') return json({ ok: false, error: 'session not found' }, 404)
                return json({ ok: false, error: 'send failed' }, 500)
            })
        }
        if (req.method === 'GET' && path === '/messages') {
            return await withUiLock(async () => {
                const hwnd = findWeChatHwnd()
                if (!hwnd) return json({ ok: false, error: 'wechat not running' }, 503)
                const q = new URL(req.url).searchParams
                const session = (q.get('session') ?? '').trim()
                if (!session) return json({ ok: false, error: 'missing session' }, 400)
                let limit = 20
                const limitStr = q.get('limit')
                if (limitStr) {
                    limit = Number(limitStr)
                    if (!Number.isInteger(limit) || limit < 1) {
                        return json({ ok: false, error: 'bad limit' }, 400)
                    }
                    limit = Math.min(limit, 200)
                }
                const result = await readMessages(hwnd, session, limit)
                if (!result.ok) {
                    if (result.reason === 'not-found') return json({ ok: false, error: 'session not found' }, 404)
                    return json({ ok: false, error: 'read failed' }, 500)
                }
                return json({ messages: result.messages })
            })
        }
        if (req.method === 'GET' && path === '/messages/db') {
            // 读库增强（混合方案）：精确方向/发送人/完整历史。低频调用，不碰 UI（无 uiLock）。
            const q = new URL(req.url).searchParams
            const session = (q.get('session') ?? '').trim()
            if (!session) return json({ ok: false, error: 'missing session' }, 400)
            let limit = 20
            const limitStr = q.get('limit')
            if (limitStr) {
                limit = Number(limitStr)
                if (!Number.isInteger(limit) || limit < 1) return json({ ok: false, error: 'bad limit' }, 400)
                limit = Math.min(limit, 200)
            }
            let offset = 0
            const offsetStr = q.get('offset')
            if (offsetStr) {
                offset = Number(offsetStr)
                if (!Number.isInteger(offset) || offset < 0) return json({ ok: false, error: 'bad offset' }, 400)
            }
            const result = readMessagesDb(session, limit, offset)
            if (!result.ok) {
                if (result.reason === 'session-not-found') return json({ ok: false, error: 'session not found' }, 404)
                return json({ ok: false, error: 'read failed', reason: result.reason }, 500)
            }
            return json({ messages: result.messages, total: result.total })
        }
        return apiDoc({ request: { method: req.method, path } })
    }
    server = srv
    const rc = srv.listen(PORT, '127.0.0.1')
    console.log('[api] /status /contacts /send /messages /messages/db at http://127.0.0.1:' + PORT +
        ' (other requests -> API doc) listen rc=' + rc +
        ' addr=' + JSON.stringify(srv.address()))
    return rc
}

/** 停止 API server：同步关闭监听 socket 释放端口（托盘"重启"前调用，让新实例可立即 bind）。 */
export function stopApiServer(): void {
    server?.close()
    server = null
}
