// live 版入口：只拉主模块，rolldown 据此拆 hash chunk
await import('./main.tsx')
export {}   // 让 tsc 视为模块（顶层 await 才合法）
