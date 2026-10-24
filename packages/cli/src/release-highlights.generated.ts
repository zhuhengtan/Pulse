// Generated from CHANGELOG.md and CHANGELOG.en.md by scripts/release/sync-cli-highlights.mjs. Do not edit manually.
export const releaseHighlights: Record<string, Array<{ zh: string; en: string }>> = {
  "0.8.0": [
    {
      "zh": "新增 Pulse 桌面客户端，支持本地会话存储、模型设置、设备管理与原生浏览器，并复用现有项目和会话数据。",
      "en": "Added the Pulse desktop client with local conversation storage, model settings, device management, and a native browser, reusing existing projects and conversation data."
    },
    {
      "zh": "新增统一标签页面板，预览文档、图片、代码差异与浏览器页面；计划确认中的文件可直接点击预览，首次启动默认保持面板关闭。",
      "en": "Added a unified tabs panel for documents, images, code diffs, and browser pages; plan confirmation links open previews directly, and the panel stays closed on first launch."
    },
    {
      "zh": "新增可排队的后续消息和模型驱动的中途指正，保留用户输入顺序并将提问答复与消息队列分开处理。",
      "en": "Added queued follow-up messages and model-directed steering, preserving input order while keeping question replies separate from the message queue."
    },
    {
      "zh": "新增 Pulse 产品主页与仓库下载入口，正式 Release 提供 macOS、Windows、Linux 客户端、版本对应的下载链接及 SHA-256 校验文件。",
      "en": "Added the Pulse product website and repository download entry points, with macOS, Windows, and Linux clients, version-specific downloads, and SHA-256 checksums in public releases."
    },
    {
      "zh": "新增开发诊断、代码快照及自主任务回归工具，支持监督修复过程并检查实际产物与验收证据。",
      "en": "Added development diagnostics, code snapshots, and autonomous-task regression tools to supervise repairs and check actual deliverables and acceptance evidence."
    },
    {
      "zh": "提问卡片直接显示输入框，并允许关闭而不作答；关闭不会提交草稿、猜测选项或授予执行权限。",
      "en": "Question cards show text inputs directly and can be closed without answering; dismissal does not submit drafts, infer choices, or grant execution permission."
    },
    {
      "zh": "改善任务计划的准则标识容错、纯分析阶段证据判定、并发 Lane 的中断恢复，以及读取和验证失败后的续执行。",
      "en": "Improved plan criterion identifier normalization, analysis-stage evidence handling, interrupted parallel Lane restoration, and continuation after read or verification failures."
    },
    {
      "zh": "数据服务改用有界启动就绪握手，保留服务退出与启动失败的诊断，避免冷启动被过早判定失败。",
      "en": "Data services use a bounded startup-readiness handshake and retain exit and startup diagnostics, avoiding premature failures during cold starts."
    },
    {
      "zh": "修复工作区合入对已忽略数据目录的处理，收紧 Git 读取和配对设备权限，并阻止 pnpm 隐式重装依赖。",
      "en": "Fixed merging ignored data directories from workspaces, tightened Git reads and paired-device permissions, and prevented implicit pnpm dependency reinstalls."
    },
    {
      "zh": "修复 CLI 内联参数中等号被截断的问题，改善富文本输入、项目侧栏、审批菜单与执行过程展示。",
      "en": "Fixed truncated equals signs in inline CLI arguments and refined rich-text composition, project navigation, approval menus, and execution progress display."
    }
  ],
  "0.7.0": [
    {
      "zh": "新增富文本输入框，支持技能与文件标签、粘贴及拖放附件，并按会话保存编辑草稿。",
      "en": "Added a rich-text composer with skill and file mentions, pasted and dropped attachments, and conversation-specific drafts."
    },
    {
      "zh": "附件内容可通过工具分页读取，支持文本与代码、PDF、XLSX 和 DOCX 正文；PNG/JPEG 沿用图像输入链路，并加强格式、大小与解析限额校验。",
      "en": "Added paginated attachment reading for text, code, PDF, XLSX, and DOCX text; PNG/JPEG continue through image input, with stronger format, size, and parsing limits."
    },
    {
      "zh": "Web 页面、会话和工作区位置使用独立地址，支持浏览器前进后退及刷新恢复；移动端可选择宿主机文件或目录并新建项目文件夹。",
      "en": "Added addressable Web pages, conversations, and workspace positions with browser history and refresh restoration; mobile clients can select host files or directories and create project folders."
    },
    {
      "zh": "桌面 Web 支持导入导出工作会话，携带附件与恢复所需状态，清理敏感配置并在迁移后重新校验任务恢复条件。",
      "en": "Added desktop Web import and export for work conversations, including attachments and recovery state, with sensitive configuration removed and recovery prerequisites rechecked after transfer."
    },
    {
      "zh": "计划修改后复核完整文档的一致性，将确认绑定到当前计划内容，减少局部修订造成的矛盾与重复返工。",
      "en": "Review the complete plan for consistency after edits and bind confirmation to its current content, reducing contradictions and repeated revisions."
    },
    {
      "zh": "发送消息后立即清空已提交草稿，失败时保留重试入口并恢复原会话草稿；切换会话、附件异步读取及连续聊天排队不再相互覆盖。",
      "en": "Clear submitted drafts immediately, retain retry controls and restore the originating draft on failure, and prevent session switches, asynchronous attachment reads, and queued chat messages from overwriting one another."
    },
    {
      "zh": "修复审批在上下文压缩与任务恢复时丢失、移动端确认操作异常、工具超时配置及工作进程漏传附件和引用信息的问题。",
      "en": "Fixed approval loss during context compaction and task recovery, mobile confirmation failures, tool timeout handling, and missing attachment and reference fields in worker messages."
    },
    {
      "zh": "改善移动端顶部留白、路径导航、侧栏文字和项目折叠布局，优化停止按钮，并隐藏手机端会话导入导出入口。",
      "en": "Improved mobile header spacing, breadcrumbs, sidebar labels and project folding, refined the stop button, and hid conversation transfer controls on phones."
    },
    {
      "zh": "移除工作聊天顶部重复的任务面板，在消息列表中保留 Lane 活动及任务恢复操作；交付文件改为按轮次紧凑展示，完整路径按需展开。",
      "en": "Removed the duplicate task panel above work chats while retaining Lane activity and recovery actions in the message list; delivery files now appear compactly below their own turns, with full paths expandable on demand."
    },
    {
      "zh": "修复 Windows 路径与检查清单格式、迁移工作区换行转换、状态文件短暂占用导致的发送失败，以及服务关闭时的结果清理竞态，并提前执行跨平台专项回归。",
      "en": "Fixed Windows path and check-inventory formats, line-ending changes in transferred workspaces, send failures caused by briefly locked state files, and result-cleanup races during shutdown; run platform-specific regressions early in CI."
    }
  ],
  "0.6.0": [
    {
      "zh": "新增受管理的浏览器与桌面自动化，支持页面观察、截图操作、上传下载、暂停及人工接管，并在 CLI 和 H5 中提供入口。",
      "en": "Added managed browser and desktop automation with page observation, screenshot actions, uploads and downloads, pause, and human takeover through CLI and H5 controls."
    },
    {
      "zh": "Web 工作台展示任务执行过程、阶段进度和工具调用详情，便于查看运行状态与审批内容。",
      "en": "The Web workbench displays task execution traces, stage progress, and tool-call details to make run status and approval requests easier to inspect."
    },
    {
      "zh": "改善长任务的上下文压缩、工具输入恢复、循环检测和预算处理，保留中断续跑的状态及调用记录。",
      "en": "Improved context compaction, tool-input recovery, loop detection, and budget handling for long tasks, preserving state and call accounting across interrupted runs."
    },
    {
      "zh": "按明确的并行要求调度独立阶段，修复并行工作单元的状态访问与依赖证据传递。",
      "en": "Schedule independent stages in parallel when explicitly requested, and fix worker state access and dependency evidence propagation."
    },
    {
      "zh": "保存计划后执行与内容绑定的确认，计划变更需重新确认；审批继续保留人工回退和操作范围限制。",
      "en": "Bind execution confirmation to the saved plan and require confirmation again after changes; approvals retain human fallback and operation scope checks."
    },
    {
      "zh": "保护原有测试与验收命令，在修改前阻止破坏性补丁，同时允许授权的新测试补充和修正。",
      "en": "Protect original tests and acceptance commands by rejecting destructive patches before writes, while allowing authorized additions and corrections to new tests."
    },
    {
      "zh": "修复验证证据的新鲜度、无效引用恢复及已通过测试覆盖先前失败子集的判定，减少重复验证与错误阻塞。",
      "en": "Fix evidence freshness, recovery from invalid citations, and recognition of passing test supersets that cover earlier failed subsets, reducing redundant checks and false blocks."
    },
    {
      "zh": "修复 Windows 安装依赖只读隔离、相邻源码的读取边界、脚本审批路径显示及沙箱权限分批初始化，减少无关脚本的递归依赖授权开销，完善跨平台回归验证。",
      "en": "Fix Windows read-only isolation for installed dependencies, read boundaries for adjacent source, script approval path display, and batched sandbox permission initialization; reduce recursive dependency grants for unrelated scripts and improve cross-platform regression checks."
    },
    {
      "zh": "H5 停止服务时等待正在启动的助理运行完成清理，保留后续排队消息；会话文件统一原子写入，修复并发读取异常和请求挂起。",
      "en": "H5 shutdown waits for assistant launches already in progress to settle and preserves later queued messages; atomic conversation writes prevent concurrent read errors and hanging requests."
    }
  ],
  "0.5.1": [
    {
      "zh": "模型目录按供应商管理，支持不同供应商登记同名模型；默认模型、助理聊天、任务路由、即时预回复和审批复核统一选择已登记模型。",
      "en": "Models are managed under providers, allowing different providers to register the same model name; defaults, assistant chat, task routing, instant replies, and approval review all select registered models."
    },
    {
      "zh": "项目侧栏支持组织会话与项目，并完善工作区信任边界及模型配置迁移。",
      "en": "Added project sidebar organization and improved workspace trust boundaries and model configuration migration."
    },
    {
      "zh": "即时预回复按所选供应商模型读取协议与连接配置；审批复核继续限制为本机 Ollama，并在异常时交回人工。",
      "en": "Instant replies use the selected provider's protocol and connection settings; approval review remains restricted to local Ollama and falls back to human review on errors."
    },
    {
      "zh": "改善 Jarvis 经验记录、上下文筛选和持久化交付流程。",
      "en": "Improved Jarvis experience recording, context filtering, and durable delivery workflows."
    }
  ],
  "0.5.0": [
    {
      "zh": "新增独立 Web 工作台，统一助理聊天、项目工作会话、历史记录、设置与本地终端。",
      "en": "Added a standalone Web workbench for assistant chats, project work sessions, history, settings, and local terminals."
    },
    {
      "zh": "项目任务使用独立工作进程和 Git 工作区，继承当前项目改动，验收通过后合入结果；非 Git 项目使用互斥锁串行执行。",
      "en": "Project tasks run in separate worker processes and Git worktrees that inherit current project edits and merge accepted results; non-Git projects use exclusive locks for serial execution."
    },
    {
      "zh": "支持助理调用项目、工作会话及 Jarvis 工具，跟踪任务状态，并通过持久化消息队列恢复中断交互。",
      "en": "The assistant can invoke project, work-session, and Jarvis tools, track task status, and recover interrupted interactions through a persistent message inbox."
    },
    {
      "zh": "多个澄清问题可分组一次回答；Jarvis 检索结果按当前请求筛选后进入执行上下文。",
      "en": "Related clarification questions can be answered as one group; retrieved Jarvis context is selected for the current request before execution."
    },
    {
      "zh": "工作区交付比较任务起始快照，正确合入已提交成果，并支持解决冲突后重试；非 Git 失败重试保留共享目录锁语义。",
      "en": "Workspace delivery compares against the task's starting snapshot, merges already committed results, and supports retries after conflict resolution; non-Git retries retain shared-directory locking."
    },
    {
      "zh": "Jarvis 同步保留观察与结果事件类型，兼容旧队列；队列满时保留未送达和待审核记录，明确拒绝无法接纳的新请求。",
      "en": "Jarvis synchronization preserves observation and result event types and supports older queues; full queues retain undelivered writes and candidates under review, explicitly rejecting new requests that cannot be accepted."
    },
    {
      "zh": "改善 H5 实时消息、工具审批、设备认证和工作进程配置传递，打包时包含完整 Web 资源。",
      "en": "Improved H5 live messages, tool approvals, device authentication, and worker configuration transfer, and included the complete Web assets in packages."
    },
    {
      "zh": "修复任务接收确认和服务状态提示，兼容已有运行记录及工具定义。",
      "en": "Fixed task acknowledgement and service status messages while retaining compatibility with existing run records and tool definitions."
    }
  ],
  "0.4.7": [
    {
      "zh": "新增 H5 手机助理：支持扫码配对、设备管理、实时会话与工具审批，以及 macOS 和 Linux 后台服务。",
      "en": "Added an H5 mobile assistant with QR pairing, device management, live conversations, tool approvals, and background services on macOS and Linux."
    },
    {
      "zh": "支持本地 Ollama 即时回复与任务意图整理，并结合最近对话处理澄清回答。",
      "en": "Added local Ollama instant replies and structured task briefs that use recent dialogue to interpret clarification answers."
    },
    {
      "zh": "Jarvis 事件、候选记忆和会话关闭增加持久化待发送队列及幂等请求标识，失败后可恢复重试，收到确认后才推进状态。",
      "en": "Jarvis events, candidate memories, and session completion use a durable outbox and idempotency keys; failed writes can be retried after restoration, and state advances only after acknowledgement."
    },
    {
      "zh": "执行中的用户补充输入可记录为 Jarvis 观察事件；候选记忆使用 Jarvis 可解析的会话来源。",
      "en": "Mid-run user input is recorded as Jarvis observation events; candidate memories reference sessions that Jarvis can resolve as evidence."
    },
    {
      "zh": "H5 默认端口改为 7332，避免与 Jarvis MCP 冲突；后台服务保留自定义端口并拒绝随机端口。",
      "en": "Changed the default H5 port to 7332 to avoid conflicts with Jarvis MCP; background services preserve custom ports and reject random ports."
    },
    {
      "zh": "修复手机页事件与审批流程、会话工作目录限制、Host 校验和标题转义；网络服务默认保持人工审批。",
      "en": "Fixed mobile event and approval flows, session workspace restrictions, Host validation, and title escaping; network services keep manual approval by default."
    }
  ],
  "0.4.6": [
    {
      "zh": "支持通过 CLI、环境变量或用户配置启用 Jarvis 会话、项目上下文、执行事件和候选记忆；默认关闭，服务不可用时继续独立运行。",
      "en": "Jarvis sessions, project context, execution events, and candidate memories can be enabled through CLI flags, environment variables, or user configuration; integration is off by default and execution continues independently if the service is unavailable."
    },
    {
      "zh": "工具事件仅发送执行标识、工具名称和状态，避免参数、文件内容和输出中的凭据进入记忆；发送的文本增加常见凭据脱敏。",
      "en": "Tool events send only execution identifiers, tool names, and statuses to keep credentials in arguments, file contents, and outputs out of memory; outbound text redacts common credential forms."
    },
    {
      "zh": "持久化每次运行的 Jarvis 会话、上下文和已记录事件，恢复运行时保留上下文并避免重放已记录事件。",
      "en": "Persist each run's Jarvis session, context, and recorded events so restored runs retain context without replaying recorded events."
    },
    {
      "zh": "事件记录不再依赖界面消费，结束前等待本次运行的写入完成；并行运行不会互相等待记忆写入。",
      "en": "Event recording no longer depends on UI consumption, and completion waits for the current run's writes; concurrent runs do not wait for each other's memory writes."
    },
    {
      "zh": "候选记忆标题统一为单行并限制长度；仅验收通过的任务可记录为成功，工作区配置不能启用 Jarvis 或覆盖其端点。",
      "en": "Candidate memory titles are normalized to a single line and capped in length; only accepted tasks are recorded as successful, and workspace configuration cannot enable Jarvis or override its endpoint."
    }
  ],
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
