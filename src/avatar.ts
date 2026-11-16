// 微信头像抓取：PrintWindow 后台截整窗（不抢焦点、可截被遮挡窗口）+ 裁剪 cell 左侧 44x44。
// 复刻主仓 execd captureWindow 的 GDI 逻辑（PrintWindow → 24bpp 顶向下 BMP），独立于 execd。
import { GetDC, GetWindowRect, PrintWindow, ReleaseDC } from 'quickwin/lib/windows/user32.js'
import { CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject } from 'quickwin/lib/windows/gdi32.js'
import { BITMAPFILEHEADER, BITMAPINFOHEADER, RECT } from 'quickwin/lib/windows/structs.js'
import { NULL, PtrArrayBuffer, type MaybePtr, type Ptr } from 'quickwin/lib/ffi/ctype.js'
import { ColorUse } from 'quickwin/constants'

const BMP_HDR = BITMAPFILEHEADER.size + BITMAPINFOHEADER.size

/** BMP 行填充：每行 (w*3+3) 取整到 4 的倍数 */
function biStride(w: number): number {
    return (w * 3 + 3) & ~3
}

/** 24bpp 顶向下 BMP 头（文件头 + 信息头，共 BMP_HDR 字节） */
function bmpHeader(pxBytes: number, w: number, h: number): Uint8Array {
    const fileHdr = BITMAPFILEHEADER.encode({
        bfType: 0x4d42,                          // 'BM'
        bfSize: BMP_HDR + pxBytes,
        bfOffBits: BMP_HDR,
    })
    const infoHdr = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: w,
        biHeight: -h,                            // 负 = 顶向下
        biPlanes: 1,
        biBitCount: 24,                          // 无 alpha（剥掉，避免消费方渲染成透明）
        biCompression: 0,                        // BI_RGB
        biSizeImage: biStride(w) * h,
        biXPelsPerMeter: 2835,                   // 72dpi
        biYPelsPerMeter: 2835,
    })
    const out = new Uint8Array(BMP_HDR)
    out.set(new Uint8Array(fileHdr), 0)
    out.set(new Uint8Array(infoHdr), BITMAPFILEHEADER.size)
    return out
}

/** 取 hdc 当前选中位图的全部像素，拼成完整 BMP。GetDIBits 短读返回 null。 */
function emitDib(hdc: Ptr<'HDC'>, hbm: Ptr<'HGDIOBJ'>, w: number, h: number): Uint8Array | null {
    const row = biStride(w)
    const pxBytes = row * h
    const pxB = new PtrArrayBuffer(pxBytes)
    const px = new Uint8Array(pxB)
    const bmi = BITMAPINFOHEADER.encode({
        biSize: BITMAPINFOHEADER.size,
        biWidth: w,
        biHeight: -h,           // 负 = 顶向下
        biPlanes: 1,
        biBitCount: 24,         // GDI 把 32bpp 位图转成 24bpp（剥 alpha）
        biSizeImage: pxBytes,
    })
    const got = GetDIBits(hdc, hbm, 0, h, pxB, bmi.ptr, ColorUse.RGB_COLORS)
    if (got !== h) return null
    const out = new Uint8Array(BMP_HDR + pxBytes)
    out.set(bmpHeader(pxBytes, w, h), 0)
    out.set(px, BMP_HDR)
    return out
}

/** 截整窗（PrintWindow 后台，nFlags=0）。返回 24bpp 顶向下 BMP + 尺寸；失败 → null。 */
export function captureWindow(hwnd: MaybePtr<'HWND'>): { bmp: Uint8Array; width: number; height: number } | null {
    const wr = RECT.alloc()
    if (!GetWindowRect(hwnd, wr.ptr)) return null
    const r = RECT.decode(wr)
    const frameW = r.right - r.left
    const frameH = r.bottom - r.top
    if (!(frameW > 0 && frameH > 0)) return null

    const hdcScreen = GetDC(NULL)
    if (!hdcScreen) return null
    try {
        const hdc = CreateCompatibleDC(hdcScreen)
        const hbm = hdc ? CreateCompatibleBitmap(hdcScreen, frameW, frameH) : 0
        if (!hdc || !hbm) {
            if (hdc) DeleteDC(hdc)
            return null
        }
        const old = SelectObject(hdc, hbm)
        // PrintWindow 从 (0,0) 填整张位图，必须给整窗尺寸；nFlags=0（XP/Win7 无 PW_* 语义）
        const printed = PrintWindow(hwnd, hdc, 0) !== 0
        const out = printed ? emitDib(hdc, hbm, frameW, frameH) : null
        SelectObject(hdc, old)
        DeleteObject(hbm)
        DeleteDC(hdc)
        return out ? { bmp: out, width: frameW, height: frameH } : null
    } finally {
        ReleaseDC(NULL, hdcScreen)
    }
}

/** 从整窗 BMP 裁剪 [x,y,w,h]（窗口内坐标，顶向下）→ 新 BMP 字节 */
export function cropBmp(src: Uint8Array, frameW: number, x: number, y: number, w: number, h: number): Uint8Array {
    const srcStride = biStride(frameW)
    const dstStride = biStride(w)
    const px = src.subarray(BMP_HDR)                       // 整窗像素区
    const outPx = new Uint8Array(dstStride * h)
    for (let row = 0; row < h; row++) {
        const s = srcStride * (y + row) + x * 3
        outPx.set(px.subarray(s, s + w * 3), dstStride * row)
    }
    const out = new Uint8Array(BMP_HDR + dstStride * h)
    out.set(bmpHeader(dstStride * h, w, h), 0)
    out.set(outPx, BMP_HDR)
    return out
}

/** BMP 字节 → base64 字符串（内嵌 JSON 用） */
export function bmpToBase64(bmp: Uint8Array): string {
    let s = ''
    for (let i = 0; i < bmp.length; i += 0x8000) {
        s += String.fromCharCode(...bmp.subarray(i, i + 0x8000))
    }
    return btoa(s)
}
