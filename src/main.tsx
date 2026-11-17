// createRoot 建主窗 → render 挂 React 树；关窗只隐藏到托盘，托盘右键菜单里退出
// 构建 npm run build；运行 dist\app.exe（-o CON 看 stdout）
// 业务模块（api/tray/App）用动态 import，live 版据此拆 chunk。
import 'quickwin/lib/polyfill.js'   // React 调度要用 setTimeout / console
import { createRoot } from 'quickwin/lib/react-qw/index.js'
import { ShowWindow } from 'quickwin/lib/windows/user32.js'
import { GetCommandLineW } from 'quickwin/lib/windows/kernel32.js'
import { ShowWindowCmd, WmMsg } from 'quickwin/constants'
import { APP_TITLE } from './config.ts'

const { startApiServer } = await import('./api.ts')
const { installTray } = await import('./tray.ts')
const { App } = await import('./App.tsx')

// 先起 HTTP API（/status），再建 GUI 窗口
startApiServer()

/** 命令行是否含 --restart（托盘"重启"启动的新实例）：true → 不弹主窗，静默到托盘。
 *  GetCommandLineW 返回整条命令行（含 exe 路径 + 参数），<WCHAR>ptr! 自动解码为 string。 */
function isRestartInstance(): boolean {
    return GetCommandLineW().includes('--restart')
}

// tray 在 createRoot 之后才创建（installTray 需要 hwnd）；先声明为 null，避免 onEvent
// 在初始化完成前引用而触发 TDZ ReferenceError。
let tray: ReturnType<typeof installTray> | null = null

const root = createRoot({
    text: APP_TITLE,
    width: 520,
    height: 400,
    noShowWindow: isRestartInstance(),   // 重启实例不弹窗（只留托盘）；普通启动照常显示
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
