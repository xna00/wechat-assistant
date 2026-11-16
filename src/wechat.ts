// 微信操作封装（@quickwinlabs/uia + 后台点击 click）
// 全部走 UIA 枚举 + PostMessage 后台点击/滚动：不移动光标、不抢焦点。
import { UiaClient, TreeScope, type UiaElement, type Rect } from '@quickwinlabs/uia'
import { NULL, PtrArrayBuffer, type MaybePtr } from 'quickwin/lib/ffi/ctype.js'
import {
    FindWindow, GetWindowRect, PostMessage, ScreenToClient, EnumWindows, IsWindowVisible, GetClassName,
    SetForegroundWindow, SendInput, OpenClipboard, EmptyClipboard, SetClipboardData, CloseClipboard,
} from 'quickwin/lib/windows/user32.js'
import {
    GlobalAlloc, GlobalLock, GlobalUnlock, GlobalFree, RtlMoveMemory,
} from 'quickwin/lib/windows/kernel32.js'
import { RECT, POINT, INPUT } from 'quickwin/lib/windows/structs.js'
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

/** WM_MOUSEWHEEL 滚列表（delta>0 向上，<0 向下；命中 rect 中心屏幕坐标，后台不抢焦点） */
function wheelScroll(hwnd: MaybePtr<'HWND'>, listRect: Rect, delta: number): void {
    const cx = Math.round((listRect.left + listRect.right) / 2)
    const cy = Math.round((listRect.top + listRect.bottom) / 2)
    const wp = ((delta & 0xffff) << 16) >>> 0
    const lp = ((cy << 16) | (cx & 0xffff)) >>> 0
    PostMessage(hwnd, WM_MOUSEWHEEL, wp, lp)
}

/** WM_MOUSEWHEEL 滚通讯录列表（delta>0 向上，<0 向下；命中列表中心屏幕坐标，后台不抢焦点） */
function wheelContacts(hwnd: MaybePtr<'HWND'>, listRect: Rect, delta: number): void {
    wheelScroll(hwnd, listRect, delta)
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
    const opened = await openSession(hwnd, session)
    if (opened !== 'opened') return opened
    return (await sendMessage(hwnd, message)) ? 'sent' : 'failed'
}

// ── 发送文件（剪贴板 CF_HDROP + SendInput Ctrl+V + 点发送）──
// 微信原生识别剪贴板文件：Ctrl+V 粘贴到输入区显示为待发送附件，点"发送"发出。
// 注意：SendInput 是真键盘事件，须微信窗口在前台焦点（会短暂抢焦点——发文件不可避免）；
// 文本发送（sendMessage）仍走 PostMessage 后台不抢焦点。
const CF_HDROP = 15
const GMEM_MOVEABLE = 0x2, GMEM_ZEROINIT = 0x40
const VK_CONTROL = 0x11, VK_V = 0x56, KEYEVENTF_KEYUP = 0x2

/** 字符串 → UTF-16LE 字节（DROPFILES 路径编码用）。 */
function utf16leBytes(s: string): Uint8Array {
    const out = new Uint8Array(s.length * 2)
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        out[i * 2] = c & 0xff
        out[i * 2 + 1] = (c >> 8) & 0xff
    }
    return out
}

/** 放文件路径列表到剪贴板（CF_HDROP，UTF-16 路径双 \0 结尾）。
 *  成功 → true（系统接管内存，勿 GlobalFree）；失败 → false（已释放）。 */
function clipboardSetFiles(paths: string[]): boolean {
    let total = 20                                    // DROPFILES header
    const parts: Uint8Array[] = []
    for (const p of paths) {
        const b = utf16leBytes(p)
        parts.push(b)
        total += b.length + 2                         // 路径 + 终止 \0
    }
    total += 2                                        // 列表终止 \0
    const data = new PtrArrayBuffer(total)
    const dv = new DataView(data)
    dv.setUint32(0, 20, true)                         // pFiles = sizeof(DROPFILES)
    dv.setUint32(4, 0, true)                          // pt.x
    dv.setUint32(8, 0, true)                          // pt.y
    dv.setUint32(12, 0, true)                         // fNC
    dv.setUint32(16, 1, true)                         // fWide = UTF-16
    const u8 = new Uint8Array(data)
    let off = 20
    for (const b of parts) {
        u8.set(b, off)
        off += b.length + 2                           // 路径 \0 由 ZEROINIT 保证
    }
    const hMem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total)
    if (!hMem) return false
    if (!OpenClipboard(NULL)) { GlobalFree(hMem); return false }
    let handed = false
    try {
        if (!EmptyClipboard()) return false
        const p = GlobalLock(hMem)
        if (!p) return false
        RtlMoveMemory(p, data, total)
        GlobalUnlock(hMem)
        if (!SetClipboardData(CF_HDROP, hMem)) return false
        handed = true                                 // 系统接管内存
        return true
    } finally {
        CloseClipboard()
        if (!handed) GlobalFree(hMem)
    }
}

/** SendInput 注入 Ctrl+V（真键盘事件，更新系统键盘状态 → 微信识别粘贴）。 */
function sendCtrlV(): void {
    const evs = [
        { type: 1, data: { ki: { wVk: VK_CONTROL, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } },
        { type: 1, data: { ki: { wVk: VK_V, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } },
        { type: 1, data: { ki: { wVk: VK_V, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } },
        { type: 1, data: { ki: { wVk: VK_CONTROL, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } },
    ]
    SendInput(evs.length, evs, INPUT.size)
}

/** 定位"发送"按钮（name=发送，输入框下缘下方右半——同 sendMessage 的规则）。
 *  调用方负责 release。 */
function findSendButton(c: UiaClient, hwnd: MaybePtr<'HWND'>, inputRect: Rect | null): UiaElement | null {
    const root = c.elementFromHandle(hwnd)
    if (!root) return null
    try {
        return findFirst(root, (el: UiaElement) => {
            if (el.controlType() !== 50000 || el.name().trim() !== '发送') return false
            const r = el.rect()
            if (!r) return false
            if (!inputRect) return true
            const midX = inputRect.left + (inputRect.right - inputRect.left) / 2
            return r.left >= midX && r.top >= inputRect.bottom - 20
        })
    } finally {
        root.release()
    }
}

/** 轮询发送按钮 enabled 状态（文件附件出现 → 按钮变绿 enabled；发送完 → 回灰 disabled）。 */
async function waitSendButtonEnabled(
    c: UiaClient, hwnd: MaybePtr<'HWND'>, inputRect: Rect | null,
    want: boolean, timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const btn = findSendButton(c, hwnd, inputRect)
        if (btn) {
            try {
                if (btn.isEnabled() === want) return true
            } finally {
                btn.release()
            }
        }
        await delay(300)
    }
    return false
}

/** 打开会话并发送文件（剪贴板 CF_HDROP + SendInput Ctrl+V 粘贴为附件 + 点发送）。
 *  校验：粘贴后发送按钮变 enabled（附件出现）→ 点发送 → 按钮回 disabled（已发出）。
 *  返回 sent / not-found / failed。 */
export async function sendFileToSession(
    hwnd: MaybePtr<'HWND'>, session: string, filePath: string,
): Promise<SendResult> {
    const opened = await openSession(hwnd, session)
    if (opened !== 'opened') return opened
    const c = uia()
    if (!c) return 'failed'
    const root = c.elementFromHandle(hwnd)
    if (!root) return 'failed'
    try {
        const input = findFirst(root, (el: UiaElement) =>
            el.className() === 'mmui::ChatInputField' && el.controlType() === 50004)
        if (!input) return 'failed'
        const inputRect = input.rect()
        input.release()
        if (!clipboardSetFiles([filePath])) return 'failed'
        // 真键盘事件需前台焦点：激活微信窗口 + 聚焦输入框（后台点击）
        SetForegroundWindow(hwnd)
        await delay(300)
        if (inputRect) {
            bgClickAt(hwnd, (inputRect.left + inputRect.right) / 2, (inputRect.top + inputRect.bottom) / 2)
        }
        await delay(200)
        sendCtrlV()
        // 等文件附件出现（发送按钮 enabled）
        if (!await waitSendButtonEnabled(c, hwnd, inputRect, true, 6000)) return 'failed'
        const send = findSendButton(c, hwnd, inputRect)
        if (!send) return 'failed'
        send.click()
        send.release()
        // 等发送完成（按钮回 disabled）
        if (!await waitSendButtonEnabled(c, hwnd, inputRect, false, 8000)) return 'failed'
        return 'sent'
    } finally {
        root.release()
    }
}

// ── 读消息 ──
// 消息在 mmui::RecyclerListView（name="消息"）里：ChatTextItemView.name=文本，
// ChatItemView.name=时间分隔。方向（in/out）不在 UIA 树，用截图像素测气泡左右：
// 左=别人(in)、右=自己(out)。
export type ChatMessage = { direction: 'out' | 'in'; text: string; time: string | null }

/** 打开会话（列表快路径 + 搜索兜底）；sendToSession / readMessages 共用。 */
export async function openSession(hwnd: MaybePtr<'HWND'>, session: string): Promise<OpenResult> {
    if (await openSessionInList(hwnd, session)) return 'opened'
    return await searchAndOpen(hwnd, session)
}

/** 消息列表容器（RecyclerListView name="消息"）；调用方负责 release。找不到 → null。 */
function messageList(c: UiaClient, hwnd: MaybePtr<'HWND'>): UiaElement | null {
    const root = c.elementFromHandle(hwnd)
    if (!root) return null
    try {
        return findFirst(root, (e: UiaElement) =>
            e.className() === 'mmui::RecyclerListView' && e.name().trim() === '消息')
    } finally {
        root.release()
    }
}

/** 当前可视消息项（顶→底）：kind='msg'（ChatTextItemView）| 'time'（ChatItemView 分隔符）。 */
function visibleMessages(list: UiaElement): { kind: 'msg' | 'time'; text: string; rect: Rect }[] {
    const items: { kind: 'msg' | 'time'; text: string; rect: Rect }[] = []
    for (const el of list.findAllWhere(TreeScope.Subtree, (e: UiaElement) =>
        e.className() === 'mmui::ChatTextItemView' || e.className() === 'mmui::ChatItemView')) {
        const t = (el.name() || '').trim()
        const r = el.rect()
        if (t && r) {
            items.push({
                kind: el.className() === 'mmui::ChatItemView' ? 'time' : 'msg',
                text: t,
                rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            })
        }
        el.release()
    }
    return items.sort((a, b) => a.rect.top - b.rect.top)   // 顶→底
}

/** 窗口左上角（屏幕坐标）。 */
function windowOrigin(hwnd: MaybePtr<'HWND'>): { x: number; y: number } {
    const wr = RECT.alloc()
    GetWindowRect(hwnd, wr.ptr)
    const r = RECT.decode(wr)
    return { x: r.left, y: r.top }
}

/** 由截图 + 行 rect 判方向：统计行内非背景像素左右分布（裁剪到列表可见区），右多=out，左多=in。
 *  direction=null 表示样本不可用（行大部分在视口外 / 无足够内容），调用方应跳过该行留待重试。
 *  viewport 为消息列表可见区（屏幕坐标），null=不裁剪（调用方已确认行完整可见时可不传）。 */
function directionFromPixels(cap: { bmp: Uint8Array; width: number; height: number }, win: { x: number; y: number }, rect: Rect, viewport: Rect | null): { direction: 'out' | 'in' | null; content: number } {
    const BMP_HDR = 54                       // BITMAPFILEHEADER + BITMAPINFOHEADER
    const st = (w: number) => (w * 3 + 3) & ~3
    const { bmp, width, height } = cap
    let x0 = Math.round(rect.left - win.x), y0 = Math.round(rect.top - win.y)
    let x1 = Math.round(rect.right - win.x), y1 = Math.round(rect.bottom - win.y)
    const fullH = y1 - y0
    if (viewport) {                          // 裁剪到列表可见区（避免采样被视口裁掉的部分）
        const vx0 = Math.round(viewport.left - win.x), vy0 = Math.round(viewport.top - win.y)
        const vx1 = Math.round(viewport.right - win.x), vy1 = Math.round(viewport.bottom - win.y)
        x0 = Math.max(x0, vx0); y0 = Math.max(y0, vy0)
        x1 = Math.min(x1, vx1); y1 = Math.min(y1, vy1)
    }
    const clipH = y1 - y0
    if (clipH < fullH * 0.8 || x1 - x0 < 60) return { direction: null, content: 0 }   // 行大部分被视口裁掉
    const mid = (x0 + x1) / 2
    const px = (x: number, y: number): [number, number, number] => {
        const xx = Math.max(0, Math.min(width - 1, Math.round(x)))
        const yy = Math.max(0, Math.min(height - 1, Math.round(y)))
        const o = BMP_HDR + yy * st(width) + xx * 3
        return [bmp[o], bmp[o + 1], bmp[o + 2]]   // BGR
    }
    // 背景参考取行左缘（in 气泡在头像后 ~56px 起，左缘是背景；out 气泡在右侧）
    const bg = px(x0 + 3, (y0 + y1) / 2)
    let L = 0, R = 0
    for (let y = y0 + 4; y < y1 - 4; y += 2) {
        for (let x = x0 + 4; x < x1 - 4; x += 2) {
            const p = px(x, y)
            const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2])
            if (d > 80) { if (x < mid) L++; else R++ }
        }
    }
    const content = L + R
    if (content < 50) return { direction: null, content }   // 无足够内容，样本不可用
    return { direction: R > L ? 'out' : 'in', content }
}

/** 读消息结果：ok 携带消息（数组末尾=最新）；失败区分会话不存在（404）与其他 UI 失败（500）。 */
export type ReadMessagesResult =
    | { ok: true; messages: ChatMessage[] }
    | { ok: false; reason: 'not-found' | 'failed' }

/** 当前可视消息项集合指纹（文本|top）。 */
function visibleKey(list: UiaElement): Set<string> {
    return new Set(visibleMessages(list).map(x => x.text + '|' + Math.round(x.rect.top)))
}

/** 等待消息列表稳定（连续两次读数一致，~180ms 间隔）；消除滚动动画造成的捕获/UIA 竞态。
 *  超时（~2.2s）仍不稳 → false（调用方跳过本轮，下次再试）。 */
async function waitStable(list: UiaElement): Promise<boolean> {
    for (let i = 0; i < 12; i++) {
        const a = visibleKey(list)
        await delay(180)
        const b = visibleKey(list)
        if (a.size > 0 && a.size === b.size && [...a].every(k => b.has(k))) return true
    }
    return false
}

/** 读会话最近 limit 条消息（从底部往上收集，向上滚动补足）。
 *  顺序：数组末尾是最新（顶→底）。 */
export async function readMessages(hwnd: MaybePtr<'HWND'>, session: string, limit = 20): Promise<ReadMessagesResult> {
    const opened = await openSession(hwnd, session)
    if (opened === 'not-found') return { ok: false, reason: 'not-found' }
    if (opened !== 'opened') return { ok: false, reason: 'failed' }
    const c = uia()
    if (!c) return { ok: false, reason: 'failed' }
    const list = messageList(c, hwnd)
    if (!list) return { ok: false, reason: 'failed' }
    try {
        const listRect = list.rect()
        if (!listRect) return { ok: false, reason: 'failed' }
        // 1) 滚到底（最新消息在底部）：向下滚直到集合稳定
        {
            let last = new Set<string>()
            let stable = 0
            for (let i = 0; i < 20; i++) {
                wheelScroll(hwnd, listRect, -480)
                wheelScroll(hwnd, listRect, -480)
                wheelScroll(hwnd, listRect, -480)
                await delay(120)
                const cur = new Set(visibleMessages(list).map(x => x.text + '|' + x.rect.top))
                if (cur.size > 0 && cur.size === last.size && [...cur].every(t => last.has(t))) {
                    stable++
                    if (stable >= 2) break
                } else stable = 0
                last = cur
            }
            await delay(300)
        }
        // 2) 从底向上收集（每步：等稳定 → 捕获 → 裁剪到视口判方向）。
        //    先顶→底扫描赋时间（分隔符更新当前组），再底→顶收集（最新先）。
        //    行被视口裁剪 / 内容不足 → 跳过，留待后续步（该行完整可见时）再收。
        //    去重按 text（稳定身份）：同一消息在不同滚动步可能被赋不同时间（时间组取决于
        //    视口内可见分隔符），故按 text 合并、时间取非 null 优先，避免幻影重复。
        //    【已知局限】相同 text 的不同真实消息会被合并丢失（UIA 近似，主路径够用；
        //    精确/历史读用 /messages/db，无此问题）。
        const collected = new Map<string, ChatMessage>()   // key=text，值=消息；最新在末尾插入
        let prevVisible: Set<string> | null = null
        for (let step = 0; step < 40 && collected.size < limit; step++) {
            if (!(await waitStable(list))) continue            // 滚动中，跳过本轮
            const items = visibleMessages(list)
            const curVisible = new Set(items.map(x => x.text + '|' + Math.round(x.rect.top)))
            const cap = captureWindow(hwnd)
            if (!cap) break
            const win = windowOrigin(hwnd)
            // 顶→底赋时间
            let curTime: string | null = null
            const withTime: ({ text: string; time: string | null; rect: Rect })[] = []
            for (const it of items) {
                if (it.kind === 'time') { curTime = it.text; continue }
                withTime.push({ text: it.text, time: curTime, rect: it.rect })
            }
            // 底→顶收集（最新先）：按 text 合并，时间取非 null 优先
            let added = 0
            for (let i = withTime.length - 1; i >= 0; i--) {
                const m = withTime[i]
                const d = directionFromPixels(cap, win, m.rect, listRect)
                if (!d.direction) continue                     // 裁剪/内容不足 → 本轮跳过
                const existing = collected.get(m.text)
                if (existing) {
                    if (existing.time === null && m.time !== null) collected.set(m.text, { ...existing, time: m.time })
                    continue
                }
                collected.set(m.text, { direction: d.direction, text: m.text, time: m.time })
                added++
            }
            if (added === 0) {
                // 本轮无新消息；若可见集也没变 → 已到顶，停止
                if (prevVisible && curVisible.size === prevVisible.size && [...curVisible].every(k => prevVisible!.has(k))) break
                prevVisible = curVisible
            } else {
                prevVisible = curVisible
            }
            if (collected.size >= limit) break
            // 向上滚一页；若无新消息且到顶则停
            wheelScroll(hwnd, listRect, 480)
            wheelScroll(hwnd, listRect, 480)
            wheelScroll(hwnd, listRect, 480)
            await delay(350)
        }
        // Map 插入序=首次收集序（最新在前）→ 取前 limit 条再反转成 顶→底，末尾最新
        const messages = [...collected.values()].slice(0, limit).reverse()
        return { ok: true, messages }
    } finally {
        list.release()
    }
}
