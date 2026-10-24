# Pulse 发布流程

Pulse 使用 pnpm monorepo 管理 `packages/*`，根目录同时声明了 npm `workspaces`，因此 npm 和 pnpm 都能识别工作区。

## 版本与检查

所有可发布包（含 `data`）保持同一版本，桌面客户端也使用该版本。发布前先在根目录的 [中文更新日志](../CHANGELOG.md) 和 [English changelog](../CHANGELOG.en.md) 分别补齐目标版本说明；两个文件共同为 `pulse --version` 提供版本亮点。随后修改版本号并运行完整本地 CI：

```bash
pnpm release:version 0.4.1 # replace with the target version
pnpm ci:local
```

提交并推送不带标签的候选提交：

```bash
git push origin main
```

等待这个精确提交的 CI 完成，确认 Ubuntu、macOS、Windows 三个平台的所有必需检查均成功。失败、跳过、排队或运行中均不能作为发布通过。修复后必须重新检查新提交。

全部通过后，将标签指向已验证的提交，再单独推送标签（将 `<verified-sha>` 替换为通过 CI 的完整提交 SHA）：

```bash
git tag v0.2.1 <verified-sha>
git push origin v0.2.1
```

不要把候选分支和发布标签一起推送。日常发布使用下面的 GitHub Release 流程；直接发布命令仅用于明确授权的人工维护。

## 在本地运行 CI

先安装 Node.js 22、pnpm 12.4.2、Python 3.12 和 Git，再运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm ci:local
```

这个入口与 GitHub CI 共用，依次执行类型检查、非 Live 测试、评测集和发布配置检查、构建、CLI 初始化、打包、解压运行、安装/卸载及三个开发启动入口。遇到失败立即停止；使用临时 Pulse 配置和数据目录，不会发布版本。压缩包保留在 `artifacts/cli/`。

`ci:local` 会先运行 `pnpm native:prepare`，显式执行已允许的 `node-pty` 构建脚本；Linux 没有上游预编译包，需要 C/C++ 编译工具链。仅执行 `--ignore-scripts` 安装不能验证本地终端能力。

平台依赖需提前准备：macOS 使用系统沙箱；Linux 需要 `bubblewrap`、`ripgrep`、`socat`，并允许非特权用户命名空间；Windows 需要 PowerShell 7，并用管理员权限执行一次 `pnpm --filter @hunterzhu/pulse-adapters exec srt windows-install`。Windows 的 `TEMP`/`TMP` 应指向沙箱账户可访问的目录，例如 `C:\pulse-ci-temp`，不要使用用户私有目录；GitHub runner 已自动配置。检查脚本不会安装或卸载本机沙箱服务。

Windows 源码环境还需 Rust/MSVC 工具链，并先执行 `pnpm desktop:build`。它按 `native/srt-win-patch/SOURCE.json` 的固定源码与校验值构建 Windows 沙箱，执行原生 ACL 回归后生成带完整性清单的二进制；正式 npm 包及 CLI 压缩包直接包含该产物。Release 从 Windows 构建任务下载这一产物，不能回退到未修复的沙箱二进制。 权限初始化按小批次写入完整的读写拒绝规则，全部成功后才启动命令；各批次使用同一宿主 PID，失败或关闭时由原生账本统一回收。

本地验证当前操作系统。macOS 不能代替 Windows 的权限、文件锁与网络隔离验证；Docker 也不能提供 Windows 内核。日常改动先跑本地检查，发布前再让云端矩阵验证同一提交的三个平台。

## pnpm 发布

```bash
pnpm release:publish
```

它会构建所有 workspace 包、检查版本和 `publishConfig`，然后执行 `pnpm publish -r --access public`。需要先登录 npm，或在 CI 中提供 `NODE_AUTH_TOKEN`。

## npm workspace 发布

```bash
pnpm release:npm-publish
```

源码依赖使用 pnpm 的 `workspace:*`，npm CLI 不会自动转换这个协议，所以脚本会在临时目录复制构建产物，把内部依赖转换成当前版本，再按依赖顺序调用 `npm publish`。临时目录会在结束后删除。

## GitHub Release

推送 `v*` tag 后，`.github/workflows/release.yml` 会：

1. 验证标签对应提交的最新 main CI 和三个操作系统任务全部成功；
2. 安装依赖并运行完整检查；CI 和 Release 使用相同的 pnpm 版本、安装位置与沙箱入口检查；
3. 构建并验证 `pulse-<version>.tar.gz`，包括启动、安装、卸载与用户数据保留；
4. 调用桌面打包工作流，验证原生启动、安装及数据保留，构建 macOS arm64/x64、Windows x64 和 Linux x64 的客户端；所有客户端任务通过后才能继续发布；
5. 校验完整的 8 个桌面安装包/压缩包并生成 `pulse-desktop-SHA256SUMS.txt`，按 data、runtime、tool-sdk、adapters、server、cli 的依赖顺序发布 npm 包；
6. 创建草稿 GitHub Release，上传 CLI 压缩包、四个平台的客户端及校验文件，全部上传成功后再公开 Release。

各 npm 包需要配置匹配本仓库和 `release.yml` 的 Trusted Publisher。Workflow 通过 `id-token: write` 优先使用 npm Trusted Publishing，通过 `GITHUB_TOKEN` 创建 Release。发布步骤也接入仓库已有的 `NPM_TOKEN` secret，供尚未配置 Trusted Publisher 的新包首次发布时回退使用；不需要本机登录 npm。新包首次发布后，应在 npm 包设置中配置本仓库 `release.yml` 的 Trusted Publisher。

发布后确认 Release workflow 成功、GitHub Release 附件齐全，并逐一检查六个 npm 包的版本。Registry 传播有延迟时重试查询，不要把本地检查或 CI 通过当作已经发布成功。

## 产品主页与下载

`site/` 是独立的静态产品主页，README 顶部链接到 `https://zhuhengtan.github.io/Pulse/`。首次在仓库 Settings → Pages 将 Source 设为 GitHub Actions，并在 About → Website 填入该地址。

`.github/workflows/pages.yml` 在站点修改或 Release 工作流成功后部署。它从最新正式 Release 生成下载清单；安装包或校验文件不全时保留“查看发布进度”，不生成失效下载链接。页面使用精确版本的附件链接，因此不会将当前展示版本与下一版尚未齐全的安装包混用。手动重跑 Product page 可刷新下载清单。

桌面文件名固定为 `pulse-macos-{arm64,x64}.{dmg,zip}`、`pulse-windows-x64.{exe,zip}` 和 `pulse-linux-x64.{AppImage,deb}`。直接链接可采用 GitHub 的 `releases/latest/download/<filename>`；主页通过部署时生成的版本清单链接精确 Release。单独运行 Desktop packages 只上传 Actions artifact，不公开发布。
