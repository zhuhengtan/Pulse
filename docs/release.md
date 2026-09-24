# Pulse 发布流程

Pulse 使用 pnpm monorepo 管理 `packages/*`，根目录同时声明了 npm `workspaces`，因此 npm 和 pnpm 都能识别工作区。

## 版本与检查

所有可发布包保持同一版本。修改版本号：

```bash
pnpm release:version 0.2.1
pnpm check
pnpm release:check
pnpm cli:build
pnpm cli:pack
pnpm cli:verify-package
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
4. 按 runtime、tool-sdk、adapters、server、cli 的依赖顺序发布 npm 包；
5. 创建 GitHub Release 并上传 CLI 压缩包和 SHA-256 文件。

各 npm 包需要配置匹配本仓库和 `release.yml` 的 Trusted Publisher。Workflow 通过 `id-token: write` 使用 npm Trusted Publishing，通过 `GITHUB_TOKEN` 创建 Release，无需新增 `NPM_TOKEN` secret。

发布后确认 Release workflow 成功、GitHub Release 附件齐全，并逐一检查五个 npm 包的版本。Registry 传播有延迟时重试查询，不要把本地检查或 CI 通过当作已经发布成功。
