# Electron 完整安装体验验收

2026-10-22，本机 macOS arm64；应用版本 0.7.0。实际测试应用为 `artifacts/desktop/mac-arm64/Pulse.app`，未配置发布签名。最终随包运行环境构建标识为 `128b56a44932ec02cf720e5d6c645c59561ccbe882c44d79f0e583a499ef4bca`。

## 已验证

- 安装相关及现有设备/浏览器接口测试 17 项通过；Web 完整测试 187 项通过，最后的首启界面调整另跑 4 项通过。根项目与 Web 类型检查、`git diff --check` 通过。
- 源码 Electron 使用隔离的安装目录、配置、shell 配置、数据和窗口配置，完成首启、终端命令、内置浏览器、再次启动和修复验收。
- 实际打包应用以完全空的 PATH 启动。首次自动准备 Node、CLI、Server 和 Chromium，创建配置，注册命令并连接后台；欢迎页可进入产品或前往模型配置。
- 桌面管理的 CLI 可运行 `pulse --version`；测试中显式加载隔离的 shell 配置后，也能直接通过 `pulse` 调用。CLI 与桌面共用配置和数据路径；独立安装的 CLI、符号链接入口及用户配置保留行为由测试覆盖。
- 内置 Chromium 打开本机测试网页并返回页面标题，不依赖系统 Chrome。测试没有调用外部模型或向外部站点提交数据。
- 关闭和重开窗口后，不重复首启；设备 ID 和原后台 PID 保持一致。
- 删除已安装的 Server 组件后执行修复：生成新的完整运行目录、更新命令入口；原后台继续运行，界面提示手动应用更新。配置、已创建的会话和数据哨兵文件保留。
- 打包后的 22614 项运行文件全部通过清单校验；macOS 内部相对符号链接可移植，打包器过滤的 `.DS_Store` 不参与校验。
- 原有真实 Electron 回归通过：聊天 WS、工作 POST/SSE、1 万条历史分页与窗口化、30 次切换、窗口关闭后后台存活，以及服务停止后刷新仍可读本地历史。该项使用临时数据和模拟模型。

主要复现命令：

```sh
pnpm desktop:app:prepare
pnpm --filter @hunterzhu/pulse-desktop run pack --mac --arm64
PULSE_DESKTOP_EXECUTABLE="$PWD/artifacts/desktop/mac-arm64/Pulse.app/Contents/MacOS/Pulse" pnpm desktop:app:install-smoke
pnpm desktop:app:startup-smoke
pnpm desktop:app:smoke
```

## 边界

Windows/Linux 与 macOS x64 已配置原生 CI 验收入口，本轮未在对应系统执行。未验证签名、公证、从互联网下载后的 Gatekeeper 行为、NSIS/DEB 系统安装或在线客户端更新。模型账号、API Key、Ollama、Git 与项目构建工具仍由用户按需配置，安装包不提供模型服务或额度。

本轮没有提交或发布代码，没有重启用户现有 Electron、7332 正式服务或 7333 开发服务，也没有向用户真实终端配置注册测试命令。先前未提交的设备管理与浏览器改动保留。
