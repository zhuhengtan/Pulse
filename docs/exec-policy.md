# 命令策略与记住授权

`execPolicy` 同时约束 `shell.exec` 与 `shell.start`。命令仍由 `command` 和独立的 `args` 构成，不增加 shell 字符串执行。未配置规则时沿用现有审批流程。

## 决策与作用域

| 情况 | 行为 |
| --- | --- |
| 任意匹配的 `forbidden` | 拒绝，人工批准、AI、缓存和记住授权均不能覆盖 |
| 无禁止，但存在 `prompt` | 每次人工确认，禁用“记住”；AI 不可代替 |
| 无上述限制且匹配可信 `allow` | 免重复审批，仍执行原有只读、计划确认、工具限制、路径、网络、SRT、取消、进程与预算检查 |
| 未命中 | 现有审批模式与有界验证流程 |

“本次任务记住”限当前 Conversation、Run 和工作区内的匹配工作目录，适用于这个运行的各 Lane；结束、取消或重启后失效。不会跨任务、跨项目或转移到另一 Host。永久授权仅在当前受信宿主配置内记录，仍绑定实际程序版本和工作目录，可在设置页删除相应规则撤销。策略更改使旧的临时授权与过时回复失效。

记住按钮只保存当时的完整 argv，例如记住 `git status --short` 不会允许不带 `--short` 的 `git status`，记住 `git log -1` 不会允许任意 `git log`，记住 `git diff --stat` 也不会允许 `git diff` 或 `git diff --cached`。没有上界的 `git log` 不提供记住。已记住的 `git status`、`git diff` 和有界 `git log` 在普通仓库和链接工作区执行时都会关闭仓库的 fsmonitor、hook、clean/process filter、external diff、textconv 和 pager，且不因此增加文件系统或网络权限。管理员编写的、没有 binding 的前缀规则仍按前缀匹配。`pnpm test`、解释器脚本、危险选项等不能通过此按钮获得授权。

## 受信配置

```json
{
  "execPolicy": {
    "hostExecutables": { "git": ["/usr/bin/git"] },
    "rules": [
      {
        "id": "git-status",
        "pattern": ["git", "status"],
        "decision": "allow",
        "match": [["git", "status", "--short"]],
        "notMatch": [["git", "push"]]
      }
    ]
  }
}
```

路径需为诊断返回的真实路径（macOS 的 Git 工具链可能不是 `/usr/bin/git`）。普通 basename allow 必须有宿主路径登记；未知 `/tmp/git`、工作区同名程序不会继承授权。程序解析、启动前身份复核与实际执行使用同一解析约定，包括 Node、包管理器包装器和平台路径。未知包装器不会获得自动授权。remembered 规则另外绑定版本指纹。

工作区配置只保留 `prompt`/`forbidden`，不能授予 allow 或主机路径映射。各配置来源的限制累积，空数组或同名 ID 不能抹去其他来源的限制。规则中每个参数位置可以使用字符串数组表达候选值；示例必须是 argv 数组，不执行或猜测 shell 引用。非法策略和无效示例会拒绝加载/保存。

## 管理与诊断

设置 → 审批与代审包含规则卡片、程序路径映射和只读测试器，草稿随原有“保存全部/取消修改”流程管理。匹配采用最严结果，排列顺序不表示优先级。原有 API 的本机管理员、同源和版本冲突检查仍适用。永久授权使用 CLI/服务当前实际宿主配置路径（支持 `PULSE_HOME`、`PULSE_CONFIG` 和显式路径），不固定写入默认文件；跨进程写锁、版本检查和原子替换保留其他配置字段。锁忙时明确失败，不强行删除其他写者的锁。

```sh
pulse execpolicy check -- git status --short
pulse execpolicy check --cwd /absolute/workspace -- /absolute/program arg
```

命令只输出评估、配置版本、实际路径及规则来源，不运行待测程序。Web 测试器使用同一后端匹配器。运行中的后台工作进程在执行前重新读取受信配置，因此新禁止/撤销不能被旧的父进程快照绕过；其他继承层的变动须重新加载其宿主配置。

配置保存成功但原交互已取消时，不代表原命令执行成功；永久授权和执行结算是两个结果。现有审批摘要、Effect/ResultRef、WAL、Undo、恢复与持久模型预算契约保持独立。验证使用 Mock Provider、本地夹具和隔离临时配置，不需要真实模型 API。
