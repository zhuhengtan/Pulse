# Pulse 发布流程

Pulse 使用 pnpm monorepo 管理 `packages/*`，根目录同时声明了 npm `workspaces`，因此 npm 和 pnpm 都能识别工作区。

## 版本与检查

所有可发布包保持同一版本。修改版本号：

```bash
pnpm release:version 0.2.0
pnpm release:check
```

提交版本变更后创建 tag：

```bash
git tag v0.2.0
git push origin main --tags
```

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

1. 安装依赖并运行完整检查；
2. 发布 npm workspace 包；
3. 构建 `pulse-<version>.tar.gz` 和 SHA-256 文件；
4. 创建 GitHub Release 并上传 CLI 压缩包。

仓库需要配置 `NPM_TOKEN` secret。Workflow 使用 `GITHUB_TOKEN` 创建 Release，并启用 npm provenance 所需的 OIDC 权限。
