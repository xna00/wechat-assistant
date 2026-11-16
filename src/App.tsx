// 微信助手 GUI：status 面板（调本地 /status API）。API 为核心，GUI 为辅助展示。
import 'quickwin/lib/fetch.js'   // 全局 fetch（类型 + 运行时）
import { useEffect, useState } from 'react'
import { Button } from 'quickwin/lib/react-qw/index.js'
import { WindowStyle } from 'quickwin/constants'

const API = 'http://127.0.0.1:8123'

interface Status {
    running: boolean
    hwnd: number
}

export function App() {
    const [status, setStatus] = useState<Status | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

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
                text={`API: ${API}/status（VM 内部调用）`} />
        </w>
    )
}
