/// <reference types="node" />
// 构建链：tsc 类型检查 → rolldown 打包（完整版单文件 / live 版 code splitting）→ 图标 → brotli 内嵌
// 内嵌格式：[exe][brotli(js)][u32 长度]["QWBR"]
// 用法：node build.ts [--base=x64]，默认 x86-nowasm
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'
import { rolldown } from 'rolldown'
import { setIcon } from './icon.ts'         // Node 类型剥离直接跑 .ts，故带扩展名

const BASES = {
    'x64': 'qwin.exe',                      // x64 全功能
    'x64-nowasm': 'qwin-nowasm.exe',        // x64、体积次小（Vista+）
    'x86': 'qwin-x86.exe',                  // 32 位 + WebAssembly
    'x86-nowasm': 'qwin-nowasm-x86.exe',    // 32 位、体积最小、XP 可跑，只缺 WebAssembly.*（默认）
} as const
const DEFAULT_BASE = 'x86-nowasm'
const ENTRY = 'src/main.tsx'
const ENTRY_LIVE = 'src/entry.ts'     // live 版入口：只 import(main.tsx)，rolldown 据此拆 chunk
const OUT_JS = 'dist/app.js'
const OUT_EXE = 'dist/app.exe'
const OUT_LIVE = 'dist-live'
const OUT_LIVE_EXE = `${OUT_LIVE}/wechat-assistant-live.exe`
const LIVE_BASE = 'https://xna00.github.io/wechat-assistant'
const ICON_SVG = 'assets/icon.svg'

// 内置模块由 exe 运行时提供，不打包；NODE_ENV 决定 react 用生产版
const EXTERNALS = ['gui', 'std', 'os', 'sock', 'ffi', 'wolfssl', 'brotli']
const TRANSFORM = {
    jsx: 'react-jsx',        // 自动运行时
    define: { 'process.env.NODE_ENV': '"production"', DEBUG: 'false' },
}

const argv = process.argv.slice(2)
let base = DEFAULT_BASE
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') base = argv[++i]
    else if (a.startsWith('--base=')) base = a.slice('--base='.length)
    else {
        console.error(`unknown argument: ${a}`)
        process.exit(1)
    }
}
const exeName = BASES[base as keyof typeof BASES]
if (!exeName) {
    console.error(`unknown base "${base}"; valid: ${Object.keys(BASES).join(' | ')}`)
    process.exit(1)
}
const exeSrc = `node_modules/quickwin/${exeName}`
if (!existsSync(exeSrc)) {
    console.error(`${exeSrc} not found — run npm install first`)
    process.exit(1)
}

// ── stage 1: 完整版（单文件，动态 import 全内联）──
console.log(`[1/3] rolldown (base=${base} -> ${exeName})`)
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })
{
    const bundle = await rolldown({ input: ENTRY, external: EXTERNALS, platform: 'browser', transform: TRANSFORM })
    await bundle.write({
        file: OUT_JS,
        format: 'es',
        codeSplitting: false,   // 单文件全内嵌：动态 import 内联成一份
    })
}
const jsBytes = readFileSync(OUT_JS)

// ── stage 2: 盖图标 ──
let exe: Buffer = readFileSync(exeSrc)
if (existsSync(ICON_SVG)) {
    const plainLen = exe.length
    exe = setIcon(exe, ICON_SVG)
    console.log(`[2/3] icon ${ICON_SVG} (+${exe.length - plainLen}B)`)
} else {
    console.log(`[2/3] icon skipped (${ICON_SVG} 不存在)`)
}
// 盖完图标、未嵌 bundle 的纯净底座：live 版 exe 用它
const baseExe = Buffer.from(exe)

// ── stage 3: brotli 压缩 + 内嵌 ──
const packed = brotliCompressSync(jsBytes)
const out = Buffer.alloc(exe.length + packed.length + 8)
exe.copy(out, 0)
packed.copy(out, exe.length)
out.writeUInt32LE(packed.length, exe.length + packed.length)
out.write('QWBR', exe.length + packed.length + 4, 'ascii')
writeFileSync(OUT_EXE, out)
console.log(`[3/3] ${OUT_EXE}: ${exeName} ${exe.length}B + js ${jsBytes.length}B ` +
    `-> brotli ${packed.length}B -> ${out.length}B`)

// ── stage 4: live 版（entry.js + hash chunk；exe 只内嵌远程 loader）──
// exe 内 loader 每次带新时间戳拉 entry.js（绕过磁盘缓存拿最新）；chunk 用内容 hash 命名，
// 命中磁盘缓存复用。codeSplitting.groups 把 node_modules 聚成 react-vendor / vendor 稳定 chunk，
// 业务小 chunk 单独更新，库不变则 hash 不变。
console.log('[4/4] live ...')
rmSync(OUT_LIVE, { recursive: true, force: true })
mkdirSync(OUT_LIVE, { recursive: true })
{
    const bundle = await rolldown({ input: ENTRY_LIVE, external: EXTERNALS, platform: 'browser', transform: TRANSFORM })
    await bundle.write({
        dir: OUT_LIVE,
        format: 'es',
        entryFileNames: 'entry.js',        // 入口固定名（loader 每次带新 ts 拉它）
        chunkFileNames: 'chunk-[name]-[hash].js',
        codeSplitting: {
            groups: [
                { name: 'react-vendor', test: /node_modules[\\/]react[\\/]/, priority: 20 },
                { name: 'vendor', test: /node_modules/, priority: 10 },
            ],
        },
    })
}
const liveJs = readdirSync(OUT_LIVE).filter(f => f.endsWith('.js'))
console.log(`  live js: ${liveJs.join(', ')}`)

const loaderSrc =
    `const BASE = ${JSON.stringify(LIVE_BASE)}\n` +
    `try { await import(BASE + '/entry.js?ts=' + Date.now()) }\n` +
    `catch (e) { console.log('live entry load failed:', e) }\n`
const loaderPacked = brotliCompressSync(Buffer.from(loaderSrc, 'utf8'))
const liveOut = Buffer.alloc(baseExe.length + loaderPacked.length + 8)
baseExe.copy(liveOut, 0)
loaderPacked.copy(liveOut, baseExe.length)
liveOut.writeUInt32LE(loaderPacked.length, baseExe.length + loaderPacked.length)
liveOut.write('QWBR', baseExe.length + loaderPacked.length + 4, 'ascii')
writeFileSync(OUT_LIVE_EXE, liveOut)
console.log(`  ${OUT_LIVE_EXE}: base ${baseExe.length}B + loader ${loaderPacked.length}B (brotli) -> ${liveOut.length}B`)
