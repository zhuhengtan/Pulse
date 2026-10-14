# Browser use 与 computer use

Pulse 提供受管理的 `browser`、`computer` 能力。网页结构操作可以使用文本模型；桌面与浏览器截图操作使用单独配置的视觉模型。所有操作发生在运行 Pulse 的主机，手机 H5 不会控制手机操作系统。

## 启用

在用户级配置中合并以下字段，保留已有 providers 和模型配置：

```json
{
  "capabilities": {
    "enabled": ["browser", "computer"],
    "browser": { "channel": "chrome", "mode": "dedicated" },
    "computer": {}
  },
  "taskRouting": { "vision": ["your-provider/your-vision-model"] },
  "allowNetwork": true,
  "networkHosts": ["example.com"],
  "approvalMode": "ask"
}
```

视觉模型必须已经存在于 `providers.<providerId>.models.<modelId>`，并将该模型的 `imageInput` 设置为 `supported`。未知模型不会被默认当作视觉模型。H5 的“设置 → 模型与服务商”可检测已保存模型的图片输入协议；通过后保存草稿，再在“模型路由 → 视觉执行”选择它。检测成功说明服务接受图片请求，不代表真实桌面任务已验收。

```sh
pulse automation doctor
pulse automation doctor --live --model your-provider/your-vision-model
```

`--live` 会向所选服务发送一张合成测试图片，不发送桌面截图。普通 doctor 只检查本地依赖和权限，不触发系统授权弹窗。工作区 `.pulse/config.json` 不能开启宿主自动化、加载 Helper 或授予设备权限。

已有 `capabilities.mcpServers.browser` / `computer` 保持原来的 MCP 行为。与同名受管理配置同时出现时会拒绝配置，避免静默改变工具来源。

## 浏览器

- `dedicated` 使用 Pulse 自己的持久配置目录，保留该环境的登录状态。默认使用 Chromium，也可以选已安装的 Chrome 或 Edge。Chromium 二进制需通过对应 Playwright 版本安装，Chrome/Edge 使用系统安装。
- `existing` 通过 Playwright 官方扩展连接现有 Chrome/Edge，需要安装扩展并在浏览器中确认目标。不会复制日常浏览器配置，也不会在断开时关闭用户浏览器。
- 页面结构观察默认不发送图片；模型可请求 `browser.observe` 的 `includeImage: true` 切换到视觉路由。
- 上传只能选择工作区内文件；下载写入 `.pulse/automation-downloads`，最近的浏览器截图写入 `.pulse/automation-observations/latest.png`。这两个目录属于运行产物，不应提交到版本控制。
- `networkHosts` 校验导航和操作目标。浏览器仍运行在主机上；该目标检查不构成子资源、重定向、扩展或已存在浏览器的完整网络沙箱。

工具包括 `automation.open/status/close`、`browser.tabs/selectTab/navigate/observe/act/upload/downloads`。动作使用观察返回的 `frameId`，坐标是截图内的 0–1 比例值。页面或几何信息变化后必须重新观察。首版不暴露任意网页 JavaScript 执行接口。

## 桌面与系统权限

源码开发环境先构建原生组件：

```sh
pnpm desktop:build
pulse automation doctor
pulse automation permissions
```

构建需要 Rust；macOS 同时需要 Xcode Command Line Tools 的 Swift 编译器。发行安装包应包含对应 `platform-arch` Helper 和校验清单，终端用户不需要 Rust。可用 `capabilities.computer.helperPath` 显式选择本机可信 Helper。

macOS 权限窗口应显示 **Pulse Desktop Helper**，应用标识为 `com.hunterzhu.pulse.desktop`。若显示终端或 IDE 名称，应检查是否使用了旧版直接启动的 Helper，不要把宿主授权当作 Pulse 授权。正式发行可用 `PULSE_MACOS_SIGN_IDENTITY` 提供 Developer ID 签名；源码默认 ad-hoc 签名，重新编译或移动应用后可能需要重新授权。当前构建不等于已完成 Apple 公证。

若屏幕录制没有弹出申请，不能据此认为已授权。`pulse automation permissions` 会返回真实状态、应用路径和手动授权指引：在系统设置 → 隐私与安全性 → 录屏与系统录音中点“＋”添加 `Pulse Desktop Helper.app` 并开启开关。辅助功能权限需单独确认。系统拒绝弹窗时不修改 TCC 数据库或自动重置其他应用权限。

| 平台 | 实现与必要条件 |
| --- | --- |
| macOS 14+ | ScreenCaptureKit、Accessibility、CoreGraphics；独立 `Pulse Desktop Helper.app` 经 Launch Services 启动，权限授予 Pulse Desktop Helper。未授权时返回明确错误。 |
| Windows 11 x64 | UI Automation、屏幕捕获和 SendInput；必须处于交互桌面。不自动提权，UAC 安全桌面及 UIPI 阻止的窗口不受支持。 |
| Linux X11 | AT-SPI、GDK、X11/XTest；需要有效 DISPLAY 和图形桌面。 |
| Linux Wayland | GNOME/KDE 的 RemoteDesktop、ScreenCast portal 与 PipeWire；首次连接需要本机用户在系统选择器中授权显示器和输入设备。 |

Ubuntu 系列依赖示例：

```sh
sudo apt-get install python3-gi python3-dbus gir1.2-atspi-2.0 gir1.2-gtk-3.0 \
  gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good libxtst6
```

其他 Linux 桌面缺少 portal 或可访问性接口时会报告不可用，不以 root 或桌面扩展绕过。窗口枚举和聚焦取决于系统接口；Wayland 只能报告可见的可访问性窗口及已授权显示器。Linux X11 的无可访问性文本控件若没有对应 Unicode 键映射，会报告不支持，不能据此宣称所有应用均支持中文输入。

## 暂停与接管

CLI：

```text
/automation status
/automation doctor
/automation pause <sessionId>
/automation takeover <sessionId>
/automation resume <sessionId>
/automation stop <sessionId>
```

接管后在本机直接操作，完成后交还 AI。`stop` 直接操作会话管理器，不依赖模型回复。CLI 状态会给出当前截图路径。

H5：进入工作模式，在“工作区 → 自动化”中检查主机能力或选择会话。本机管理员可点击“申请系统权限”触发 macOS 授权；远程配对设备不能触发该操作。接管后可以在截图上点击、拖拽、滚动，发送文本或快捷键；浏览器还支持输入网址。截图画面实际加载后才允许基于它发送动作。首版通过截图刷新提供交互，不提供视频流。

本机管理员可以在自动化面板内开启配对设备的控制权限。旧设备默认关闭；未授权设备不能查看会话详情或截图，也不能输入。撤权立即阻止新请求并关闭状态连接。接管会暂停其他会话的 AI 输入；其他会话需要显式恢复。人工控制权通过租约互斥，断线或租约失效后保持暂停，不自动交还 AI。

`read-only` 禁止界面变更；`ask` 继续使用已有 AI 工具审批；`auto` 在配置范围内执行。人工接管界面的输入属于用户直接操作，不另弹逐点击审批。

## 持久化与故障

- 会话元数据和动作回执保存在数据目录 `automation/sessions`；动作执行前先记录 `unknown`，完成后记录 `applied`，不保存手动文本内容。
- 同一桌面和同一浏览器 profile 跨进程互斥。H5 worker 通过父 Host 的鉴权本地 socket/命名管道访问会话。
- 重启后会话处于暂停或未知状态，需要显式重新连接及观察。已应用或结果未知的同一请求不会重复执行。
- 每阶段最多 200 个动作；连续三次观察未显示进展时暂停。仍同时受原任务模型和时间预算约束。
- 模型图片通过 ArtifactRef 参与可见性及隐私检查；持久请求和文字摘要保留引用，Provider 调用前才读取图片字节。最近两张图片进入视觉上下文。

## 验证

```sh
pnpm ci:local
pnpm exec tsc -b --pretty false
pnpm --filter @hunterzhu/pulse-web check
node scripts/ci/test.mjs
PULSE_BROWSER_LIVE=1 pnpm exec vitest run tests/live/automation-browser.test.ts
PULSE_BROWSER_LIVE=1 PULSE_BROWSER_CHANNEL=chromium pnpm exec vitest run tests/live/automation-browser.test.ts
PULSE_H5_AUTOMATION_LIVE=1 pnpm exec vitest run tests/live/automation-h5-ui.test.ts
PULSE_VISION_LIVE=1 pnpm exec vitest run tests/live/automation-vision.test.ts
# 官方扩展解包目录；只加载到临时 Chromium profile：
PULSE_EXTENSION_LIVE=1 PULSE_EXTENSION_PATH=/path/to/official-extension pnpm exec vitest run tests/live/automation-extension.test.ts
PULSE_DESKTOP_DOCTOR_LIVE=1 pnpm exec vitest run tests/live/automation-desktop.test.ts
# macOS 两项权限已授权后，操作专用临时测试窗口：
PULSE_DESKTOP_LIVE=1 pnpm exec vitest run tests/live/automation-desktop.test.ts
```

2026-10-14 补充验收记录见 [机器可读报告](evidence/browser-computer-use-2026-10-14.json)。本轮实测修复了 Ollama 根地址缺少 `/v1`、专用浏览器退出时 Cookie 未落盘，以及 Chromium 配置落到 MCP 默认 Chrome 的问题；用户配置和已授权 Helper 未变更。

| 验证 | 本机结果及边界 |
| --- | --- |
| 完整本地 CI | 通过；132 个普通测试文件、1,018 项测试，17 项 Web 测试；包含构建、评估配置、打包、安装及卸载并保留用户数据。 |
| Chrome / Chromium | 两种浏览器各 2 项 Live 通过；中文填表与提交、实际下载内容、上传及符号链接越界拒绝、下拉选择、标签页切换、重开后的合成登录态保留。Chromium 同时核对了实际进程二进制。 |
| H5 | 桌面及手机尺寸下的截图接管、中文输入、交还 AI 通过；追加触摸事件与快捷键测试通过。未使用实体手机。 |
| 真实视觉模型 | 本机 Ollama `qwen3.5:4b` 的配置图片探测和截图 ArtifactRef → vision 路由 → Provider → 模型坐标 → 实际点击回执均通过；不等于开放任务质量评测。测试读取已有 Ollama 配置，不改模型目录。 |
| 现有浏览器扩展连接 | Google 官方 Playwright Extension 0.4.0 在临时 Chromium profile 中通过标准标签页授权、合成登录 Cookie 复用、中文输入、断开后保留原标签页与会话；没有连接日常浏览器或生产账号。扩展测试默认使用匹配 Playwright 的 Chromium，可用 `PULSE_EXTENSION_BROWSER` 显式指定测试二进制。 |
| macOS 桌面 | macOS 26.5.2 arm64，两项 Live 通过；独立 Helper 身份及退出、窗口枚举与聚焦、截图、点击、中文输入、拖拽、实际文件保存。辅助功能旧条目经用户批准移除再添加后生效，Helper 未再次重编译。 |
| 平台及工作流静态检查 | Windows/Linux Rust 交叉目标 `cargo check`、Windows PowerShell Parser、Linux Python 编译、CI/Release actionlint 通过；两种 macOS 架构签名完整性及 manifest 哈希通过。这些不是对应平台桌面实测。 |

提交准备时，另在独立临时目录验证仅包含本次功能的快照：构建、Web 类型检查、17 项 Web 测试及 132 个文件的 1,015 项普通测试通过。上表中的早期完整 CI 和 Live 记录来自包含原有未提交改动的工作区，不能等同于这次独立快照的 Live 验收；报告保留了两份源码范围。

未完成项：Windows/Linux（含 GNOME/KDE Wayland）及 Edge 实机环境当前不可用；没有推送源码触发本次版本的远程 CI，旧 SHA 的结果不能代替验收。OpenAI `gpt-4o-mini` 的最小合成图片请求返回 HTTP 401，现有凭据未通过认证；Anthropic 凭据未提供。macOS 只有 ad-hoc 签名，Gatekeeper 分发评估拒绝且未附公证票据，需要正式签名身份后继续验证。不同显示器/DPI、实体手机及生产账号仍需独立验收。

浏览器 Live 测试使用独立浏览器和临时本机站点；桌面 Live 测试只操作专用临时窗口。普通 CI、协议测试及交叉编译不能代替目标系统、真实设备和生产环境验收。
