# 明早验收清单：托盘后台与任务通知

本报告为独立普通功能复核与非 GUI 交付准备。对应基线 `ba1f1cea` 及当前未提交工作区；保留主会话其他修改，未 commit/push。本轮没有运行真实模型、启动监听服务、操作 GUI、安装依赖/开机服务或更改系统设置，不代表完整安全审计。

## 直接启动

本轮已执行 `pnpm build`，现有依赖与 Electron 二进制已确认存在。进入仓库后任选一种启动方式；以下启动与系统投递步骤由用户手动验收，或待主会话取得原有 Electron 操作授权后执行：

```sh
cd /Users/zhuhengtan/projects/Pulse
pnpm desktop:app:dev
```

仅使用本机 H5、初始隐藏桌面窗口：

```sh
pnpm desktop:app:dev -- --background
```

后台 server/API 与 H5 由托盘管理。通过托盘“打开 H5”进入实际服务地址，不需要猜测随机端口；通过“打开交互式 CLI”进入使用相同数据目录的终端。若手动启动独立 CLI，可在仓库中使用：

```sh
PULSE_DATA_DIR="$PWD/.pulse-dev/h5/data" pnpm cli:start
```

上面数据目录对应默认开发启动；使用自定义数据目录时须换成托盘当前使用的目录。本轮未停止、重启已有后台或主会话待批进程。如果托盘提示连接的是旧版本后台，应等现有任务结束后，通过原启动入口退出该后台再重新启动；外部入口拥有的后台不能由托盘停止。

## 操作与预期

- [ ] 关闭桌面窗口后，托盘仍存在，后台任务继续；“打开桌面端”恢复窗口，且仍是原会话。
- [ ] 托盘可打开 H5 与交互式 CLI。“退出托盘（保留后台服务）”后 H5 后台继续；重新启动可连接已有服务。“停止后台并退出”需要确认，只针对托盘拥有的服务。
- [ ] 分别从桌面/H5 和托盘打开的交互 CLI 发起任务：结束时出现对应通知；点击进入正确工作会话并查看结果。
- [ ] 运行停在单个文本问题时，macOS 系统通知提供回复；提交只影响原 run/group/effect。也可点击通知进入 H5/桌面回答。
- [ ] 多题、选择题、多选题及审批进入原任务页面处理。重复提交只处理一次；在终端已回答、取消或题目已更换后再使用旧通知，不应回答其他问题。
- [ ] 保持一个问题待答，再产生超过 200 条其他任务结束记录：该待办仍存在。回答、取消或运行失效后清除；服务重启不恢复已失效问题。
- [ ] 系统投递失败或通知权限拒绝时，网页/托盘待办仍可使用；已处理或缺失的深链目标显示提示，不自动切换到另一题。

## 必须知道的边界

- 系统通知投递、macOS 通知内回复与历史恢复，仍需获权后的签名应用实机验证。模拟测试通过不等于操作系统已送达通知。本轮未改通知权限或签名配置，也未重试待批 GUI 操作。
- H5-only 这里指本机浏览器。托盘新建服务监听 `127.0.0.1`，手机不能直接访问；手机需要用户另行配置的可达 H5 服务与原有配对流程。本轮不自动改监听、网络或防火墙。
- H5 没有 Service Worker/Web Push，浏览器完全退出后不会继续收系统通知。Windows/Linux 通知内作答降级为点击进入任务；Windows/Linux、手机和浏览器实际投递未实测。
- 交互 CLI 的终端须继续运行，托盘并不托管 CLI 进程寿命。非交互 `pulse run`/resume 保持“遇待输入即取消”的既有语义；纯 CLI 且未运行 H5/托盘时没有桌面投递。
- CLI 桥复用既有 ConversationData 单写者服务，没有新增端口或凭据。回复未接收时 8 秒过期；CLI 心跳失联 15 秒后不再接受作答，恢复心跳后可重新显示有效问题。

## 本轮证据

| 项目 | 结果 |
| --- | --- |
| 正规 `pnpm build` | 通过：server、CLI、Web 编译与 server Web 资源复制完成；仅有 Vite 大包体积提示 |
| 通知收件箱与 CLI 桥测试 | 21/21 通过，纯内存；包含容量、重启、完成/取消、单题回复、过期/重复、题目更换、心跳恢复与 H5 共存 |
| Provider 流异常专项 | 2/2 通过；同文件其他 38 项未选入本轮 |
| Web 通知、定位、问答卡片、路由 | 47/47 通过，jsdom/模拟传输 |
| Web 类型检查、桌面入口/后台/通知脚本语法、diff 空白检查 | 通过 |
| Electron 主程序 | `src/main.mjs` 直接运行，无独立 dist 编译步骤；二进制仅检查存在，未启动 |
| 原生 helper、桌面 runtime 准备、打包/签名 | 未执行：脚本可能调用 Cargo、下载 Chromium、签名；无本轮原生代码改动 |
| 真实数据服务跨进程、CLI/server 联动与系统通知实机 | 未执行：需要启动服务或 GUI，仍待原有权限/实机验收 |

最终相关测试合计 70 项通过。此前较宽的 Provider 文件运行中，5 项 shell/sandbox 集成用例在本地 socket 初始化时被环境以 `EPERM` 拒绝；未重试、换路或申请放行。`pnpm check`/完整 CI 包含监听服务及集成测试，本轮没有执行，也不宣称全部通过。

复现本轮无监听专项命令：

```sh
pnpm exec vitest run tests/task-notifications.test.ts tests/cli-notification-bridge.test.ts tests/m3-context-adapters.test.ts --testNamePattern 'task notification lifecycle|CLI notification bridge|rejects .* stream errors and incomplete completions'
pnpm --filter @hunterzhu/pulse-web exec vitest run tests/task-notifications.test.tsx tests/task-notification-navigation.test.tsx tests/ask-cards.test.tsx tests/routing.test.tsx
pnpm --filter @hunterzhu/pulse-web check
```

详细使用范围与平台支持见 [托盘后台与任务通知](background-notifications.md)。独立复核已修复四处普通功能问题：H5 投递失败连带阻断待办、通知深链选择错误问题、有效待办被结束历史挤出，以及独立 CLI 缺少通知/回复桥。

本轮日志保存在 `/tmp/pulse-readonly-review.k4Eula/`：`final-build.log`、`final-unit.log`、`final-web.log`、`final-web-types.log`。它们是本次运行证据，临时目录可能被系统清理。
