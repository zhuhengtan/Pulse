# 本轮问题与优化方案

## 已确认的业务缺陷（候选交付）

### P1 R6-01：复合引用没有实现，且provider身份混淆

需求指定`providerId/modelId`字符串。生成模块只把字符串视为裸名称，测试却用`{providerId,modelId}`对象替代，导致`ds/flash`、`local/fixture`均报Configured Pulse model not found。即便对象和旧flat路径成功，返回providerCode为`deepseek`族名，而配置profile ID为`ds`。独立语义探针前三项均失败。

优化：需求中涉及接口、参数与返回身份的例子先形成不可替换的契约探针；复用项目现有normalize/resolve逻辑；新增`providerId != provider family`、多个同名模型、字符串复合引用。不能用对象API替代CLI字符串的验收。

### P1 R6-02：只修改主调用路径，遗漏报告引用

runner删除maxCalls变量后，报告175行仍引用maxCalls，并残留“--max-calls只是turns别名、非调用硬上限”的旧文本。`node --check`只查语法，因此通过；独立legacy flat真实入口已运行假CLI并评分，随后在报告构建时报ReferenceError。

优化：变量替换后搜索所有旧引用，至少跑一次全入口到report落盘的离线执行；对预算报告的字段与CLI传参同时断言。保留失败结果，不用语法检查代替运行验收。

### P2 R6-03：入口吞掉冲突预算别名

helper会拒绝maxModelCalls和maxCalls冲突，但runner仅将二者折叠为一个Number值，未把冲突传给helper。独立探针传7和11时，输入已到达假CLI；README关于冲突会在运行前失败的承诺不成立。

优化：分别解析两个原始参数并统一校验冲突，再派发；覆盖别名冲突、重复参数、缺失值及非法数字。对“没有CLI调用”的负向证据进行断言。

## 已确认的执行流程缺口

### P1 R6-04：无害调查失败污染成功证据，直接阻塞终态

空初始化仓库中的`git log --oneline -1`返回128，内容是“branch has no commits yet”。最终模型用它证明未提交，并将result-285连同成功测试引用。Host只接受退出0的普通shell成功证据，因此selected.every校验失败，立即把stage-4标blocked；并非缺少真正通过的test/check回执。result-282/293测试及result-283/294语法均为0。

优化：将必需测试、预期负例、状态观察明确区分；非零状态观察不能作为“成功检查”引用，更不能让失败测试变通过。对不合格附带引用给一次有界报告纠正，指出具体ref和原因；必要时补充安全的状态观察，禁止等价重试。不得全局允许任意非零退出。

### P2 R6-05：纯核查kind被模型标edit并保留

stage-4只需运行检查并记录证据，模型标edit；Host在kind=edit时直接接受，中文“集成核查”也以“集成”开头，易被当作编辑动词。它先说明无需改文件，后又新增INTEGRATION-CHECK.md，额外消耗执行轮次。不能断言每次文档写入均由kind导致，但当前分类与任务意图不符。

优化：基于需求动作和明确文件交付验证kind，覆盖“集成核查/集成验证/确认接入结果”等纯验证文字；仅需要工具回执的verify阶段允许复用成功证据。明确要记录文档时才要求文件交付。

### P2 R6-06：稳定身份已修好，派发层仍重复读取/检查

未改源码的`node --check`执行3次、`node --test`2次，运行当前真实toolEvidenceHash后各自都只有一个身份。稳定去重实现有效，但没有消除模型重新提出相同检查。接入阶段#16–24仍读取多个已看窗口，在被指出缺少实际修改后才进入编辑。最终阶段也重新派发已有检查。

优化：把有效检查作为明确的可复用产物传给新阶段，命中时直接进入验收，不造新回执；跨阶段摘要必须携带已读窗口、文件hash、未读offset和实际修改状态。已被Host拦截的重复工具提议也应参与无进展模型调用统计。用真实连续轨迹验证两次纠偏/四次停止，不仅验证纯函数哈希；合法分页和新版本继续放行。

## 验收边界与剩余限制

独立验收器本轮正常准备编译依赖、执行实际评分器并发现候选运行错误；没有把假CLI当作真实provider验收。11项中的“接入runner”与“文档修复”只做结构判断，即使为true也不能代表语义一致；完整判断还需要入口探针和人工复核。本轮自动75分不作为任务通过，人工结果为partial。

以上问题本轮均已保存证据，未改候选来修饰成绩。后续应先本地补契约和完整入口回归，再决定是否需要新的真实验收。本次唯一真实重跑额度已用完，不自动追加调用。

证据：[独立11项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/grade.json)、[补充9项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/semantic-probes.json)、[稳定重复审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/repeat-audit.json)、[最后阶段诊断](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/diagnostics-current.json)。
