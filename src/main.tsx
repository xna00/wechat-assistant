// createRoot 建主窗 → render 挂 React 树；关窗只隐藏到托盘，托盘右键菜单里退出
// 构建 npm run build；运行 dist\app.exe（-o CON 看 stdout）
import 'quickwin/lib/polyfill.js'   // React 调度要用 setTimeout / console
import { createRoot } from 'quickwin/lib/react-qw/index.js'
import { ShowWindow } from 'quickwin/lib/windows/user32.js'
import { ShowWindowCmd, WmMsg } from 'quickwin/constants'
import { APP_TITLE } from './config.ts'
import { App } from './App.tsx'
import { installTray } from './tray.ts'
import { startApiServer } from './api.ts'

// 先起 HTTP API（/status），再建 GUI 窗口
startApiServer()

// tray 在 createRoot 之后才创建（installTray 需要 hwnd）；先声明为 null，避免 onEvent
// 在初始化完成前引用而触发 TDZ ReferenceError。
let tray: ReturnType<typeof installTray> | null = null

const root = createRoot({
    text: APP_TITLE,
    width: 520,
    height: 400,
    // react-qw 不处理的消息转到这里：返回数字即接管，undefined 则继续走 DefWindowProc
    onEvent: ({ hwnd, msg, lParam }) => {
        if (msg === WmMsg.CLOSE) {                  // 关窗不退出：藏到托盘
            ShowWindow(hwnd, ShowWindowCmd.HIDE)
            return 0
        }
        if (tray && msg === tray.message) {         // 托盘回调（WM_APP+1）
            tray.handle(lParam)
            return 0
        }
    },
})

tray = installTray(root.hwnd)

root.render(<App />)
