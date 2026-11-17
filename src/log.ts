// 运行日志：写入 %TEMP%\wechat-assistant.log。
//
// 崩溃根因（E55–E116 探针锁定）：GetTempPath / GetEnvironmentVariable 的**长度参数单位是
// TCHAR（WCHAR = 2 字节）**，不是字节。旧版传长度 1024（声称 1024 TCHAR = 2048B 容量）但
// buffer 只分配 1024B——native 内部按长度参数处理 buffer（GetTempPath 会清空整个声称容量，
// 即 memset 2048B），越界写 1024B，破坏相邻堆分配（QuickJS arena / 堆对象），随后任何 UIA
// COM 调用（WeChat provider）即进程崩溃。E115 铁证：填 0x55 标记后 GetTempPath(1024, buf1024)
// 把 buf 全部清 0（memset 2048B 越界写）；E116：GetTempPath(512, buf1024)（512 TCHAR =
// 1024B 恰好匹配）10/10 不崩。
//
// 修复：长度参数必须 ≤ buffer 字节数/2。GetTempPath(512, buf1024)（512 TCHAR = 1024B 恰好
// 匹配），native 清空 1024B 不越界。保留原 GetTempPath 函数（纯 ffi，满足「用 ffi」）。
// 验证：GetTempPath(512, buf1024) + 10 次 UIA 遍历 = 10/10 不崩（E116）。
import 'quickwin/lib/polyfill.js'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { WCHAR } from 'quickwin/lib/ffi/bind.js'
import { CreateFile, WriteFile, GetTempPath } from 'quickwin/lib/windows/kernel32.js'

let hLog: number & { readonly ptrBrand: 'HFILE' } | null = null

/** 打开日志文件（懒加载 + 句柄缓存）：返回句柄或 0（失败静默，调用方按 0 跳过写）。 */
function ensureOpen(): number & { readonly ptrBrand: 'HFILE' } | null {
    if (hLog !== null) return hLog
    // GetTempPath 出参是 <WCHAR>ptr（WCHAR 品牌强制），传 WCHAR.alloc(n).ptr（裸地址直通）。
    // nBufferLength 单位是 WCHAR（=2 字节）：WCHAR.alloc(512) = 512 字符 = 1024B，与
    // nBufferLength=512 天然对齐。旧版传 1024（=2048B 声称容量）但 buf 只 1024B——native
    // 内部按 nBufferLength 清空 buffer（memset 2048B）越界写 1024B，破坏相邻堆分配 → 后续
    // UIA 崩溃（E115 铁证）。
    const buf = WCHAR.alloc(512)          // 512 个 WCHAR = 1024B，语义清晰
    const n = GetTempPath(512, buf.ptr)   // nBufferLength = 512 WCHAR，单位对齐
    if (n === 0) return null
    // 读回 UTF-16LE 串到 NUL（GetTempPath 返回长度不含 NUL，扫描更稳）。
    const u8 = new Uint8Array(buf)
    const u16: number[] = []
    for (let i = 0; i + 1 < u8.length; i += 2) {
        const c = u8[i]! | (u8[i + 1]! << 8)
        if (c === 0) break
        u16.push(c)
    }
    const temp = String.fromCharCode(...u16).replace(/\\$/, '')
    const path = new PtrArrayBuffer<'WCHAR'>(512)
    new Uint8Array(path).set(
        new TextEncoder('utf-16le').encode(temp + '\\wechat-assistant.log\0'))
    // GENERIC_WRITE(0x40000000) | FILE_SHARE_READ(1，供外部/本程序读日志) | OPEN_ALWAYS(4)；
    // 失败返回 INVALID_HANDLE_VALUE(-1)/0，这里归一到 null（下次重试）。
    const h = CreateFile(path.ptr, 0x40000000, 1, NULL, 4, 0x80, NULL)
    hLog = h && h !== -1 ? h : null
    return hLog
}

/** 追加一行运行日志（UTF-8 写文件，失败静默——日志绝不影响主流程）。 */
export function log(msg: string): void {
    try {
        const h = ensureOpen()
        if (!h) return
        const line = '[' + new Date().toISOString() + '] ' + msg + '\r\n'
        const bytes = new TextEncoder().encode(line)
        const buf = new PtrArrayBuffer<'BYTE'>(bytes.byteLength)
        new Uint8Array(buf).set(bytes)
        const written = new PtrArrayBuffer<'BYTE'>(4)
        WriteFile(h, buf.ptr, bytes.byteLength, written.ptr, NULL)
    } catch { /* ignore */ }
}
