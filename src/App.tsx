// 微信助手 GUI：status 面板（调本地 /status API）。API 为核心，GUI 为辅助展示。
// 底部显示 API 根路径地址（/ 自描述文档页）+ 复制按钮——在其它电脑运行本 exe 时可复制地址。
import 'quickwin/lib/fetch.js'   // 全局 fetch（类型 + 运行时）
import { useEffect, useState } from 'react'
import { Button } from 'quickwin/lib/react-qw/index.js'
import { WindowStyle } from 'quickwin/constants'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { OpenClipboard, EmptyClipboard, SetClipboardData, CloseClipboard } from 'quickwin/lib/windows/user32.js'
import { GlobalAlloc, GlobalLock, GlobalUnlock, GlobalFree, RtlMoveMemory } from 'quickwin/lib/windows/kernel32.js'

const API = 'http://127.0.0.1:8123'
// 根路径：GET / 返回自描述 API 文档（端点列表 + 说明），浏览器直接打开即可浏览接口。
const API_URL = API + '/'

const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x2, GMEM_ZEROINIT = 0x40

/** 复制文本到 Windows 剪贴板（CF_UNICODETEXT，UTF-16LE + 结尾 \0）。成功 → true。 */
function copyText(text: string): boolean {
    const size = text.length * 2 + 2                    // UTF-16LE + 结尾 \0
    const buf = new PtrArrayBuffer(size)
    const u8 = new Uint8Array(buf)
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        u8[i * 2] = c & 0xff
        u8[i * 2 + 1] = c >> 8
    }
    const hMem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size)
    if (!hMem) return false
    if (!OpenClipboard(NULL)) { GlobalFree(hMem); return false }
    let handed = false
    try {
        if (!EmptyClipboard()) return false
        const p = GlobalLock(hMem)
        if (!p) return false
        RtlMoveMemory(p, buf, size)
        GlobalUnlock(hMem)
        if (!SetClipboardData(CF_UNICODETEXT, hMem)) return false
        handed = true                                 // 系统接管内存
        return true
    } finally {
        CloseClipboard()
        if (!handed) GlobalFree(hMem)
    }
}

interface Status {
    running: boolean
    hwnd: number
}

export function App() {
    const [status, setStatus] = useState<Status | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [copied, setCopied] = useState(false)

    async function refresh() {
        setBusy(true)
        setError('')
        try {
            const resp = await fetch(API + '/status')
            const data = await resp.json() as Status
            setStatus(data)
        } catch (e) {
            setError(String(e))
            setStatus(null)
        }
        setBusy(false)
    }

    function onCopy() {
        if (copyText(API_URL)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        }
    }

    // 挂载后自动查一次 /status（免得用户先点「刷新状态」）
    useEffect(() => { void refresh() }, [])

    return (
        <w type="STATIC" ws={WindowStyle.VISIBLE}
            style={{ flexDirection: 'column', gap: 10, padding: 16, flexGrow: 1 }}>
            <w type="STATIC" ws={WindowStyle.VISIBLE}
                style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Button onClick={refresh} disabled={busy}>刷新状态</Button>
                <w type="STATIC" ws={WindowStyle.VISIBLE}
                    text={status === null ? (error ? 'API 错误' : '未请求') :
                        status.running ? '微信已连接' : '微信未运行'} />
            </w>
            <w type="STATIC" ws={WindowStyle.VISIBLE}
                text={status === null ? (error || '点「刷新状态」查询 /status') :
                    `hwnd=${status.hwnd}${status.running ? '' : '（未找到微信窗口）'}`} />
            <w type="STATIC" ws={WindowStyle.VISIBLE}
                style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <w type="STATIC" ws={WindowStyle.VISIBLE} text={API_URL} />
                <Button onClick={onCopy}>{copied ? '已复制' : '复制'}</Button>
            </w>
        </w>
    )
}
