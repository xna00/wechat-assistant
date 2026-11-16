// 微信操作封装（@quickwinlabs/uia + 后台点击 click）
// 全部走 UIA 枚举 + PostMessage 后台点击/滚动：不移动光标、不抢焦点。
import { UiaClient, TreeScope, type UiaElement, type Rect } from '@quickwinlabs/uia'
import { NULL, PtrArrayBuffer, type MaybePtr } from 'quickwin/lib/ffi/ctype.js'
import {
    FindWindow, GetWindowRect, PostMessage, ScreenToClient, EnumWindows, IsWindowVisible, GetClassName,
} from 'quickwin/lib/windows/user32.js'
import { RECT, POINT } from 'quickwin/lib/windows/structs.js'
import { closure } from 'quickwin/lib/ffi/bind.js'
import { captureWindow, cropBmp, bmpToBase64 } from './avatar.ts'

// 非阻塞等待（setTimeout 让出事件循环；os.sleep 会同步卡住 HTTP server，不能用）
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let client: UiaClient | null = null
function uia(): UiaClient | null {
    return client ??= UiaClient.create()
}

/** 微信主窗口 hwnd（标题"微信"——UIA className mmui::MainWindow ≠ Win32 窗口类名，
 *  FindWindow 按类名找不到，须按标题）；未找到 → 0/NULL */
export function findWeChatHwnd(): MaybePtr<'HWND'> {
    return FindWindow(NULL, '微信')
}

/** 找第一个匹配元素（findAllWhere 的便利封装，调用方负责 release 返回值） */
function findFirst(root: UiaElement, match: (el: UiaElement) => boolean): UiaElement | null {
    let found: UiaElement | null = null
    for (const el of root.findAllWhere(TreeScope.Subtree, match)) {
        if (!found) { found = el; break }
        el.release()
    }
    return found
}

/** 目标会话是否已打开。判据：ChatInputField 存在（有会话开着）**且** 聊天区顶部
 *  标题（XTextView，位于输入框上方）=== session。
 *  不能只看输入框——若上一个会话残留着输入框，会误判"已打开"（点击落空也被掩盖）。 */
export function isSessionOpen(hwnd: MaybePtr<'HWND'>, session: string): boolean {
    const c = uia()
    if (!c) return false
    const root = c.elementFromHandle(hwnd)
    if (!root) return false
    try {
        const input = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::ChatInputField' && el.controlType() === 50004)
        if (!input) return false
        const inputTop = input.rect()?.top ?? 0
        input.release()
        const title = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::XTextView' &&
            el.name().trim() === session &&
            (el.rect()?.top ?? Infinity) < inputTop)
        if (!title) return false
        title.release()
        return true
    } finally {
        root.release()
    }
}

/** 当前会话输入框写消息并点发送。发送成功后微信会清空输入框——以此校验真的发出，
 *  未清空（点击落空/setValue 未生效）→ false。 */
export async function sendMessage(hwnd: MaybePtr<'HWND'>, msg: string): Promise<boolean> {
    const c = uia()
    if (!c) return false
    const root = c.elementFromHandle(hwnd)
    if (!root) return false
    try {
        // 输入框：mmui::ChatInputField（Edit）
        const input = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::ChatInputField' && el.controlType() === 50004)
        if (!input) return false
        const inputRect = input.rect()
        input.setValue(msg)
        input.release()

        // 发送按钮：name="发送"（实测唯一），且相对输入框位于其下缘/下方、右半部分。
        // 不用绝对屏幕坐标（如 left>900）——窗口移动/缩放/多屏会失效。
        const send = findFirst(root, (el: UiaElement) => {
            if (el.controlType() !== 50000 || el.name().trim() !== '发送') return false
            const r = el.rect()
            if (!r) return false
            if (!inputRect) return true                       // 无输入框 rect 时退化为仅按 name
            const midX = inputRect.left + (inputRect.right - inputRect.left) / 2
            return r.left >= midX && r.top >= inputRect.bottom - 20
        })
        if (!send) return false
        send.click()
        send.release()
    } finally {
        root.release()
    }
    // 校验：发送成功后输入框应被清空；未清空说明没发出去（重试也交给调用方）
    for (let i = 0; i < 8; i++) {
        await delay(250)
        const r = c.elementFromHandle(hwnd)
        if (!r) continue
        try {
            const inp = findFirst(r, (el: UiaElement) =>
                el.className() === 'mmui::ChatInputField' && el.controlType() === 50004)
            if (inp) {
                const v = inp.value()
                inp.release()
                if (v.trim() === '') return true
            }
        } finally {
            r.release()
        }
    }
    return false
}

/** 打开通讯录：后台点击"通讯录"标签（幂等：已打开则检测容器跳过） */
export function openContacts(hwnd: MaybePtr<'HWND'>): boolean {
    const c = uia()
    if (!c) return false
    const root = c.elementFromHandle(hwnd)
    if (!root) return false
    try {
        // 已打开通讯录：存在容器则跳过（释放找到的元素，避免 UIA 引用泄漏）
        const existing = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::ContactsTableBaseView')
        if (existing) {
            existing.release()
            return true
        }
        const tab = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::XTabBarItem' && el.name().trim() === '通讯录')
        if (!tab) return false
        tab.click()
        tab.release()
        return true
    } finally {
        root.release()
    }
}

/** 联系人名列表（全量，滚动收集）。不做过滤——原样返回（可能混入字母分组头，
 *  但避免误杀单字母昵称的真联系人）。 */
export async function listContacts(hwnd: MaybePtr<'HWND'>): Promise<string[]> {
    return (await listAllContacts(hwnd)).map(x => x.name)
}

/** 联系人 + 头像（全量，滚动收集；base64 BMP）。withAvatar=false 只收集名字。 */
export async function listContactsWithAvatar(hwnd: MaybePtr<'HWND'>): Promise<{ name: string; avatarB64: string }[]> {
    return await listAllContacts(hwnd, true)
}

// ── 通讯录滚动全量收集 ──
// StickyHeaderRecyclerListView 懒加载：只渲染可视 cell。要拿全部必须滚动：
// 先滚到顶，再向下累积去重，直到总数连续 5 轮不再增加（到底）。
const WM_MOUSEWHEEL = 0x020A

/** 通讯录列表容器元素（ContactsTableBaseView）；调用方负责 release。找不到 → null。
 *  只查一次并复用：每轮重新 findFirst 会整窗遍历（聊天历史很长时很慢）。 */
function contactsContainer(c: UiaClient, hwnd: MaybePtr<'HWND'>): UiaElement | null {
    const root = c.elementFromHandle(hwnd)
    if (!root) return null
    try {
        return findFirst(root, (e: UiaElement) => e.className() === 'mmui::ContactsTableBaseView')
    } finally {
        root.release()
    }
}

/** WM_MOUSEWHEEL 滚通讯录列表（delta>0 向上，<0 向下；命中列表中心屏幕坐标，后台不抢焦点） */
function wheelContacts(hwnd: MaybePtr<'HWND'>, listRect: Rect, delta: number): void {
    const cx = Math.round((listRect.left + listRect.right) / 2)
    const cy = Math.round((listRect.top + listRect.bottom) / 2)
    const wp = ((delta & 0xffff) << 16) >>> 0
    const lp = ((cy << 16) | (cx & 0xffff)) >>> 0
    PostMessage(hwnd, WM_MOUSEWHEEL, wp, lp)
}

/** 当前可视联系人 cell（name + 屏幕 rect），只在通讯录容器子树内枚举。 */
function visibleCells(container: UiaElement): { name: string; rect: Rect }[] {
    const cells: { name: string; rect: Rect }[] = []
    for (const el of container.findAllWhere(TreeScope.Subtree,
        (el: UiaElement) => el.className() === 'mmui::ContactsCellItemView')) {
        const n = el.name().trim()
        const r = el.rect()
        if (n && r) cells.push({ name: n, rect: r })
        el.release()
    }
    return cells
}

/** 全部联系人（滚动收集）。withAvatar：边滚边截窗补头像（每轮截一次整窗）。 */
export async function listAllContacts(hwnd: MaybePtr<'HWND'>, withAvatar = false): Promise<{ name: string; avatarB64: string }[]> {
    const c = uia()
    if (!c) return []
    // 容器只定位一次并复用（滚动过程中它本身不变，变的是其子树）
    const container = contactsContainer(c, hwnd)
    if (!container) return []
    try {
        const listRect = container.rect()
        if (!listRect) return []
        const map = new Map<string, string>()       // name -> avatarB64('' 若不带头像)
        // 1) 滚到顶：向上滚，枚举集合连续 3 轮不变 → 到顶（不依赖特定联系人名，通用）
        {
            let last = new Set<string>()
            let topStable = 0
            for (let i = 0; i < 20; i++) {
                wheelContacts(hwnd, listRect, 480)
                wheelContacts(hwnd, listRect, 480)
                wheelContacts(hwnd, listRect, 480)
                await delay(100)
                const cur = new Set(visibleCells(container).map(x => x.name))
                if (cur.size > 0 && cur.size === last.size && [...cur].every(n => last.has(n))) {
                    topStable++
                    if (topStable >= 2) break   // 集合连续 2 轮不变 = 已到顶
                } else {
                    topStable = 0
                }
                last = cur
            }
            await delay(300)
        }

        // 2) 向下累积，直到总数稳定
        let prev = 0, stable = 0
        for (let i = 0; i < 40; i++) {
            const cells = visibleCells(container)
            let cap: { bmp: Uint8Array; width: number; height: number } | null = null
            let win = { left: 0, top: 0 }
            if (withAvatar) {
                cap = captureWindow(hwnd)
                if (cap) {
                    const wr = RECT.alloc()
                    GetWindowRect(hwnd, wr.ptr)
                    win = RECT.decode(wr)
                }
            }
            const A = 44
            for (const cell of cells) {
                const have = map.get(cell.name)
                if (have === undefined || (withAvatar && have === '')) {
                    let avatar = have ?? ''
                    if (withAvatar && cap) {
                        // UIA rect 屏幕坐标 → 窗口内坐标；头像 = cell 左端 8px 起、44x44、垂直居中
                        const x = Math.round(cell.rect.left - win.left + 8)
                        const y = Math.round(cell.rect.top - win.top + ((cell.rect.bottom - cell.rect.top) - A) / 2)
                        if (x >= 0 && y >= 0 && x + A <= cap.width && y + A <= cap.height) {
                            avatar = bmpToBase64(cropBmp(cap.bmp, cap.width, x, y, A, A))
                        }
                    }
                    map.set(cell.name, avatar)
                }
            }
            const added = map.size - prev
            if (added === 0) { stable++; if (stable >= 2) break }   // 到底：总数连续 2 轮不变
            else stable = 0
            prev = map.size
            wheelContacts(hwnd, listRect, -480)
            wheelContacts(hwnd, listRect, -480)
            wheelContacts(hwnd, listRect, -480)
            await delay(350)
        }
        return [...map].map(([name, avatarB64]) => ({ name, avatarB64 }))
    } finally {
        container.release()
    }
}

/** 后台点击某窗口上的屏幕坐标点：ScreenToClient 后 PostMessage（不移动光标、不抢焦点）。 */
function bgClickAt(win: MaybePtr<'HWND'>, sx: number, sy: number): void {
    const pt = POINT.encode({ x: sx, y: sy })
    ScreenToClient(win, pt.ptr)
    const c = POINT.decode(pt)
    const lp = ((c.y << 16) | (c.x & 0xffff)) >>> 0
    PostMessage(win, 0x0200, 0, lp)          // WM_MOUSEMOVE
    PostMessage(win, 0x0201, 0x0001, lp)     // WM_LBUTTONDOWN
    PostMessage(win, 0x0202, 0, lp)          // WM_LBUTTONUP
}

/** 读窗口类名（UTF-16LE → string）。 */
function windowClass(hwnd: MaybePtr<'HWND'>): string {
    const buf = new PtrArrayBuffer(512)
    const n = GetClassName(hwnd, buf, 256)
    const dv = new DataView(buf)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(i * 2, true))
    return s
}

/** 找搜索弹出层对应的顶层窗口 HWND：可见、类名以 Qt 开头、矩形包含结果 cell 中心，
 *  多个候选时取面积最小者（排除主窗等大窗口）。
 *  Qt 弹出层是**独立顶层窗口**（类名形如 Qt51514QWindowToolSaveBits），点击必须发给它；
 *  发给主窗只会被当成"点外部"关掉弹出层，打不开会话。找不到 → NULL。
 *  用"包含 cell 中心 + 最小面积"而非精确 rect 相等：避免边框/阴影/DPI 的 1px 差异导致匹配失败。 */
function findPopoverHwnd(cellRect: Rect): MaybePtr<'HWND'> {
    const cx = (cellRect.left + cellRect.right) / 2
    const cy = (cellRect.top + cellRect.bottom) / 2
    const hwnds: number[] = []
    const collect = closure('<HWND>ptr <>ptr -> i32', (h: number) => { hwnds.push(h); return 1 })
    try { EnumWindows(collect.ptr, NULL) } finally { collect.dispose() }
    let best: MaybePtr<'HWND'> = NULL
    let bestArea = Infinity
    for (const h of hwnds) {
        // h 来自 EnumWindows 回调（原生 HWND 数值），绑定层按不透明指针处理
        const hw = h as unknown as MaybePtr<'HWND'>
        if (!IsWindowVisible(hw)) continue
        if (!windowClass(hw).startsWith('Qt')) continue
        const wr = RECT.alloc()
        GetWindowRect(hw, wr.ptr)
        const r = RECT.decode(wr)
        if (cx < r.left || cx >= r.right || cy < r.top || cy >= r.bottom) continue
        const area = (r.right - r.left) * (r.bottom - r.top)
        if (area < bestArea) { bestArea = area; best = hw }
    }
    return best
}

/** 把搜索框设为 value：先后台点搜索框聚焦（无焦点时 setValue 静默无效），再 setValue。
 *  value='' 用于失败后清空搜索框、关掉弹出层（不能发 Esc）。 */
async function setSearchBox(hwnd: MaybePtr<'HWND'>, value: string): Promise<boolean> {
    const c = uia()
    if (!c) return false
    // 1) 取搜索框位置并点击聚焦
    const root0 = c.elementFromHandle(hwnd)
    if (!root0) return false
    let boxRect: Rect | null = null
    try {
        const box = findFirst(root0, (el: UiaElement) => el.controlType() === 50004 && /搜索/i.test(el.name()))
        if (!box) return false
        boxRect = box.rect()
        box.release()
    } finally {
        root0.release()
    }
    if (boxRect) {
        bgClickAt(hwnd,
            Math.round((boxRect.left + boxRect.right) / 2),
            Math.round((boxRect.top + boxRect.bottom) / 2))
        await delay(300)
    }
    // 2) 重新取元素再 setValue（点击后 UIA 树可能重建，旧元素会失效）
    const root1 = c.elementFromHandle(hwnd)
    if (!root1) return false
    try {
        const box = findFirst(root1, (el: UiaElement) => el.controlType() === 50004 && /搜索/i.test(el.name()))
        if (!box) return false
        box.setValue(value)
        box.release()
        return true
    } finally {
        root1.release()
    }
}

/** 关掉搜索弹出层（绝不发 Esc）：若弹出层还在，点一下聊天输入框——主窗上的点击会被
 *  Qt 当作"点外部"从而关闭弹出层。没有输入框（如通讯录页）则点主窗右侧空白处。 */
async function dismissPopover(hwnd: MaybePtr<'HWND'>): Promise<void> {
    const c = uia()
    if (!c) return
    const root = c.elementFromHandle(hwnd)
    if (!root) return
    let popOpen = false
    let inputRect: Rect | null = null
    try {
        const pop = findFirst(root, (el: UiaElement) => el.className() === 'mmui::SearchContentPopover')
        if (pop) { popOpen = true; pop.release() }
        if (!popOpen) return
        const input = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::ChatInputField' && el.controlType() === 50004)
        if (input) { inputRect = input.rect(); input.release() }
    } finally {
        root.release()
    }
    const wr = RECT.alloc()
    GetWindowRect(hwnd, wr.ptr)
    const win = RECT.decode(wr)
    const p = inputRect ?? {
        left: win.right - 120, top: win.top + 300,
        right: win.right - 80, bottom: win.top + 340,
    }
    bgClickAt(hwnd, Math.round((p.left + p.right) / 2), Math.round((p.top + p.bottom) / 2))
    await delay(500)
}

// 搜索弹出层里「聊天结果」cell 含头像（实测高 64px）；「网络结果」行高约 32-34px。
// 用高度区分，避免把同名的网络结果当成会话点击（点它不会打开会话）。
const CHAT_RESULT_MIN_HEIGHT = 48

/** 打开会话的结果：opened=成功打开；not-found=搜索无此会话；failed=UI 操作失败 */
export type OpenResult = 'opened' | 'not-found' | 'failed'

/** 搜索并打开会话（兜底：会话列表没有目标时用顶部搜索框）。
 *  流程：点搜索框聚焦 → setValue 写词（无焦点时 setValue 会静默无效）→ 等弹出层 →
 *  找结果项（XTableCell，name=目标；取高度最大的那个＝聊天结果，而非网络结果）→
 *  点弹出层窗口 → 等会话打开。选中结果后弹出层自动关闭、搜索框自动清空，**无需 Esc**
 *  （向微信主窗发裸 Esc 会把窗口隐藏到托盘且 UIA 树失效，绝不能这么做）。
 *  每轮重试都重新聚焦 + 写词（上一轮点击可能关掉弹出层却没打开会话）；
 *  最终失败则 setValue('') 清理，避免残留搜索态。 */
export async function searchAndOpen(hwnd: MaybePtr<'HWND'>, session: string): Promise<OpenResult> {
    const c = uia()
    if (!c) return 'failed'
    let notFound = false
    for (let attempt = 0; attempt < 3; attempt++) {
        if (!(await setSearchBox(hwnd, session))) break
        await delay(attempt === 0 ? 800 : 500)
        const root = c.elementFromHandle(hwnd)
        if (!root) continue
        let cellRect: Rect | null = null
        let sawPopover = false
        try {
            const pop = findFirst(root, (el: UiaElement) => el.className() === 'mmui::SearchContentPopover')
            if (pop) { sawPopover = true; pop.release() }
            // 同名的可能有多个（聊天结果 + 网络结果）；聊天结果带头像更高，取最高者。
            // 只有达到 CHAT_RESULT_MIN_HEIGHT 的才算聊天结果。
            let bestH = -1
            for (const el of root.findAllWhere(TreeScope.Subtree, (el: UiaElement) =>
                el.className() === 'mmui::XTableCell' && el.name().trim() === session)) {
                const rr = el.rect()
                el.release()
                if (!rr) continue
                const h = rr.bottom - rr.top
                if (h >= CHAT_RESULT_MIN_HEIGHT && h > bestH) { bestH = h; cellRect = rr }
            }
        } finally {
            root.release()
        }
        // 弹出层已渲染却没有匹配结果 → 目标不存在，重试无意义
        if (!cellRect && sawPopover) { notFound = true; break }
        if (cellRect) {
            const popHwnd = findPopoverHwnd(cellRect)
            if (popHwnd) {
                bgClickAt(popHwnd,
                    Math.round((cellRect.left + cellRect.right) / 2),
                    Math.round((cellRect.top + cellRect.bottom) / 2))
            }
        }
        // 等会话真正打开（ChatInputField 出现且标题=目标）
        for (let w = 0; w < 4; w++) {
            if (isSessionOpen(hwnd, session)) return 'opened'
            await delay(300)
        }
    }
    // 失败：清空搜索框并关掉弹出层（setValue('') + 点输入框；绝不发 Esc）
    await setSearchBox(hwnd, '')
    await dismissPopover(hwnd)
    return notFound ? 'not-found' : 'failed'
}

/** 会话列表直接打开会话（快路径）：找 ChatSessionCell 首行=session → 点击 → 等打开。
 *  列表里没有该会话 → 返回 false（交给 searchAndOpen 搜索兜底）。 */
async function openSessionInList(hwnd: MaybePtr<'HWND'>, session: string): Promise<boolean> {
    const c = uia()
    if (!c) return false
    if (isSessionOpen(hwnd, session)) return true
    for (let attempt = 0; attempt < 3; attempt++) {
        const root = c.elementFromHandle(hwnd)
        if (!root) return false
        let clicked = false
        try {
            const cell = findFirst(root, (el: UiaElement) =>
                el.className().startsWith('mmui::ChatSessionCell') &&
                (el.name().split('\n')[0] ?? '').trim() === session)
            if (cell) {
                cell.click()          // 后台点击，不抢焦点
                cell.release()
                clicked = true
            }
        } finally {
            root.release()
        }
        if (!clicked) return false    // 列表里没有 → 搜索兜底
        // 等会话真正打开，未开则下一轮再点
        for (let w = 0; w < 4; w++) {
            if (isSessionOpen(hwnd, session)) return true
            await delay(400)
        }
    }
    return false
}

/** 打开会话并发送消息（/send 核心）。
 *  快路径：会话列表直接点（快，常见目标都在最近会话）；失败再搜索兜底（覆盖不在列表的）。
 *  返回 sent / not-found（搜索无此会话）/ failed（UI 操作失败）。 */
export type SendResult = 'sent' | 'not-found' | 'failed'
export async function sendToSession(hwnd: MaybePtr<'HWND'>, session: string, message: string): Promise<SendResult> {
    if (!(await openSessionInList(hwnd, session))) {
        const opened = await searchAndOpen(hwnd, session)
        if (opened !== 'opened') return opened
    }
    return (await sendMessage(hwnd, message)) ? 'sent' : 'failed'
}
