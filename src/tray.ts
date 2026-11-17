// 托盘：Shell_NotifyIcon 把事件投给主窗（消息号自定，WM_APP+1），图标来自 loadAppIconScaled()，
// 也就是 build.ts 盖进 exe 的那份 RT_GROUP_ICON（resedit 固定 ID 101）
import * as gui from 'gui'
import { NULL, PtrArrayBuffer, type MaybePtr } from 'quickwin/lib/ffi/ctype.js'
import { loadAppIconScaled } from 'quickwin/lib/app-icon.js'
import {
    AppendMenu, CreatePopupMenu, DestroyMenu, GetCursorPos, LoadImage, PostQuitMessage,
    SetForegroundWindow, ShowWindow, TrackPopupMenu,
} from 'quickwin/lib/windows/user32.js'
import { GetModuleFileName } from 'quickwin/lib/windows/kernel32.js'
import { WCHAR } from 'quickwin/lib/ffi/bind.js'
import { NOTIFYICONDATAW, POINT } from 'quickwin/lib/windows/structs.js'
import { ShellExecute, ShellNotifyIcon } from 'quickwin/lib/windows/shell32.js'
import {
    IDI, ImageType, LoadImageFlag, MenuFlag, NotifyIconCmd, NotifyIconFlag,
    ShowWindowCmd, TrackPopupMenuFlag, WmMsg,
} from 'quickwin/constants'
import { APP_TITLE } from './config.ts'
import { stopApiServer } from './api.ts'

const WM_TRAY = 0x8001      // WM_APP + 1
const CMD_SHOW = 1          // TrackPopupMenu 的返回值就是菜单项 ID
const CMD_RESTART = 2
const CMD_QUIT = 3

/** UTF-16LE 缓冲 → string（GetModuleFileNameW 出参，遇 \0 停）。 */
function readWStrBuf(buf: PtrArrayBuffer<''>): string {
    const u8 = new Uint8Array(buf)
    const u16: number[] = []
    for (let i = 0; i + 1 < u8.length; i += 2) {
        const c = u8[i]! | (u8[i + 1]! << 8)
        if (c === 0) break
        u16.push(c)
    }
    return String.fromCharCode(...u16)
}

/** 挂上托盘图标；handle() 供主窗 onEvent 转发 WM_TRAY。 */
export function installTray(hwnd: gui.HWND) {
    // LoadImageW 的句柄随 uType 变（HICON/HCURSOR/HBITMAP），绑定给不出具体类型，按裸指针声明。
    // 按系统 DPI 取实际像素（125% 时 16 → 20px），高 DPI 下不会被系统放大而发虚
    let hIcon: MaybePtr<''> | null = loadAppIconScaled(16, 16)
    if (!hIcon) hIcon = LoadImage(NULL, IDI.APPLICATION, ImageType.ICON, 0, 0, LoadImageFlag.SHARED)

    const added = !!hIcon && !!ShellNotifyIcon(NotifyIconCmd.ADD, {
        cbSize: NOTIFYICONDATAW.size,
        hWnd: hwnd,
        uID: 1,
        uFlags: NotifyIconFlag.MESSAGE | NotifyIconFlag.ICON | NotifyIconFlag.TIP,
        uCallbackMessage: WM_TRAY,
        hIcon,
        szTip: APP_TITLE,
    })
    if (!added) print('[tray] Shell_NotifyIcon(ADD) failed')

    function show() {
        ShowWindow(hwnd, ShowWindowCmd.SHOW)
        SetForegroundWindow(hwnd)
    }

    function quit() {
        ShellNotifyIcon(NotifyIconCmd.DELETE, { cbSize: NOTIFYICONDATAW.size, hWnd: hwnd, uID: 1 })
        PostQuitMessage(0)
    }

    function restart() {
        // GetModuleFileName 出参是 <WCHAR>ptr，nSize 单位 WCHAR：WCHAR.alloc(512) = 1024B
        // 与 nSize=512 对齐（tray 旧版已用对 nSize=512，改 <WCHAR>ptr 后强制 .ptr）。
        const buf = WCHAR.alloc(512)                            // 512 WCHAR
        if (GetModuleFileName(NULL, buf.ptr, 512) === 0) return // 拿当前 exe 路径失败
        const exe = readWStrBuf(buf)
        if (!exe) return
        // 先启动新实例，成功（>32）才关服务/退出；若启动失败则不动作（保服务、保窗口）。
        // 新实例带 --restart 参数 + SW_HIDE：启动后 noShowWindow 静默到托盘，不弹窗。
        const h = ShellExecute(NULL, 'open', exe, '--restart', NULL, ShowWindowCmd.HIDE)
        if (!h || Number(h) <= 32) return
        stopApiServer()                                         // 同步释放 8123（新实例才能 bind）
        setTimeout(() => quit(), 800)                           // 旧实例稍后退出
    }

    function popupMenu() {
        SetForegroundWindow(hwnd)   // 不先设前台，菜单在别处点击时收不起来
        const pt = POINT.alloc()
        const pos = GetCursorPos(pt.ptr) ? POINT.decode(pt) : null
        const hMenu = CreatePopupMenu()
        if (hMenu === NULL) return
        AppendMenu(hMenu, 0, CMD_SHOW, '显示窗口')
        AppendMenu(hMenu, MenuFlag.SEPARATOR, 0, NULL)
        AppendMenu(hMenu, 0, CMD_RESTART, '重启')
        AppendMenu(hMenu, MenuFlag.SEPARATOR, 0, NULL)
        AppendMenu(hMenu, 0, CMD_QUIT, '退出')
        const cmd = TrackPopupMenu(hMenu, TrackPopupMenuFlag.RETURNCMD | TrackPopupMenuFlag.RIGHTBUTTON,
            pos?.x ?? 0, pos?.y ?? 0, 0, hwnd, NULL)
        DestroyMenu(hMenu)          // RETURNCMD 模式下菜单不会自己销毁
        if (cmd === CMD_SHOW) show()
        else if (cmd === CMD_RESTART) restart()
        else if (cmd === CMD_QUIT) quit()
    }

    return {
        message: WM_TRAY,
        handle(lParam: number) {
            if (lParam === WmMsg.LBUTTONDOWN) show()
            else if (lParam === WmMsg.RBUTTONDOWN || lParam === WmMsg.CONTEXTMENU) popupMenu()
        },
    }
}
