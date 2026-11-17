// 读库增强（混合方案 B）：/messages/db 低频精确校验 / 历史导出。
// 只读内存扫描（ReadProcessMemory）提取 SQLCipher4 密钥 → bcrypt AES-256-CBC 解密
// → winsqlite3 查询。不注入 / 不 Hook，不改微信状态。
// 方向 / 发送人精确（real_sender_id→Name2Id→user_name→self 判定），完整历史分页。
import 'quickwin/lib/polyfill.js'
import * as ffi from 'ffi'
import { decompress as zstdDecompress } from 'fzstd'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { struct } from 'quickwin/lib/ffi/struct.js'
import { NULL, PtrArrayBuffer, type C_Struct, type Ptr } from 'quickwin/lib/ffi/ctype.js'
import {
    OpenProcess, CloseHandle, CreateToolhelp32Snapshot, Process32First, Process32Next,
    ReadProcessMemory, CreateFile, ReadFile, WriteFile, GetFileSize,
    FindFirstFile, FindNextFile, FindClose,
    GetTempPath, GetEnvironmentVariable, GetLastError,
    VirtualQueryEx, GetProcessTimes, GetFileAttributes,
} from 'quickwin/lib/windows/kernel32.js'
import {
    PROCESSENTRY32W, WIN32_FIND_DATAW,
    MEMORY_BASIC_INFORMATION,
} from 'quickwin/lib/windows/structs.js'
import {
    BCryptOpenAlgorithmProvider, BCryptSetProperty, BCryptGenerateSymmetricKey,
    BCryptDecrypt, BCryptDestroyKey, BCryptCloseAlgorithmProvider,
    BCryptCreateHash, BCryptHashData, BCryptFinishHash, BCryptDestroyHash,
} from 'quickwin/lib/windows/bcrypt.js'
import { MemState, MemType, PageProtect, BcryptAlgFlag } from 'quickwin/constants.js'

// ============ 常量 ============
const CONFIG_CIPHER_NAME = new TextEncoder().encode('com.Tencent.WCDB.Config.Cipher')
const CONFIG_XOR_MASK = Uint8Array.from([
    0xd2, 0xc7, 0x44, 0x24, 0x58, 0x02, 0x00, 0x00, 0x00, 0x48, 0x89, 0x44, 0x24, 0x50, 0x48, 0x8b,
    0x45, 0x00, 0x48, 0x84, 0x4c, 0x24, 0x48, 0x48, 0x89, 0x44, 0x25, 0x40, 0x48, 0x58, 0x4c, 0x24,
])
const HEX_LITERAL_RE = /[xX]'([0-9a-fA-F]{64,192})'/g
// MEMORY_BASIC_INFORMATION / VirtualQueryEx / GetProcessTimes / GetFileAttributes 现从
// quickwin 主仓 import（见文件头部），MEM_*/PAGE_* 常量走 constants.ts 的 MemState/MemType/
// PageProtect 枚举（gen_const 生成），此处不再手写绑定。
const MAX_USER_ADDR = 0x0000_8000_0000_0000
const INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF
const SQLITE_ROW = 100
const SQLITE_DONE = 101
const SQLITE_INTEGER = 1
const SQLITE_FLOAT = 2
const SQLITE_TEXT = 3
const SQLITE_BLOB = 4
const SQLITE_NULL = 5

// ============ 纯 JS MD5（qwin 无 crypto）============
function md5Hex(input: string): string {
    const bytes = new TextEncoder().encode(input)
    const s: number[] = []
    for (let i = 0; i < bytes.length; i++) s.push(bytes[i]!)
    // pad: 0x80, then zeros, then bit length (little-endian 64-bit)
    const bitLen = s.length * 8
    s.push(0x80)
    while (s.length % 64 !== 56) s.push(0)
    for (let i = 0; i < 8; i++) s.push((bitLen / Math.pow(2, i * 8)) & 0xff)
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
    const K: number[] = []
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
    const sh = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
    for (let off = 0; off < s.length; off += 64) {
        const M: number[] = []
        for (let i = 0; i < 16; i++) M[i] = (s[off + i * 4]! | (s[off + i * 4 + 1]! << 8) | (s[off + i * 4 + 2]! << 16) | (s[off + i * 4 + 3]! << 24)) >>> 0
        let A = a0, B = b0, C = c0, D = d0
        for (let i = 0; i < 64; i++) {
            let F = 0, g = 0
            if (i < 16) { F = (B & C) | (~B & D); g = i }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
            else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
            else { F = C ^ (B | ~D); g = (7 * i) % 16 }
            F = (F + A + K[i]! + M[g]!) >>> 0
            A = D; D = C; C = B
            B = (B + ((F << sh[i]!) | (F >>> (32 - sh[i]!)))) >>> 0
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
    }
    const out: number[] = []
    for (const x of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) out.push((x >>> (i * 8)) & 0xff)
    return out.map(b => b.toString(16).padStart(2, '0')).join('')
}

// ============ 小工具 ============
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
    const first = needle[0]!
    const limit = hay.length - needle.length
    for (let i = from; i <= limit; i++) {
        if (hay[i] !== first) continue
        let ok = true
        for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break }
        if (ok) return i
    }
    return -1
}
function bytesToAscii(b: Uint8Array): string {
    let s = ''
    for (const x of b) s += String.fromCharCode(x)
    return s
}
function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length >> 1)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
}
function bytesToHex(b: Uint8Array): string {
    let s = ''
    for (const x of b) s += x.toString(16).padStart(2, '0')
    return s
}
function probableKey(b: Uint8Array): boolean {
    if (b.length !== 32) return false
    const seen = new Set<number>()
    for (const x of b) seen.add(x)
    if (seen.size < 15) return false
    return !(b.every(x => x === 0) || b.every(x => x === 0xff))
}
function toUtf8(s: string): PtrArrayBuffer<''> {
    const u8 = new TextEncoder().encode(s + '\0')
    const buf = new PtrArrayBuffer(u8.byteLength)
    new Uint8Array(buf).set(u8)
    return buf
}
function readCStr(p: number | null): string {
    if (!p) return ''
    const bytes = (ffi as unknown as { readBytes: (p: number, n: number) => ArrayBuffer }).readBytes(p, 1024)
    const u8 = new Uint8Array(bytes)
    let n = 0
    while (n < u8.length && u8[n] !== 0) n++
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]!)
    return s
}
function readWStrBuf(buf: PtrArrayBuffer<''>): string {
    // GetTempPathW/GetEnvironmentVariableW 出参：UTF-16LE WCHAR 串
    const u8 = new Uint8Array(buf)
    const u16: number[] = []
    for (let i = 0; i + 1 < u8.length; i += 2) {
        const c = u8[i]! | (u8[i + 1]! << 8)
        if (c === 0) break
        u16.push(c)
    }
    return String.fromCharCode(...u16)
}

// ============ 进程 / 目录 ============
function findWeixinPids(): number[] {
    const out: number[] = []
    const snap = CreateToolhelp32Snapshot(0x2, 0)
    const pe = PROCESSENTRY32W.alloc()
    new Uint32Array(pe)[0] = PROCESSENTRY32W.size
    if (Process32First(snap, pe.ptr)) {
        do {
            const e = PROCESSENTRY32W.decode(pe)
            if (e.szExeFile.toLowerCase() === 'weixin.exe') out.push(e.th32ProcessID)
        } while (Process32Next(snap, pe.ptr))
    }
    CloseHandle(snap)
    return out
}

function processCreateTime(h: Ptr<'HPROCESS'>): bigint {
    const cBuf = new PtrArrayBuffer(8)
    const xBuf = new PtrArrayBuffer(8)
    const kBuf = new PtrArrayBuffer(8)
    const uBuf = new PtrArrayBuffer(8)
    if (GetProcessTimes(h, ffi.bufferPtr(cBuf), ffi.bufferPtr(xBuf), ffi.bufferPtr(kBuf), ffi.bufferPtr(uBuf)) === 0) return 0n
    return new DataView(cBuf).getBigUint64(0, true)
}

function getUserProfile(): string {
    // nSize 单位是 WCHAR（=2 字节）：WCHAR.alloc(512) = 512 字符 = 1024B，与 nSize=512 对齐。
    // 旧版传 nSize=1024（=2048B 声称容量）但 buf 只 1024B——native 若按 nSize 处理会越界写。
    const buf = WCHAR.alloc(512)
    const n = GetEnvironmentVariable('USERPROFILE', buf.ptr, 512)
    if (n === 0) return ''
    return readWStrBuf(buf)
}

function getTempDir(): string {
    // GetTempPath 的 nBufferLength 单位是 WCHAR：WCHAR.alloc(512) = 1024B，与 nBufferLength=512
    // 恰好对齐。旧版传 1024（=2048B）但 buf 只有 1024B——native 内部按 nBufferLength 清空
    // buffer（memset 2048B）越界写 1024B，破坏相邻堆分配 → 后续 UIA 崩溃（E115 铁证）。
    const buf = WCHAR.alloc(512)
    const n = GetTempPath(512, buf.ptr)
    if (n === 0) return 'C:\\Windows\\Temp'
    return readWStrBuf(buf)
}

function fileExists(path: string): boolean {
    return GetFileAttributes(path) !== INVALID_FILE_ATTRIBUTES
}

/** 发现微信数据目录：<profile>\Documents\xwechat_files\<wxid>_<suffix>\db_storage */
function findDbDir(): { message: string; contact: string; session: string } | null {
    const profile = getUserProfile()
    const root = profile + '\\Documents\\xwechat_files'
    if (!fileExists(root)) return null
    const dataBuf = WIN32_FIND_DATAW.alloc()
    const find = FindFirstFile(root + '\\*', dataBuf.ptr)
    if (!find) return null
    try {
        let d = WIN32_FIND_DATAW.decode(dataBuf)
        while (true) {
            const name = d.cFileName
            if (name !== '.' && name !== '..' && (d.dwFileAttributes & 0x10 /* DIRECTORY */)) {
                const storage = root + '\\' + name + '\\db_storage'
                const message = storage + '\\message\\message_0.db'
                const contact = storage + '\\contact\\contact.db'
                const session = storage + '\\session\\session.db'
                if (fileExists(message) && fileExists(contact) && fileExists(session)) {
                    return { message, contact, session }
                }
            }
            if (FindNextFile(find, dataBuf.ptr) === 0) break
            d = WIN32_FIND_DATAW.decode(dataBuf)
        }
    } finally {
        FindClose(find)
    }
    return null
}

// ============ 密钥提取 ============
function extractKeys(pid: number): { key: string; salt: string }[] {
    const h = OpenProcess(0x0010 | 0x0400, 0, pid)
    if (h === NULL) return []
    const hp = h as Ptr<'HPROCESS'>
    const read = (addr: number, n: number): Uint8Array | null => {
        if (n <= 0) return null
        const buf = new PtrArrayBuffer(n)
        const brBuf = new PtrArrayBuffer(8)
        const ok = ReadProcessMemory(hp, addr, buf, n, ffi.bufferPtr(brBuf))
        if (!ok) return null
        const br = Number(new DataView(brBuf).getBigUint64(0, true))
        if (br <= 0) return null
        return new Uint8Array(buf, 0, br)
    }
    const findBytes = (needle: Uint8Array, onlyPrivate = false): number[] => {
        const hits: number[] = []
        let addr = 0
        while (addr < MAX_USER_ADDR) {
            const mbi = MEMORY_BASIC_INFORMATION.alloc()
            // dwLength 单位字节 = struct size（x64 48B）；u64 参数须 BigInt
            if (Number(VirtualQueryEx(hp, addr, mbi.ptr, BigInt(MEMORY_BASIC_INFORMATION.size))) === 0) break
            const d = MEMORY_BASIC_INFORMATION.decode(mbi)
            const base = d.BaseAddress
            const size = Number(d.RegionSize)
            if (d.State === MemState.COMMIT && ((d.Protect & 0xFF) & 0xE6) !== 0 && (d.Protect & PageProtect.GUARD) === 0 && size > 0 && size < 0x10000000) {
                if (!onlyPrivate || d.Type === MemType.PRIVATE) {
                    const buf = read(base, size)
                    if (buf) {
                        let pos = 0
                        while (true) {
                            pos = indexOfBytes(buf, needle, pos)
                            if (pos < 0) break
                            hits.push(base + pos)
                            pos += 1
                        }
                    }
                }
            }
            const next = base + size
            if (next <= addr) break
            addr = next
        }
        return hits
    }
    try {
        // 主 needle：先扫私有区（快），0 命中回退全扫（字符串可能在 image .rdata）
        let needles = findBytes(CONFIG_CIPHER_NAME, true)
        if (needles.length === 0) needles = findBytes(CONFIG_CIPHER_NAME, false)
        const pair = new Uint8Array(16)
        const pairDv = new DataView(pair.buffer)
        const out: { key: string; salt: string }[] = []
        const seen = new Set<string>()
        for (const a of needles) {
            pairDv.setBigUint64(0, BigInt(a), true)
            pairDv.setBigUint64(8, BigInt(CONFIG_CIPHER_NAME.length), true)
            for (const qaddr of findBytes(pair, true)) {
                const node = read(qaddr - 0x10, 0x50)
                if (!node || node.length < 0x40) continue
                const ndv = new DataView(node.buffer, node.byteOffset, node.byteLength)
                const nodePtr = Number(ndv.getBigUint64(0x10, true))
                const nodeLen = Number(ndv.getBigUint64(0x18, true))
                if (!needles.includes(nodePtr)) continue
                if (nodeLen !== CONFIG_CIPHER_NAME.length) continue
                const configPtr = Number(ndv.getBigUint64(0x28, true))
                if (!(0x10000 <= configPtr && configPtr < MAX_USER_ADDR)) continue
                const obj = read(configPtr + 0x88, 0x28)
                if (!obj || obj.length < 0x18) continue
                const odv = new DataView(obj.buffer, obj.byteOffset, obj.byteLength)
                const dataPtr = Number(odv.getBigUint64(0x8, true))
                const dataLen = Number(odv.getBigUint64(0x10, true))
                if (!(dataLen > 0 && dataLen <= 1024 && dataPtr >= 0x10000 && dataPtr < MAX_USER_ADDR)) continue
                const blob = read(dataPtr, dataLen)
                if (!blob || blob.length !== dataLen) continue
                const decoded = new Uint8Array(dataLen)
                for (let i = 0; i < dataLen; i++) decoded[i] = blob[i]! ^ CONFIG_XOR_MASK[i % CONFIG_XOR_MASK.length]!
                const text = bytesToAscii(decoded)
                HEX_LITERAL_RE.lastIndex = 0
                let m: RegExpExecArray | null
                while ((m = HEX_LITERAL_RE.exec(text)) !== null) {
                    const run = m[1]!.toLowerCase()
                    const starts: number[] = [0]
                    if (run.length > 96) {
                        for (let s = 0; s <= run.length - 63; s += 32) starts.push(s)
                        starts.push(run.length - 64)
                    }
                    const seenStarts = new Set<number>()
                    for (const s of starts) {
                        if (seenStarts.has(s)) continue
                        seenStarts.add(s)
                        if (s + 64 > run.length) continue
                        const keyHex = run.slice(s, s + 64)
                        if (seen.has(keyHex)) continue
                        const key = hexToBytes(keyHex)
                        if (!probableKey(key)) continue
                        seen.add(keyHex)
                        out.push({ key: keyHex, salt: s + 96 <= run.length ? run.slice(s + 64, s + 96) : '' })
                    }
                }
            }
        }
        return out
    } finally {
        CloseHandle(hp)
    }
}

// 密钥缓存（内存 + 文件）：同微信进程+同登录会话密钥值不变。
// 校验：pid 仍存活 + GetProcessTimes 创建时间一致 → 直接用缓存，免重扫。
// 文件缓存跨 qwin 进程存活（每次 exec 新进程，内存缓存随进程死亡失效 → 文件持久化根治慢因）。
let keyCache: { pid: number; createTime: bigint; keys: { key: string; salt: string }[] } | null = null

interface KeyCacheEntry { pid: number; createTime: string; keys: { key: string; salt: string }[] }
function keyCachePath(): string {
    // Z:\（SMB 共享，宿主文件系统）避免 C:\Temp 在 VM 快照/重启后丢失；
    // 密钥缓存跨进程持久化（同账号同版本同登录会话密钥不变）。
    return 'Z:\\wechat_keys_cache.json'
}
function loadKeyCacheFile(): KeyCacheEntry | null {
    try {
        const raw = readFile(keyCachePath())
        if (!raw) return null
        let s = ''
        for (const b of raw) s += String.fromCharCode(b)
        const o = JSON.parse(s) as KeyCacheEntry
        if (typeof o.pid === 'number' && o.keys && Array.isArray(o.keys) && o.keys.length) return o
        return null
    } catch { return null }
}
function saveKeyCacheFile(pid: number, createTime: bigint, keys: { key: string; salt: string }[]): void {
    try {
        const o: KeyCacheEntry = { pid, createTime: String(createTime), keys }
        writeFile(keyCachePath(), new TextEncoder().encode(JSON.stringify(o)))
    } catch { /* 缓存写失败不阻塞 */ }
}

function getWeixinKeys(): { pid: number; keys: { key: string; salt: string }[] } {
    const pids = findWeixinPids()
    // 1. 内存缓存（同进程内多次调用）
    for (const pid of pids) {
        const h = OpenProcess(0x0010 | 0x0400, 0, pid)
        if (h === NULL) continue
        const ct = processCreateTime(h as Ptr<'HPROCESS'>)
        CloseHandle(h as Ptr<'HPROCESS'>)
        if (keyCache && keyCache.pid === pid && keyCache.createTime === ct && keyCache.keys.length) {
            return { pid, keys: keyCache.keys }
        }
    }
    // 2. 文件缓存（跨进程）：pid 存活 + 创建时间一致 → 直接用，免重扫
    const fc = loadKeyCacheFile()
    if (fc && fc.keys.length) {
        for (const pid of pids) {
            if (pid !== fc.pid) continue
            const h = OpenProcess(0x0010 | 0x0400, 0, pid)
            if (h === NULL) break
            const ct = processCreateTime(h as Ptr<'HPROCESS'>)
            CloseHandle(h as Ptr<'HPROCESS'>)
            if (String(ct) === fc.createTime) {
                keyCache = { pid, createTime: ct, keys: fc.keys }
                console.log('[db] key file-cache hit pid=' + pid + ' keys=' + fc.keys.length)
                return { pid, keys: fc.keys }
            }
            break
        }
    }
    // 3. 重新提取（慢路径），成功后写文件缓存
    for (const pid of pids) {
        const keys = extractKeys(pid)
        if (keys.length) {
            const h = OpenProcess(0x0010 | 0x0400, 0, pid)
            const ct = h === NULL ? 0n : processCreateTime(h as Ptr<'HPROCESS'>)
            if (h !== NULL) CloseHandle(h as Ptr<'HPROCESS'>)
            keyCache = { pid, createTime: ct, keys }
            saveKeyCacheFile(pid, ct, keys)
            console.log('[db] key extracted (slow) pid=' + pid + ' keys=' + keys.length)
            return { pid, keys }
        }
    }
    return { pid: 0, keys: [] }
}

// ============ bcrypt AES-256-CBC ============
// BCrypt* 绑定现从 quickwin 主仓 lib/windows/bcrypt.js import（见文件头部）。
function decryptAesCbc(key: Uint8Array, data: Uint8Array, iv: Uint8Array): Uint8Array | null {
    const hAlgBuf = new PtrArrayBuffer(8)
    if (BCryptOpenAlgorithmProvider(ffi.bufferPtr(hAlgBuf), 'AES', NULL, BcryptAlgFlag.NONE) !== 0) return null
    const hAlg = Number(new DataView(hAlgBuf).getBigUint64(0, true))
    if (!hAlg) return null
    const chaining = new TextEncoder().encode('ChainingModeCBC\0')
    const chBuf = new PtrArrayBuffer(chaining.length)
    new Uint8Array(chBuf).set(chaining)
    BCryptSetProperty(hAlg, 'ChainingMode', chBuf, chaining.length, 0)
    const hKeyBuf = new PtrArrayBuffer(8)
    const keyBuf = new PtrArrayBuffer(32)
    new Uint8Array(keyBuf).set(key)
    if (BCryptGenerateSymmetricKey(hAlg, ffi.bufferPtr(hKeyBuf), NULL, 0, keyBuf, 32, 0) !== 0) { BCryptCloseAlgorithmProvider(hAlg, 0); return null }
    const hKey = Number(new DataView(hKeyBuf).getBigUint64(0, true))
    const out = new PtrArrayBuffer(data.length)
    const cbBuf = new PtrArrayBuffer(8)
    const ivBuf = new PtrArrayBuffer(16)
    new Uint8Array(ivBuf).set(iv)
    const dataBuf = new PtrArrayBuffer(data.length)
    new Uint8Array(dataBuf).set(data)
    const ok = BCryptDecrypt(hKey, dataBuf, data.length, NULL, ivBuf, 16, out, data.length, ffi.bufferPtr(cbBuf), 0)
    BCryptDestroyKey(hKey)
    BCryptCloseAlgorithmProvider(hAlg, 0)
    if (ok !== 0) return null
    const cb = Number(new DataView(cbBuf).getBigUint64(0, true))
    return new Uint8Array(out, 0, cb)
}

// ===== CNG HMAC-SHA512（SQLCipher4 每页 HMAC 校验，检测撕裂读）=====
// BCryptCreateHash/HashData/FinishHash/DestroyHash + BcryptAlgFlag.HMAC
// 现从 quickwin 主仓 lib/windows/bcrypt.js import（见文件头部）。

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array | null {
    const hAlgBuf = new PtrArrayBuffer(8)
    if (BCryptOpenAlgorithmProvider(ffi.bufferPtr(hAlgBuf), 'SHA512', NULL, BcryptAlgFlag.HMAC) !== 0) return null
    const hAlg = Number(new DataView(hAlgBuf).getBigUint64(0, true))
    if (!hAlg) return null
    const hHashBuf = new PtrArrayBuffer(8)
    const keyBuf = new PtrArrayBuffer(key.length)
    new Uint8Array(keyBuf).set(key)
    if (BCryptCreateHash(hAlg, ffi.bufferPtr(hHashBuf), NULL, 0, keyBuf, key.length, 0) !== 0) { BCryptCloseAlgorithmProvider(hAlg, 0); return null }
    const hHash = Number(new DataView(hHashBuf).getBigUint64(0, true))
    const dataBuf = new PtrArrayBuffer(data.length)
    new Uint8Array(dataBuf).set(data)
    const hrc = BCryptHashData(hHash, dataBuf, data.length, 0)
    if (hrc !== 0) { BCryptDestroyHash(hHash); BCryptCloseAlgorithmProvider(hAlg, 0); return null }
    const out = new PtrArrayBuffer(64)
    const ok = BCryptFinishHash(hHash, out, 64, 0)
    BCryptDestroyHash(hHash)
    BCryptCloseAlgorithmProvider(hAlg, 0)
    if (ok !== 0) return null
    return new Uint8Array(out)
}

/** mac_key = PBKDF2-HMAC-SHA512(enc_key, salt^0x3a, 2)（SQLCipher4；dkLen=32，截断） */
function deriveMacKey(encKey: Uint8Array, salt: Uint8Array): Uint8Array | null {
    const macSalt = new Uint8Array(16)
    for (let i = 0; i < 16; i++) macSalt[i] = salt[i]! ^ 0x3a
    const u1in = new Uint8Array(20)
    u1in.set(macSalt, 0)
    u1in.set([0, 0, 0, 1], 16) // PBKDF2 计数器 = BE u32(1)
    const u1 = hmacSha512(encKey, u1in)
    if (!u1) return null
    const u2 = hmacSha512(encKey, u1)
    if (!u2) return null
    // T1 = U1 XOR U2（64B）；dkLen=32 → 取前 32B
    const macKey = new Uint8Array(32)
    for (let i = 0; i < 32; i++) macKey[i] = u1[i]! ^ u2[i]!
    return macKey
}

/** 校验加密源文件每页 HMAC；任何活页（0..page_count-1）不过 = 撕裂读 → 需重读。
 *  WCDB 预分配文件（page_count 可能远小于文件页数），只验活页，尾部未用页无 HMAC。 */
function verifyDbHmac(src: Uint8Array, encKey: Uint8Array, salt: Uint8Array): boolean {
    const macKey = deriveMacKey(encKey, salt)
    if (!macKey) return false
    const nPages = Math.floor(src.length / PAGE_SZ)
    if (nPages < 1 || src.length % PAGE_SZ !== 0) return false
    // page1 HMAC（决定密钥正确）
    if (!pageHmacOk(src, 0, macKey)) return false
    // 解密 page1 → SQLite 头 page_count（BE u32 @ offset 28；AES 输出偏移 28-16=12）
    const p1 = decryptAesCbc(encKey, src.subarray(16, PAGE_SZ - RESERVE_SZ), src.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + 16))
    if (!p1 || p1.length < 16) return false
    const pageCount = ((p1[12]! << 24) | (p1[13]! << 16) | (p1[14]! << 8) | p1[15]!) >>> 0
    if (pageCount === 0) return false
    const lim = Math.min(pageCount, nPages)
    for (let p = 1; p < lim; p++) {
        if (!pageHmacOk(src, p, macKey)) return false
    }
    return true
}

/** 单页 HMAC：数据 = page[s:4032]（content+IV，page1 从 16 起）+ LE(pgno) */
function pageHmacOk(src: Uint8Array, p: number, macKey: Uint8Array): boolean {
    const off = p * PAGE_SZ
    const page = src.subarray(off, off + PAGE_SZ)
    const s = p === 0 ? 16 : 0
    const hmacDataLen = 4032 - s
    const counter = p === 0 ? 1 : p + 1
    const data = new Uint8Array(hmacDataLen + 4)
    data.set(page.subarray(s, 4032), 0)
    data[hmacDataLen] = counter & 0xff
    data[hmacDataLen + 1] = (counter >> 8) & 0xff
    data[hmacDataLen + 2] = (counter >> 16) & 0xff
    data[hmacDataLen + 3] = (counter >> 24) & 0xff
    const computed = hmacSha512(macKey, data)
    if (!computed) return false
    const stored = page.subarray(PAGE_SZ - 64, PAGE_SZ)
    for (let i = 0; i < 64; i++) if (computed[i] !== stored[i]) return false
    return true
}

// ============ 文件 I/O ============
function readFile(path: string): Uint8Array | null {
    // 微信以 READ|WRITE 打开原始 DB；share mode 必须允许其写句柄共存（≥FILE_SHARE_WRITE）。
    // 先 0x3（READ|WRITE），失败回退 0x7（+DELETE）。
    let h = 0 as unknown as Ptr<'HFILE'>
    for (const share of [3, 7]) {
        const cand = CreateFile(path, 0x80000000, share, NULL, 3, 0x80, NULL)
        const c = cand as unknown as number
        if (c && c !== 0xffffffff) { h = cand; break }
    }
    if (!h) { console.log('[db] readFile open fail path=' + path + ' lasterr=' + GetLastError()); return null }
    const size = GetFileSize(h, NULL)
    if (size <= 0 || size > 0x10000000) { CloseHandle(h); return null }
    // 分块读（64KB/块）+ 校验全长：单次大 ReadFile 在 qwin FFI 可能截断（读不全→明文
    // 不完整→winsqlite3 查询越界原生崩溃）。读不全视为失败（触发 readFileStable 重读）。
    const out = new Uint8Array(size)
    let off = 0
    const CHUNK = 65536
    let complete = true
    while (off < size) {
        const n = Math.min(CHUNK, size - off)
        const buf = new PtrArrayBuffer(n)
        const readBuf = new PtrArrayBuffer(8)
        if (ReadFile(h, buf, n, readBuf, NULL) === 0) { complete = false; break }
        const got = Number(new DataView(readBuf).getBigUint64(0, true))
        if (got <= 0 || got > n) { complete = false; break }
        out.set(new Uint8Array(buf, 0, got), off)
        off += got
        if (got < n) { complete = false; break } // 提前 EOF：文件比预期小（被截断）
    }
    CloseHandle(h)
    if (!complete || off !== size) return null
    return out
}
/** 可靠写：分块 WriteFile（64KB/块）+ 校验每块实际写入字节。单次写大文件在 qwin FFI
 *  可能截断（导致明文落盘不完整→winsqlite3 查询越界原生崩溃），分块+校验规避。 */
function writeFile(path: string, data: Uint8Array): boolean {
    const h = CreateFile(path, 0x40000000, 0, NULL, 2, 0x80, NULL)
    if (!h) return false
    let total = 0
    const CHUNK = 65536
    let ok = true
    while (total < data.length) {
        const n = Math.min(CHUNK, data.length - total)
        const buf = new PtrArrayBuffer(n)
        new Uint8Array(buf).set(data.subarray(total, total + n))
        const wBuf = new PtrArrayBuffer(8)
        if (WriteFile(h, buf, n, wBuf, NULL) === 0) { ok = false; break }
        const written = Number(new DataView(wBuf).getBigUint64(0, true))
        if (written !== n) { ok = false; break }
        total += written
    }
    CloseHandle(h)
    if (!ok) return false
    return total === data.length
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}
/** 稳定读：连续两次读一致才返回（微信写库时的撕裂读会导致解密出坏页→winsqlite3 原生崩溃）。
 *  两次不一致（写-读重叠）→ 重读。最多 3 轮，仍不一致则取最后一次（best-effort）。 */
function readFileStable(path: string): Uint8Array | null {
    for (let i = 0; i < 3; i++) {
        const a = readFile(path)
        if (!a) return null
        const b = readFile(path)
        if (!b) return a
        if (bytesEqual(a, b)) return a
    }
    return readFile(path)
}

// ============ winsqlite3 ============
// SQLite API 收 UTF-8 const char*（非 UTF-16），路径/SQL 手动编 UTF-8 buffer 用 <BYTE>ptr 传。
const sqlite3_open_v2 = bind('winsqlite3.dll', 'sqlite3_open_v2', '<BYTE>ptr <>ptr u32 <>ptr -> i32')
const sqlite3_prepare_v2 = bind('winsqlite3.dll', 'sqlite3_prepare_v2', '<>ptr <BYTE>ptr i32 <>ptr <>ptr -> i32')
const sqlite3_step = bind('winsqlite3.dll', 'sqlite3_step', '<>ptr -> i32')
const sqlite3_column_type = bind('winsqlite3.dll', 'sqlite3_column_type', '<>ptr i32 -> i32')
const sqlite3_column_text = bind('winsqlite3.dll', 'sqlite3_column_text', '<>ptr i32 -> <>ptr')
const sqlite3_column_blob = bind('winsqlite3.dll', 'sqlite3_column_blob', '<>ptr i32 -> <>ptr')
const sqlite3_column_bytes = bind('winsqlite3.dll', 'sqlite3_column_bytes', '<>ptr i32 -> i32')
const sqlite3_column_int64 = bind('winsqlite3.dll', 'sqlite3_column_int64', '<>ptr i32 -> u64')
const sqlite3_finalize = bind('winsqlite3.dll', 'sqlite3_finalize', '<>ptr -> i32')
const sqlite3_close = bind('winsqlite3.dll', 'sqlite3_close', '<>ptr -> i32')
const sqlite3_errmsg = bind('winsqlite3.dll', 'sqlite3_errmsg', '<>ptr -> <>ptr')
const sqlite3_column_count = bind('winsqlite3.dll', 'sqlite3_column_count', '<>ptr -> i32')
const sqlite3_deserialize = bind('winsqlite3.dll', 'sqlite3_deserialize', '<>ptr <BYTE>ptr <BYTE>ptr u64 u64 u32 -> i32')

interface SqlDb { handle: number; path: string }
// deserialize 的明文 buffer 保活（SQLite 持指针到 close；qwin 进程短命，进程结束自动释放）
const memDbufs: unknown[] = []
// 内存 DB（deserialize）：winsqlite3.dll 内置，读解密后的明文内存，不读磁盘文件。
// 关键：dbuf 必须保活（memDbufs）——QuickJS GC 会回收未引用的 PtrArrayBuffer，
// SQLite（C 代码）持裸指针到 close，若被回收则读悬垂内存崩溃（实验确证：不保活崩、保活稳）。
// 微信明文 DB 是 SQLCipher（reserve=80）+ WAL 标记 → 强制改 bytes 18-19=1（rollback，deserialize 不支持 WAL）。
function openDbMemory(plain: Uint8Array): SqlDb | null {
    const dbBuf = new PtrArrayBuffer(8)
    const rc = sqlite3_open_v2(toUtf8(':memory:'), ffi.bufferPtr(dbBuf), 0x2 | 0x4 /* READWRITE|CREATE */, NULL)
    const db = Number(new DataView(dbBuf).getBigUint64(0, true))
    if (rc !== 0 || !db) { if (db) sqlite3_close(db); return null }
    if (plain.length < 100) { sqlite3_close(db); return null }
    const dbuf = new PtrArrayBuffer(plain.length)
    const u8 = new Uint8Array(dbuf)
    u8.set(plain)
    u8[18] = 1; u8[19] = 1  // WAL→rollback
    const pageCount = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(28, false)
    if (pageCount < 1 || pageCount * 4096 > plain.length) { sqlite3_close(db); return null }
    const drc = sqlite3_deserialize(db, toUtf8('main'), dbuf, BigInt(pageCount * 4096), BigInt(plain.length), 4 /* READONLY */)
    if (drc !== 0) { sqlite3_close(db); return null }
    memDbufs.push(dbuf)
    return { handle: db, path: ':memory:' }
}
function closeDb(db: SqlDb): void { sqlite3_close(db.handle) }
function execSql(db: SqlDb, sql: string): { rc: number; rows: (string | number | Uint8Array | null)[][] } {
    const EXEC_TRACE = false
    const rows: (string | number | Uint8Array | null)[][] = []
    const stmtBuf = new PtrArrayBuffer(8)
    const prc = sqlite3_prepare_v2(db.handle, toUtf8(sql), -1, ffi.bufferPtr(stmtBuf), NULL)
    const stmt = Number(new DataView(stmtBuf).getBigUint64(0, true))
    if (EXEC_TRACE) console.log('[exec] sql=' + sql.slice(0, 44).replace(/\n/g, ' ') + ' prc=' + prc + ' stmt=' + stmt.toString(16))
    if (prc !== 0 || !stmt) {
        if (stmt) sqlite3_finalize(stmt)
        return { rc: prc, rows }
    }
    const nCol = sqlite3_column_count(stmt)
    if (EXEC_TRACE) console.log('[exec] nCol=' + nCol)
    let rc = prc
    while (true) {
        const sr = sqlite3_step(stmt)
        if (EXEC_TRACE) console.log('[exec] step=' + sr)
        if (sr === SQLITE_ROW) {
            const row: (string | number | Uint8Array | null)[] = []
            for (let c = 0; c < nCol; c++) {
                const t = sqlite3_column_type(stmt, c)
                if (t === SQLITE_NULL) { row.push(null); continue }
                if (t === SQLITE_TEXT) { row.push(readCStr(sqlite3_column_text(stmt, c) as unknown as number)); continue }
                if (t === SQLITE_INTEGER || t === SQLITE_FLOAT) { row.push(Number(sqlite3_column_int64(stmt, c))); continue }
                // BLOB：读原始字节（zstd 压缩的 message_content 含 \0，column_text 会截断 → 必须 column_blob）
                const blob = sqlite3_column_blob(stmt, c) as unknown as number
                const n = Number(sqlite3_column_bytes(stmt, c))
                row.push(blob && n > 0 ? new Uint8Array(ffi.readBytes(blob, n)) : null)
            }
            rows.push(row)
        } else if (sr === SQLITE_DONE) { rc = 0; break }
        else { rc = sr; break }
    }
    const frc = sqlite3_finalize(stmt)
    if (EXEC_TRACE) console.log('[exec] finalize rc=' + frc)
    return { rc, rows }
}

// ============ SQLCipher4 解密 ============
const PAGE_SZ = 4096
const RESERVE_SZ = 80
function decryptDbFile(key: Uint8Array, src: Uint8Array): Uint8Array | null {
    const nPages = Math.floor(src.length / PAGE_SZ)
    if (nPages < 1 || src.length % PAGE_SZ !== 0) return null
    const out = new Uint8Array(src.length)
    for (let p = 0; p < nPages; p++) {
        const off = p * PAGE_SZ
        const page = src.subarray(off, off + PAGE_SZ)
        const iv = page.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + 16)
        if (p === 0) {
            const plain = decryptAesCbc(key, page.subarray(16, PAGE_SZ - RESERVE_SZ), iv)
            if (!plain) return null
            out.set([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00], off)
            out.set(plain, off + 16)
        } else {
            const plain = decryptAesCbc(key, page.subarray(0, PAGE_SZ - RESERVE_SZ), iv)
            if (!plain) return null
            out.set(plain, off)
        }
    }
    return out
}

// ============ 消息查询 ============
export interface DbMessage {
    direction: 'in' | 'out'
    text: string
    time: number
    sender: string
    /** 消息类型：text|image|file|voice|video|link|system|sticker|location|unknown */
    type: string
    /** 文件/图片消息的文件名（解压 XML 提取；图片可能拿不到则缺省） */
    fileName?: string
}
export interface ReadMessagesDbResult {
    ok: boolean; reason?: string; messages?: DbMessage[]; total?: number; detail?: string
}

// 会话名 → user_name：直接 user_name / filehelper / Name2Id / contact.db 显示名反查
/** 会话名 → user_name。filehelper/Name2Id 直接命中零开销（不触发 loadContact）；
 *  仅显示名反查（nick_name/remark）才懒加载 contact.db。 */
function resolveUserName(name: string, msgDb: SqlDb, loadContact: () => SqlDb | null): string | null {
    if (name === 'filehelper') return 'filehelper'
    // Name2Id 直接命中 user_name
    const n2 = execSql(msgDb, 'SELECT user_name FROM Name2Id')
    for (const r of n2.rows) if (r[0] === name) return name
    // contact.db 反查显示名（nick_name / remark）——懒加载，仅此处才解密/打开
    const contactDb = loadContact()
    if (contactDb) {
        const esc = name.replace(/'/g, "''")
        const c1 = execSql(contactDb, `SELECT user_name FROM contact WHERE nick_name='${esc}' LIMIT 1`)
        if (c1.rows.length && c1.rows[0]![0]) return c1.rows[0]![0] as string
        const c2 = execSql(contactDb, `SELECT user_name FROM contact WHERE remark='${esc}' LIMIT 1`)
        if (c2.rows.length && c2.rows[0]![0]) return c2.rows[0]![0] as string
    }
    return null
}

function isValidText(s: string): boolean {
    if (!s) return false
    if (s.length > 5000) return false
    let printable = 0
    for (const ch of s) {
        const c = ch.codePointAt(0)!
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0x7f) || c >= 0x80) printable++
    }
    return printable / s.length > 0.9
}

// ============ 消息类型 / 内容解析（社区方案：local_type + WCDB_CT zstd 解压 + XML 解析）============
/** 基础消息类型：local_type 低 32 位 = 类型；文件消息是特例大值 25769803825（微信 4.x 实测）。 */
function msgBaseType(localType: number): string {
    if (localType === 25769803825) return 'file'        // 文件消息（特殊编码，非低 32 位分解）
    const base = localType >>> 0                        // ToUint32 无符号取低 32 位（& 0xFFFFFFFF 用 ToInt32 有符号，低 32 位≥0x80000000 会变负）
    switch (base) {
        case 1: return 'text'
        case 3: return 'image'
        case 34: return 'voice'
        case 43: return 'video'
        case 47: return 'sticker'
        case 48: return 'location'
        case 49: return 'link'                          // 链接/文件/引用/小程序（解压 XML 细分）
        case 10000: return 'system'
        case 10002: return 'system'
        default: return 'unknown'
    }
}

/** UTF-8 字节 → string（zstd 解压后 / 未压缩 BLOB 的文本）。 */
function utf8Decode(u8: Uint8Array): string {
    try { return new TextDecoder().decode(u8) } catch {
        let s = ''
        let i = 0
        while (i < u8.length) {
            const b = u8[i]!
            let cp = 0, n = 1
            if (b < 0x80) { cp = b; n = 1 }
            else if ((b & 0xe0) === 0xc0) { cp = b & 0x1f; n = 2 }
            else if ((b & 0xf0) === 0xe0) { cp = b & 0x0f; n = 3 }
            else if ((b & 0xf8) === 0xf0) { cp = b & 0x07; n = 4 }
            else { i++; continue }
            let ok = true
            for (let k = 1; k < n; k++) {
                const nb = u8[i + k]
                if (nb === undefined || (nb & 0xc0) !== 0x80) { ok = false; break }
                cp = (cp << 6) | (nb & 0x3f)
            }
            if (!ok) { i++; continue }
            i += n
            if (cp >= 0x10000) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)) }
            else s += String.fromCharCode(cp)
        }
        return s
    }
}

/** zstd 解压 message_content BLOB（WCDB_CT_message_content = 4）。失败 → null。 */
function zstdInflate(u8: Uint8Array): string | null {
    try { return utf8Decode(zstdDecompress(u8)) } catch { return null }
}

/** 正则提取 XML 标签值（跨行）。 */
function xmlTag(xml: string, tag: string): string {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)
    return m ? m[1]!.trim() : ''
}

/** 解析消息内容（可能 zstd 压缩 BLOB）→ 文本 + 文件名 + appmsg 子类型。 */
function parseContent(raw: string | Uint8Array | null, ct: number): { text: string; fileName: string; subType: string } {
    let content = ''
    if (ct === 4 && raw instanceof Uint8Array) {
        const dec = zstdInflate(raw)
        if (dec === null) return { text: '', fileName: '', subType: '' }
        content = dec
    } else if (typeof raw === 'string') {
        content = raw
    } else if (raw instanceof Uint8Array) {
        content = utf8Decode(raw)
    }
    const isAppmsg = content.includes('<appmsg')
    const subType = isAppmsg ? xmlTag(content, 'type') : ''
    const fileName = isAppmsg ? xmlTag(content, 'title') : ''
    return { text: content, fileName, subType }
}

/** 读库主入口：精确方向/发送人/完整历史分页。低频调用（UIA 主路径 /messages）。
 *  带重试：微信写库时可能撕裂读（瞬态），重读新快照即恢复。 */
export function readMessagesDb(session: string, limit: number, offset: number): ReadMessagesDbResult {
    let lastErr = ''
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = readMessagesDbOnce(session, limit, offset)
            if (r.ok) return r
            // 非 ok：若为瞬态错误（read/decrypt/query 失败），重试一次；明确 404 不重试
            if (r.reason === 'session-not-found' || r.reason === 'db-dir-not-found') return r
            lastErr = r.reason ?? ''
        } catch (e) {
            lastErr = 'throw:' + String(e)
        }
    }
    return { ok: false, reason: 'internal', detail: lastErr }
}

/** 诊断：探会话消息表结构 + 最新 N 行原始值（开发/排障用）。
 *  文件、图片消息的真实内容不在 message_content 列（读回 text 为空），
 *  用此定位存放文件名/图片元数据的列。返回表列名 + 原始行。 */
export interface ProbeRow { values: (string | number | Uint8Array | null)[] }
export interface ProbeDbResult {
    ok: boolean
    reason?: string
    table?: string
    columns?: string[]
    rows?: ProbeRow[]
    tables?: string[]
    detail?: string
}
export function probeSessionDb(session: string, limit = 8): ProbeDbResult {
    try {
        const dirs = findDbDir()
        if (!dirs) return { ok: false, reason: 'db-dir-not-found' }
        const { keys } = getWeixinKeys()
        if (!keys.length) return { ok: false, reason: 'key-extract-failed' }
        const msgSrc = readFileStable(dirs.message)
        if (!msgSrc) return { ok: false, reason: 'read-msg-failed' }
        const saltHex = bytesToHex(msgSrc.subarray(0, 16))
        const cand = keys.find(c => c.salt === saltHex)
        if (!cand) return { ok: false, reason: 'no-key-for-msg' }
        const encSalt = cand.salt ? hexToBytes(cand.salt) : msgSrc.subarray(0, 16)
        if (!verifyDbHmac(msgSrc, hexToBytes(cand.key), encSalt)) return { ok: false, reason: 'hmac-fail' }
        const msgPlain = decryptDbFile(hexToBytes(cand.key), msgSrc)
        if (!msgPlain) return { ok: false, reason: 'decrypt-msg-failed' }
        const msgDb = openDbMemory(msgPlain)
        if (!msgDb) return { ok: false, reason: 'open-msg-failed' }
        let contactDb: SqlDb | null = null
        let contactLoaded = false
        const loadContact = (): SqlDb | null => {
            if (contactLoaded) return contactDb
            contactLoaded = true
            try {
                const cSrc = readFileStable(dirs.contact)
                if (!cSrc) return null
                const cKey = keys.find(c => c.salt === bytesToHex(cSrc.subarray(0, 16)))
                if (!cKey) return null
                const cEncKey = hexToBytes(cKey.key)
                const cEncSalt = cKey.salt ? hexToBytes(cKey.salt) : cSrc.subarray(0, 16)
                if (!verifyDbHmac(cSrc, cEncKey, cEncSalt)) return null
                const cPlain = decryptDbFile(cEncKey, cSrc)
                if (!cPlain) return null
                contactDb = openDbMemory(cPlain)
                return contactDb
            } catch (e) { contactDb = null; return null }
        }
        try {
            const userName = resolveUserName(session, msgDb, loadContact)
            if (!userName) return { ok: false, reason: 'session-not-found' }
            const table = 'Msg_' + md5Hex(userName)
            const tblCheck = execSql(msgDb, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}'`)
            if (!tblCheck.rows.length || Number(tblCheck.rows[0]![0]) === 0) return { ok: false, reason: 'session-not-found' }
            const cols = execSql(msgDb, `PRAGMA table_info("${table}")`).rows.map(r => String(r[1]))
            const lim = Math.max(1, Math.min(limit, 50))
            const rows = execSql(msgDb, `SELECT * FROM "${table}" ORDER BY create_time DESC, local_id DESC LIMIT ${lim}`).rows
            const tables = execSql(msgDb, "SELECT name FROM sqlite_master WHERE type='table'").rows.map(r => String(r[0]))
            return { ok: true, table, columns: cols, rows: rows.map(r => ({ values: r })), tables }
        } finally {
            if (contactDb) closeDb(contactDb)
        }
    } catch (e) {
        return { ok: false, reason: 'throw', detail: String(e) }
    }
}

/** 当前登录账号 wxid（权威）：数据目录名 <wxid>_<suffix>（如 wxid_xxx_dff7），
 *  微信账号数据目录的 wxid 即登录账号，比 Name2Id.is_session=0（可能多行/多个 self 身份）可靠。
 *  提取失败（路径异常）返回 ''，调用方兜底 Name2Id。 */
function selfWxidFromPath(dbPath: string): string {
    const m = /xwechat_files[\\/]([^\\/]+)[\\/]/.exec(dbPath)
    if (!m) return ''
    const dir = m[1]!
    const i = dir.lastIndexOf('_')   // 后缀分隔：wxid_xxx_dff7 → 截 _dff7
    const prefix = i > 0 ? dir.slice(0, i) : dir
    return /^wxid_/i.test(prefix) ? prefix : ''
}

function readMessagesDbOnce(session: string, limit: number, offset: number): ReadMessagesDbResult {
    const TRACE = false
    const t = (m: string) => { if (TRACE) console.log('[trace] ' + m) }
    const dirs = findDbDir()
    t('findDbDir=' + (dirs ? 'ok ' + dirs.message : 'null'))
    if (!dirs) return { ok: false, reason: 'db-dir-not-found' }
    const { pid, keys } = getWeixinKeys()
    t('keys pid=' + pid + ' count=' + keys.length)
    if (!keys.length) return { ok: false, reason: 'key-extract-failed' }

    // 解密 message_0.db（稳定读：防微信写库时的撕裂读）
    const msgSrc = readFileStable(dirs.message)
    t('readMsg=' + (msgSrc ? msgSrc.length : 'null'))
    if (!msgSrc) return { ok: false, reason: 'read-msg-failed' }
    const saltHex = bytesToHex(msgSrc.subarray(0, 16))
    const cand = keys.find(c => c.salt === saltHex)
    t('saltMatch=' + (cand ? 'yes' : 'no'))
    if (!cand) return { ok: false, reason: 'no-key-for-msg' }
    // 每页 HMAC 校验（SQLCipher4）：检测微信写库时的撕裂读，坏页则重读
    const encKey = hexToBytes(cand.key)
    const encSalt = cand.salt ? hexToBytes(cand.salt) : msgSrc.subarray(0, 16)
    if (!verifyDbHmac(msgSrc, encKey, encSalt)) {
        t('hmac=FAIL')
        return { ok: false, reason: 'torn-read' }
    }
    t('hmac=ok')
    const msgPlain = decryptDbFile(hexToBytes(cand.key), msgSrc)
    t('decrypt=' + (msgPlain ? msgPlain.length : 'null'))
    if (!msgPlain) return { ok: false, reason: 'decrypt-msg-failed' }
    const msgDb = openDbMemory(msgPlain)
    t('openMsg=' + (msgDb ? 'ok' : 'null'))
    if (!msgDb) return { ok: false, reason: 'open-msg-failed' }
    try {
        // 会话名 → user_name（显示名反查才懒加载 contact.db；filehelper/Name2Id 命中零开销）
        let contactDb: SqlDb | null = null
        let contactLoaded = false
        const loadContact = (): SqlDb | null => {
            if (contactLoaded) return contactDb
            contactLoaded = true
            try {
                t('contact: read start')
                const cSrc = readFileStable(dirs.contact)
                t('contact: read=' + (cSrc ? cSrc.length : 'null'))
                if (!cSrc) return null
                const cKey = keys.find(c => c.salt === bytesToHex(cSrc.subarray(0, 16)))
                t('contact: keyMatch=' + (cKey ? 'yes' : 'no'))
                if (!cKey) return null
                const cEncKey = hexToBytes(cKey.key)
                const cEncSalt = cKey.salt ? hexToBytes(cKey.salt) : cSrc.subarray(0, 16)
                if (!verifyDbHmac(cSrc, cEncKey, cEncSalt)) { t('contact: hmac=FAIL'); return null }
                const cPlain = decryptDbFile(cEncKey, cSrc)
                t('contact: decrypt=' + (cPlain ? cPlain.length : 'null'))
                if (!cPlain) return null
                contactDb = openDbMemory(cPlain)
                t('contact: openDb=' + (contactDb ? 'ok' : 'null'))
                return contactDb
            } catch (e) { t('contact: catch=' + String(e)); contactDb = null; return null }
        }
        try {
            const userName = resolveUserName(session, msgDb, loadContact)
            t('resolve="' + session + '"->' + userName)
            if (!userName) return { ok: false, reason: 'session-not-found' }

            // Name2Id：rowid→user_name，self = 数据目录 wxid（权威，可能多个 is_session=0 身份），兜底 is_session=0
            const nameMap = new Map<number, string>()
            let selfWxid = selfWxidFromPath(dirs.message)
            for (const r of execSql(msgDb, 'SELECT rowid, user_name, is_session FROM Name2Id').rows) {
                const rowid = Number(r[0]); const uname = String(r[1]); const isSess = Number(r[2])
                nameMap.set(rowid, uname)
                if (!selfWxid && isSess === 0) selfWxid = uname
            }
            t('query: nameMap=' + nameMap.size + ' self=' + selfWxid)

            // probe：定位崩溃点（诊断）
            try { const p = execSql(msgDb, 'SELECT 1'); t('probe: sel1=' + p.rows.length + ' rc=' + p.rc) } catch (e) { t('probe: sel1 THROW ' + e) }
            try { const p = execSql(msgDb, 'PRAGMA page_count'); t('probe: pagecount=' + JSON.stringify(p.rows)) } catch (e) { t('probe: pagecount THROW ' + e) }
            try { const p = execSql(msgDb, "SELECT name FROM sqlite_master WHERE type='table'"); t('probe: tables=' + p.rows.length) } catch (e) { t('probe: tables THROW ' + e) }
            try { const p = execSql(msgDb, 'SELECT COUNT(*) FROM sqlite_master'); t('probe: count_master=' + JSON.stringify(p.rows)) } catch (e) { t('probe: count_master THROW ' + e) }
            try { const p = execSql(msgDb, 'PRAGMA quick_check'); t('probe: quick_check=' + JSON.stringify(p.rows)) } catch (e) { t('probe: quick_check THROW ' + e) }

            const table = 'Msg_' + md5Hex(userName)
            const tblCheck = execSql(msgDb, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}'`)
            t('query: tblCheck rows=' + tblCheck.rows.length)
            if (!tblCheck.rows.length || Number(tblCheck.rows[0]![0]) === 0) {
                return { ok: false, reason: 'session-not-found' }
            }
            const lim = Math.max(1, Math.min(limit, 200))
            const off = Math.max(0, offset)
            // 先取数据页（COUNT 全表扫描可能撞坏页，数据查询优先）
            const q = execSql(msgDb,
                `SELECT create_time, real_sender_id, message_content, local_type, WCDB_CT_message_content FROM "${table}" ORDER BY create_time DESC, local_id DESC LIMIT ${lim} OFFSET ${off}`)
            t('query: rows=' + q.rows.length)
            const messages: DbMessage[] = []
            for (const r of q.rows) {
                const time = Number(r[0] ?? 0)
                const senderId = Number(r[1] ?? 0)
                const rawContent = r[2] as string | Uint8Array | null
                const localType = Number(r[3] ?? 0)
                const ct = Number(r[4] ?? 0)
                // 类型 + 内容解析（zstd 解压 + XML）
                let type = msgBaseType(localType)
                const { text, fileName, subType } = parseContent(rawContent, ct)
                if (type === 'link') {
                    // type 49 家族：XML <type> 子类型（4/6=文件、57=引用、5=链接）
                    if (subType === '4' || subType === '6') type = 'file'
                    else if (subType === '57') type = 'quote'
                    else type = 'link'
                }
                // 文本消息要求可读文本；媒体消息类型标记（文件/图片/视频等即使无文本也返回）
                const displayText = (type === 'text' || type === 'system' || type === 'link' || type === 'quote')
                    ? text : ''
                if ((type === 'text' || type === 'system') && !isValidText(displayText)) continue
                if (type === 'unknown' && !isValidText(text)) continue
                const senderUser = nameMap.get(senderId) ?? ''
                const direction: 'in' | 'out' = (senderUser && selfWxid && senderUser === selfWxid) ? 'out' : 'in'
                const msg: DbMessage = { direction, text: displayText, time, sender: senderUser, type }
                if (fileName) msg.fileName = fileName
                messages.push(msg)
            }
            messages.reverse()
            // COUNT 全表扫描（best-effort；撞坏页则返回 -1，不阻塞数据）
            let total = -1
            try {
                const totalR = execSql(msgDb, `SELECT COUNT(*) FROM "${table}"`)
                total = totalR.rows.length ? Number(totalR.rows[0]![0]) : 0
            } catch { total = -1 }
            t('query: messages=' + messages.length + ' total=' + total)
            return { ok: true, messages, total }
        } finally {
            if (contactDb) closeDb(contactDb)
        }
    } finally {
        closeDb(msgDb)
    }
}
