# 内置插件

在“设置 → 内置插件”配置网页搜索、图片生成、视频生成和音频生成。所有插件受“网络 → 允许网络访问”控制，包括本机服务。图片、视频和音频默认关闭；网页搜索保留旧版启用行为。

开启并配置后，Pulse 在助理聊天与工作任务中按需调用，无需逐次审批。只读及计划模式仍禁止生成。关闭后，工具从模型可见目录移除，旧任务也不能开始新调用。保存连接设置从下一次工具调用生效，已提交请求保留原连接快照。

关闭有在途请求的生成插件或总网络访问时，保存会要求选择“停止”“继续完成”或“取消关闭”。这个选择会记在当时已存在的任务上，并在重启后仍然有效。继续完成只允许这些任务用原来的连接等待、查询和取回结果，不能借此发起新调用，也不能重发尚未确认的提交。停止会结束本地等待，并只对已有任务 ID 尽力取消远端。直接把配置文件改成关闭网络不会变成继续完成。`--no-network` 优先于这两项授权，已有请求也不能再访问网络。

`--allow-network` 或 `PULSE_ALLOW_NETWORK=1` 会强制开启。设置页会标明这一覆盖；配置里的关闭不会让插件或 `web.fetch` 停用，直到去掉该强制并重启。主机配置按用户主目录、`PULSE_CONFIG` 和显式配置文件合并，后一层覆盖前一层。插件条目按项覆盖：没有写出 connection 或 modes 时保留更早一层的连接和模式，写出后整段替换，因此取消的音频模式和清除的凭据不会被下层合回。关闭某一项只改启用状态，并保留已保存的地址、模型、模式和工作流；其它插件保持原状。设置页展示这一有效结果和来源；从继承的开启状态关闭并保存，会在当前文件写入明确覆盖，随后的工具目录和执行立即停用。项目工作区不能提供插件地址、凭据或服务商连接字段。每次提交、查询、下载、百炼直连和 Realtime 建连都会即时核对有效许可和原任务授权，不依赖定时器。

## 连接方式

- 引用“模型与服务商”的模型：先为模型设置对应生成用途，再在插件中选择。沿用该服务商的凭据，可覆盖生成 API 地址。编程套餐不能作为媒体生成连接。
- 独立配置：选择协议，填写 API 根地址、模型代码和可选 Key；本机无鉴权服务可不填 Key。可使用独立凭据或环境变量。界面输入的 Key 转入独立凭据文件，配置和备份仅保存引用。

| 协议 | 图片 | 视频 | 语音 | 音乐 | 音效 |
| --- | --- | --- | --- | --- | --- |
| OpenAI | 是 | 是 | Speech 或 Realtime | — | — |
| Google | Gemini / Imagen | Veo | Gemini TTS | Lyria | — |
| 阿里百炼 | Qwen 多模态生成 | Wan | Qwen TTS | — | — |
| 火山方舟 | 是 | 是 | — | — | — |
| MiniMax | 是 | 是 | 是 | 是 | — |
| ElevenLabs | — | — | 是 | 是 | 是 |
| OpenAI 兼容 | Images API | — | Speech API | — | — |
| ComfyUI / 自定义 JSON | 按已部署工作流或服务能力配置 | 同左 | 同左 | 同左 | 同左 |

音频的语音、音乐、音效连接独立配置；只配置需要的模式。选择正确的区域、API 产品、模型与音色。官方 OpenAI 的 `tts-1`、`tts-1-hd` 和 `gpt-4o-mini-tts` 使用 `POST /audio/speech`（该接口计划于 2027-01-06 关闭）。模型名包含 `realtime` 时使用 Realtime WebSocket，当前推荐 `gpt-realtime-2.1-mini`。也可以在连接上显式设置 `speechTransport` 为 `speech` 或 `realtime`。未识别的模型必须显式选择通道。失败不会自动改用另一种计费接口，兼容服务始终走 HTTP Speech API。引用已有服务商时，凭据解析与聊天相同，包括默认环境变量；任务只保存凭据来源，不保存明文密钥。没有配置凭据的独立本地服务不会自动带上云密钥。服务商预设 `custom` 在选择模型时推荐 OpenAI 兼容协议，不是自定义 JSON。选择之后仍可改协议；已保存的协议会保留，解析不会改成另一个计费产品。模型、地址和密钥仍沿用被引用的服务商。

成功的取消请求即使没有响应体也会记为已请求取消。认证失败和其他非成功状态仍按失败报告。OpenAI、Google 和百炼目前没有已确认的取消端点，停止后远端状态为不支持。

本轮不安装服务、节点或模型。ComfyUI 需要已经运行的服务、API 格式工作流，以及提示词、可选模型、可选输入图片与输出节点映射。例如：

~~~json
{
  "prompt": { "node": "6", "input": "text" },
  "model": { "node": "4", "input": "ckpt_name" },
  "image": { "node": "10", "input": "image" },
  "outputNode": "9"
}
~~~

映射必须对应导入工作流的实际节点；音视频输出由对应节点与插件负责。Pulse 不猜测通用工作流。ComfyUI 的全局中断仅在当前唯一运行任务与本次任务 ID 相同时发出。

## 自定义 JSON 服务

地址填写 API 根地址，例如 http://127.0.0.1:8000。请求使用 JSON 与可选 Authorization: Bearer 认证。

~~~http
POST /generate
Content-Type: application/json
~~~

~~~json
{
  "kind": "image",
  "model": "local-model",
  "prompt": "生成提示词",
  "parameters": { "size": "1024x1024" },
  "inputs": [{ "mediaType": "image/png", "dataBase64": "..." }]
}
~~~

kind 为 image、video、speech、music 或 sound；无参考图时 inputs 是空数组。同步完成：

~~~json
{
  "status": "succeeded",
  "outputs": [{ "mediaType": "image/png", "dataBase64": "..." }]
}
~~~

也可返回 outputs 中的 url。异步排队返回 {"status":"queued","id":"task-id"}；运行中返回 {"status":"running","id":"task-id"}。Pulse 使用 GET /jobs/task-id 查询，完成时返回相同 succeeded 协议；失败返回 {"status":"failed"}。停止时尝试 DELETE /jobs/task-id。HTTP 204 或成功的空响应表示已接受取消；401、403 和其他非成功状态表示取消失败。不支持时返回明确 HTTP 错误，不要假装取消成功。

同源自定义结果 URL 必须位于所配置根路径的 /files/ 下，例如 http://127.0.0.1:8000/files/result.png。跨源结果仅允许公网地址且不携带服务密钥。所有生成与下载请求禁止重定向；允许本机服务不放宽普通 web.fetch 的内网限制。网页搜索的自定义协议仍是已有的 query/limit 协议，见 [CLI 配置](cli-config.md)。

## 工具、产物与验证

模型工具为 web.search、image.generate、video.generate、audio.generate。媒体工具接收 prompt、可选 referenceImages 与 parameters；audio.generate 使用 mode=speech|music|sound。参考图仅接受当前工作区内路径或当前聊天可访问的 attachment:ID；第一版支持图片参考/编辑和视频参考图，不支持视频编辑、声音克隆或批量生成。

产物保存在工作区 .pulse-generated/运行ID/任务ID 下，并记录摘要与哈希。设置试生成保存在数据目录的 media-tests 下。单文件最多 128 MiB，参考图最多 20 MiB。支持 PNG/JPEG/WebP、MP4/WebM、WAV/MP3/Ogg/FLAC；会校验实际文件签名。图片可预览，音视频可播放、下载，媒体接口支持 Range。

默认总时限为图片 180 秒、视频 1800 秒、音频 600 秒，最多 3600 秒。远端任务 ID 持久化用于恢复查询；提交结果不明时标记为“无法确认”，不会盲目再次产生付费请求。

“检查插件配置”不访问生成服务。“试生成”使用已保存配置并可能产生费用。真实厂商权限、账单、模型可用性与本地工作流需要用自己的服务验证；协议模拟测试不能替代真实生成验收。
