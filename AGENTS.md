# WeChat Assistant Agents

## 关键限制（必须遵守）

> **禁止给真实用户发消息。测试只能用「文件传输助手」；唯一例外：联系人「谢」经用户授权可发。**

- `/send` 的**测试验证**默认目标 = `文件传输助手`（给自己发，安全，不打扰任何人）。
- **允许**给联系人 `谢` 发送（用户明确授权，属受控测试目标）。
- **禁止**用 `渐远还生`、`安静` 或任何其他真实联系人/群作为发送测试目标——即使 UIA 打开会话成功也不允许发。
- 测试验证发送成功的判据：目标会话预览更新为所发消息。
- 实现层面 `/send` 支持任意 `session`（代码不限），但**验证路径只走文件传输助手 / 谢**。

## 开发约定

- 构建、测试、VM 服务访问在容器 `quickwin-dev` 内执行（宿主无交叉工具链）。
- 宿主命令一律 `./docker/qc <命令>`（= `podman exec -w /workspace`，命令 argv 直传、不起 shell）。
- 启动 GUI 程序用 execd `/spawn`（后台不阻塞；`start` 会超时）。
- 微信操作后台化：`@quickwinlabs/uia` 的 `click()`（PostMessage 后台点击，不移动光标/不抢焦点）。
- 微信窗口定位：`FindWindow(NULL, '微信')`（按标题；UIA className `mmui::MainWindow` ≠ Win32 窗口类名）。
- 禁止自动提交：先展示 `git diff` + 拟用 commit message，经用户同意才 `git add`/`commit`/`push`。
- GitHub push 需用户明确指示（`xna00/wechat-assistant` 已建未推，暂缓）。

## 实测已知（微信 4.2.0，win11）

- 微信 4.x 自绘 UI：UIA 枚举/属性/Invoke/Value/SelectionItem 可用，但 **ScrollPattern 不可用**（GetCurrentPattern 返回 S_OK 但空指针）。
- 通讯录滚动：`WM_MOUSEWHEEL` 是唯一可靠滚动通道（Home/End 键无效、大 delta 有 clamp）。
- 会话 cell = `ChatSessionCell`（name 首行 = 会话名）；联系人 cell = `ContactsCellItemView`；通讯录容器 = `ContactsTableBaseView`。
- 搜索框 = `mmui::XValidatorTextEdit`（name="搜索"）。**`setValue` 必须先点击聚焦**，否则静默无效（旧搜索从未真正生效，属假成功）。
- 搜索结果在**弹出层**：`SearchContentPopover` → `XTableCell`（高 ≥48px 是聊天结果、含头像；32-34px 是「网络结果」行，点它不开会话，须按高度过滤）。
- 搜索弹出层是**独立顶层窗口**（类名 `Qt51514QWindowToolSaveBits`，title="Weixin"）。PostMessage 必须发给**它**；发给主窗会被当成"点外部"关掉弹出层。选中聊天结果后弹出层自动关闭、搜索框自动清空。
- **Esc 危险**：向微信主窗发裸 Esc 会把窗口隐藏到托盘，UIA 树只剩根节点、窗口全白；恢复须 `ShowWindow(HIDE)` 再真实点击托盘图标（约屏幕 (1110,778)）。绝不用 Esc 清理搜索态，改用 setValue('') + 点聊天输入框（主窗上的点击让 Qt 关闭弹出层）。
- 发消息：`ChatInputField.setValue` + 发送按钮 `click()`。发送按钮按**相对输入框**判据定位（name="发送" 唯一，位于输入框右半、下缘/下方），不用绝对坐标（窗口移动/缩放/多屏会失效）。
- 发送校验：发送后 `ChatInputField.value()` 应被清空（`value()` 可靠反映 setValue/清空）；未清空即未发出 → `/send` 失败。
- `/send` 语义：找不到会话 → **404** `session not found`；UI 操作失败 → 500 `send failed`。
- 微信当前页面会被切换：`/contacts` 切到通讯录页、`/send` 切到目标会话（必然副作用，API 文档已注明）。
