# Pulse 产品主页

静态 HTML、CSS 和 JavaScript，不依赖模型、服务端或外部字体。公开站点：<https://zhuhengtan.github.io/Pulse/>。

本地预览：`python3 -m http.server 4180 --bind 127.0.0.1 --directory site`。
检查：`pnpm site:check`。网站图片来自项目品牌素材及使用演示数据的 Pulse 界面截图。

`.github/workflows/pages.yml` 在主页源码更新或 Release 成功后部署。首次需在仓库 Settings → Pages 将 Source 设为 GitHub Actions。仓库 About 的 Website 可填入产品主页地址。

部署时 `scripts/site/downloads.mjs` 读取最新正式 GitHub Release，生成 `downloads.json`。必须所有系统的安装包及 SHA-256 文件齐全才开放下载；旧的 CLI-only Release、草稿、预发布或缺失附件会显示发布进度。源码中的空 manifest 是安全默认值，不填写计划中的版本号或虚构下载链接。

桌面包名使用 `pulse-macos-{arm64,x64}.dmg`、`pulse-windows-x64.exe`、`pulse-linux-x64.AppImage` 和 `pulse-linux-x64.deb`。正式 Release 完成后自动刷新官网，不在主页中硬编码安装包版本。
