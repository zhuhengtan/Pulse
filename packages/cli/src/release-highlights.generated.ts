// Generated from CHANGELOG.md and CHANGELOG.en.md by scripts/release/sync-cli-highlights.mjs. Do not edit manually.
export const releaseHighlights: Record<string, Array<{ zh: string; en: string }>> = {
  "0.4.1": [
    {
      "zh": "新增按需发现与调用 Skill 的能力，减少无关指令进入任务上下文。",
      "en": "Added on-demand Skill discovery and invocation to keep unrelated instructions out of task context."
    },
    {
      "zh": "美化安装欢迎界面和版本页，提供中英双语介绍及版本亮点。",
      "en": "Polished the installation welcome screen and version page with bilingual product information and release highlights."
    },
    {
      "zh": "提供中英文分离的更新日志和双语用户文档，并校验版本亮点来源。",
      "en": "Added separate Chinese and English changelogs and bilingual user documentation, with validation for version highlights."
    },
    {
      "zh": "为全部五个 npm 包采用 PolyForm Noncommercial 1.0.0，并随包提供许可证说明。",
      "en": "Licensed all five npm packages under PolyForm Noncommercial 1.0.0 and included package-level license notices."
    }
  ],
  "0.4.0": [
    {
      "zh": "默认使用异步并行 event loop，让模型请求、工具调用等副作用并发推进。",
      "en": "Uses an asynchronous, parallel event loop by default so model requests, tool calls, and other effects can progress concurrently."
    }
  ],
  "0.3.0": [
    {
      "zh": "增强 CLI 交互体验，支持内容选择与复制、推理用量归因、任务进度流式展示和可恢复会话。",
      "en": "Improved CLI interaction with text selection and copying, reasoning-usage attribution, streamed task progress, and resumable sessions."
    }
  ],
  "0.2.1": [
    {
      "zh": "增加安装后的欢迎界面，并完善跨平台本地与云端 CI 验证入口。",
      "en": "Added the post-install welcome screen and improved the shared cross-platform local and cloud CI entry point."
    }
  ],
  "0.2.0": [
    {
      "zh": "扩展 CLI 与 Host 能力，完善会话恢复、人机协作、工具调用和 Windows 沙箱及发布验证。",
      "en": "Expanded CLI and Host capabilities with resumable sessions, human interaction, tool calls, and improved Windows sandbox and release validation."
    }
  ],
  "0.1.11": [
    {
      "zh": "修复 Windows 下打包 CLI 入口加载问题，并改进跨平台安装与发布验证。",
      "en": "Fixed loading the packaged CLI entry point on Windows and improved cross-platform installation and release validation."
    }
  ],
  "0.1.10": [
    {
      "zh": "维护性版本发布；未单独记录用户可见更新。",
      "en": "Maintenance release; no separate user-facing changes were recorded."
    }
  ],
  "0.1.9": [
    {
      "zh": "维护性版本发布；未单独记录用户可见更新。",
      "en": "Maintenance release; no separate user-facing changes were recorded."
    }
  ],
  "0.1.8": [
    {
      "zh": "增加 npm 安装后的首次配置初始化流程。",
      "en": "Added first-run configuration initialization after npm installation."
    }
  ],
  "0.1.7": [
    {
      "zh": "增加完整屏幕 CLI 工作区、模型配置与会话交互能力。",
      "en": "Added a full-screen CLI workspace, model configuration, and interactive session capabilities."
    }
  ],
  "0.1.6": [
    {
      "zh": "增加人类输入仲裁和主动 CLI 交互，并强化上下文、持久化与流式工具调用。",
      "en": "Added human-input arbitration and active CLI interaction, while strengthening context, persistence, and streamed tool calls."
    }
  ],
  "0.1.5": [
    {
      "zh": "改进 Provider 工具名称兼容性。",
      "en": "Improved compatibility of tool names across providers."
    }
  ],
  "0.1.4": [
    {
      "zh": "修复 Provider 安全工具名称的适配问题。",
      "en": "Fixed adapter handling for provider-safe tool names."
    }
  ],
  "0.1.3": [
    {
      "zh": "完善 CLI 工具暴露、用户文件目录和 Provider 错误反馈。",
      "en": "Improved CLI tool exposure, user-file locations, and provider error reporting."
    }
  ],
  "0.1.2": [
    {
      "zh": "修复 CLI 显示已安装包版本的问题。",
      "en": "Fixed CLI reporting of the installed package version."
    }
  ],
  "0.1.1": [
    {
      "zh": "完善首次运行配置创建及基础 npm 工作区使用体验。",
      "en": "Improved first-run configuration setup and basic npm workspace usage."
    }
  ],
  "0.1.0": [
    {
      "zh": "建立 Pulse CLI 初始 npm 发布包和仓库发布元数据。",
      "en": "Established the initial Pulse CLI npm package and repository release metadata."
    }
  ]
}
