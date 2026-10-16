# 方法、证据与复现

## 本轮范围

- [首批16例脚本](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/run.mjs)及[原始输出](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/run.log)
- [Host跨会话与失败验收脚本](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/extra.mjs)及[原始输出](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/extra.log)
- [长访谈输入大小复核](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/interview-size.mjs)及[细分数据](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/B08/size-details.json)
- [完整结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/results.json)
- [源码与历史预算保护审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/boundary-simulation-20261015/final-audit.json)

脚本直接使用当前编译版Host/Runtime/文件工具。fetch由进程内固定模拟回复替代；其他调用一律抛OFFLINE_ONLY_NO_NETWORK。没有读取正式模型配置；模拟不需要API凭据，也未向外部服务发送请求或向用户发送真实问题。B18的本地测试进程真实执行并exit1；B04/B14分别在实际索引写入/persist入口注入故障。

B08的wholeEffectBytes包含重复内部表示；明确的inputs.conversation字节数独立记录，不换算tokens，不估计真实费用。

## 复现

为保留本轮记录，先把脚本中的输出目录改为新的隔离目录再运行；不要覆盖原始结果。原始脚本默认指向本轮目录，仅作为复现来源。

```sh
cd /Users/zhuhengtan/projects/Pulse
# 先在脚本副本中改成新的隔离输出目录，再运行副本：
node /absolute/path/to/copied-run.mjs
node /absolute/path/to/copied-extra.mjs
node /absolute/path/to/copied-interview-size.mjs
```

复制时保留或调整到本仓库的绝对模块导入路径；本轮没有把这些故意复现缺陷的探针加入正常通过测试套件，也没有修改产品源码。

## 未覆盖

没有真实DeepSeek、完整交互终端、跨平台、生产网络故障、服务重启或部署；不能推断模型出现这些行为的概率。本轮模拟揭示确定性保护缺口，属于后续修复输入。
