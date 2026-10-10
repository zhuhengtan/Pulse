// Generated from CHANGELOG.md and CHANGELOG.en.md by scripts/release/sync-cli-highlights.mjs. Do not edit manually.
export const releaseHighlights: Record<string, Array<{ zh: string; en: string }>> = {
  "0.4.5": [
    {
      "zh": "复杂任务不再受全局模型调用次数上限截断，继续通过阶段、运行时限和循环检测控制执行；旧会话保持原有预算语义。",
      "en": "Complex tasks are no longer cut off by a run-wide model-call ceiling; stage limits, runtime limits, and loop detection still bound execution, while older sessions retain their original budget semantics."
    },
    {
      "zh": "大任务上下文从当前目标和阶段出发，沿依赖、证据和文件路径按需展开，同时保留用户要求及最近对话。",
      "en": "Large-task context expands on demand from the current objective and stage along dependencies, evidence, and file paths, while preserving user requirements and the latest exchange."
    },
    {
      "zh": "CLI 展示每次工具调用的状态、文件修改 diff 和命令或读取预览，便于查看并行执行与审批内容。",
      "en": "The CLI displays each tool call's status, file-edit diff, and command or read preview to make parallel execution and approval contents easier to inspect."
    },
    {
      "zh": "上下文展开支持继续访问此前已到达的节点，并在恢复会话后保留展开范围；剩余消息和目标中的文件路径可以正确检索。",
      "en": "Context expansion can continue from previously reached nodes after session restoration; remaining messages and file paths in the objective can be retrieved correctly."
    },
    {
      "zh": "最终验收引用无效证据时，将具体错误反馈给重试，避免重复提交相同结果。",
      "en": "Final acceptance feeds invalid evidence-reference errors back into retries to avoid repeatedly submitting the same result."
    },
    {
      "zh": "暂存写入和追加内容可在审批中预览；长 diff 保留尾部修改，隐藏内容和空行正确标记为截断。",
      "en": "Staged writes and appends include approval previews; long diffs retain tail edits, and hidden content and blank lines are correctly marked as truncated."
    }
  ],
  "0.4.4": [
    {
      "zh": "多阶段任务获得完整工具定义，并保留重试和依赖阶段的验收证据；补验证或补报告不再强制重复修改文件。",
      "en": "Multi-stage tasks receive complete tool definitions and retain verified evidence across retries and dependencies; verification or report corrections no longer force redundant file edits."
    },
    {
      "zh": "验证阶段增加进度检查点，减少重复运行已完成检查；新文件优先小步创建，未提交草稿不能算作完成。",
      "en": "Added validation progress checkpoints to reduce repeated completed checks; new files favor small creation steps, and uncommitted drafts do not count as finished work."
    },
    {
      "zh": "最终验收不再将无法验证的结果视为成功，缺失交付可恢复处理，最终报告保留实际交付内容。",
      "en": "Final acceptance no longer treats unverifiable results as success, missing deliverables can recover, and final reports retain the actual delivered content."
    },
    {
      "zh": "改善 DeepSeek 工具调用与结构化输出恢复、只读任务识别以及修改前基线测试流程。",
      "en": "Improved DeepSeek tool-call and structured-output recovery, read-only task recognition, and baseline testing before edits."
    },
    {
      "zh": "`pulse resume` 继承原任务，追问上轮结果时保留只读语义；支持通过 `--max-runtime-ms`、环境变量或配置设置运行时限。",
      "en": "`pulse resume` inherits the original task and keeps previous-run summaries read-only; runtime limits can be set through `--max-runtime-ms`, an environment variable, or configuration."
    }
  ],
  "0.4.3": [
    {
      "zh": "OpenAI 兼容接口会按配置发送 reasoning effort；o1 与 o3 系列改用 `max_completion_tokens`。某个模型拒绝该参数时，只停用这一模型并重试。",
      "en": "OpenAI-compatible requests send the configured reasoning effort, and o1/o3 models use `max_completion_tokens`. If one model rejects that parameter, only that model is disabled and the request is retried."
    },
    {
      "zh": "DeepSeek 协议仍使用 JSON object 和 schema 提示。其他协议即使模型名包含 deepseek，也继续使用 JSON schema。",
      "en": "The DeepSeek protocol still uses JSON object mode with schema guidance. Other protocols keep JSON schema even when the model name contains deepseek."
    }
  ],
  "0.4.2": [
    {
      "zh": "阶段验收要求每条引用都有效；涉及文件、命令或测试的阶段必须有成功的工具证据，纯写作阶段仍可凭候选结果通过。",
      "en": "Stage acceptance requires every cited reference to be valid. Stages that touch files, commands, or tests need successful tool evidence, while pure writing stages can still pass on the candidate result."
    },
    {
      "zh": "DeepSeek 不再把未命名 JSON 当成文件写入或命令执行；回复后的附加文本保持为正文，损坏的 DSML 参数按截断处理。",
      "en": "DeepSeek recovery no longer treats unnamed JSON as a file write or shell command. Trailing text stays text, and invalid DSML parameters are treated as truncation."
    },
    {
      "zh": "暂存写入和提交会拒绝 `.pulse` 路径；列出不存在的目录会返回 ENOENT，已存在的空目录仍返回空列表。",
      "en": "Staged writes and commits reject `.pulse` paths. Listing a missing directory returns ENOENT, while an existing empty directory still returns an empty list."
    },
    {
      "zh": "命令拆分能识别引号；通过 `sh -c`、`bash -c` 等启动器执行的命令会被拒绝。",
      "en": "Command splitting respects quotes. Commands launched through shells such as `sh -c` or `bash -c` are rejected."
    },
    {
      "zh": "`pulse resume` 在终端重新进入交互界面；已有任务的非交互运行不再因空闲标准输入一直等待，显式 mock 参数可以覆盖 `PULSE_MODEL`。",
      "en": "`pulse resume` returns to the interactive screen on a terminal. A non-interactive run that already has a task no longer waits on idle stdin, and explicit mock flags can override `PULSE_MODEL`."
    }
  ],
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
