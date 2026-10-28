import type { DiscoveredModel, ProviderPreset, ProviderVariant } from './types.js'

const version = '2026-10-28'
const model = (modelCode: string): DiscoveredModel => ({ modelCode, displayName: modelCode, imageInput: 'unknown', tools: 'unknown', structuredOutput: 'unknown' })
const variant = (id: string, name: string, baseURL: string, provider = 'openai-compatible', catalog?: string[]): ProviderVariant => ({ id, name, baseURL, provider, discovery: catalog ? 'catalog' : provider === 'anthropic' ? 'anthropic' : 'openai', ...(catalog ? { catalog: catalog.map(model) } : {}) })
const preset = (id: string, name: string, keyURL: string, docsURL: string, variants: ProviderVariant[], category: ProviderPreset['category'] = 'official'): ProviderPreset => ({ id, name, keyURL, docsURL, variants, category, catalogVersion: version })

/** Account/plan endpoints are explicit choices. Never fall back between billing products. */
export const providerPresets: ProviderPreset[] = [
  preset('ollama', 'Ollama', 'https://ollama.com/settings/keys', 'https://docs.ollama.com/api/openai-compatibility', [
    { ...variant('local', '本机 Ollama · 无需 Key', 'http://127.0.0.1:11434/v1', 'ollama'), discovery: 'ollama', auth: 'none', editableBaseURL: true, loopbackOnly: true },
    { ...variant('cloud', 'Ollama Cloud · 官方云端', 'https://ollama.com/v1', 'ollama-cloud'), discovery: 'ollama', auth: 'required' },
    { ...variant('remote', '远程自托管 Ollama', '', 'ollama-remote'), discovery: 'ollama', auth: 'optional', editableBaseURL: true },
  ]),
  preset('deepseek', 'DeepSeek', 'https://platform.deepseek.com/api_keys', 'https://api-docs.deepseek.com/api/list-models/', [variant('api', '普通 API', 'https://api.deepseek.com', 'deepseek')]),
  preset('minimax', 'MiniMax', 'https://platform.minimax.cn', 'https://platform.minimax.cn/docs/api-reference/text-openai-api', [
    variant('cn-api', '国内站 · 普通 API', 'https://api.minimax.cn/v1', 'minimax', ['MiniMax-M3.1-Flash', 'MiniMax-M3']),
    variant('cn-plan', '国内站 · M Plan / 编程套餐', 'https://api.minimax.cn/v1', 'minimax', ['MiniMax-M3.1-Flash']),
    variant('global-api', '国际站 · 普通 API', 'https://api.minimax.io/v1', 'minimax', ['MiniMax-M3.1-Flash', 'MiniMax-M3']),
    variant('global-plan', '国际站 · M Plan / 编程套餐', 'https://api.minimax.io/v1', 'minimax', ['MiniMax-M3.1-Flash']),
  ]),
  preset('zhipu', '智谱', 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', 'https://docs.bigmodel.cn/cn/coding-plan/tool/others', [
    variant('api', '普通 API', 'https://open.bigmodel.cn/api/paas/v4', 'zhipu', ['glm-5.3', 'glm-5.3-flash']),
    { ...variant('coding', 'Coding Plan · 待支持', 'https://open.bigmodel.cn/api/coding/paas/v4', 'zhipu'), available: false, unavailableReason: 'Pulse 尚未列入官方支持工具，暂不开放。' },
  ]),
  preset('openai', 'OpenAI', 'https://platform.openai.com/api-keys', 'https://developers.openai.com/api/reference/resources/models/methods/list', [variant('api', '普通 API', 'https://api.openai.com/v1', 'openai')]),
  preset('anthropic', 'Anthropic', 'https://platform.claude.com/settings/keys', 'https://platform.claude.com/docs/en/api/models/list', [variant('api', '普通 API', 'https://api.anthropic.com', 'anthropic')]),
  preset('gemini', 'Gemini', 'https://aistudio.google.com/apikey', 'https://ai.google.dev/gemini-api/docs/openai', [variant('api', 'Google AI Studio API', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini')]),
  preset('bailian', '通义千问 / 百炼', 'https://bailian.console.aliyun.com', 'https://help.aliyun.com/zh/model-studio/getting-started/', [
    variant('cn-api', '国内站 · 普通 API', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'bailian'),
    variant('global-api', '国际站 · 普通 API', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'bailian'),
    variant('coding', 'Coding Plan', 'https://coding.dashscope.aliyuncs.com/v1', 'bailian', ['qwen3.5-plus', 'qwen3-coder-plus']),
  ]),
  preset('volcengine', '火山方舟', 'https://console.volcengine.com/ark', 'https://www.volcengine.com/docs/82379', [
    variant('api', '普通 API', 'https://ark.cn-beijing.volces.com/api/v3', 'volcengine'),
    variant('coding', 'Coding Plan', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'volcengine', ['ark-code-latest']),
  ]),
  preset('moonshot', 'Moonshot / Kimi', 'https://platform.moonshot.cn/console/api-keys', 'https://platform.moonshot.cn/docs', [
    variant('cn-api', '国内站 · 普通 API', 'https://api.moonshot.cn/v1', 'moonshot'),
    variant('global-api', '国际站 · 普通 API', 'https://api.moonshot.ai/v1', 'moonshot'),
  ]),
  preset('siliconflow', 'SiliconFlow / 硅基流动', 'https://cloud.siliconflow.cn/account/ak', 'https://api-docs.siliconflow.cn/docs/api/models-get', [
    variant('cn-api', '国内站', 'https://api.siliconflow.cn/v1', 'siliconflow'),
    variant('global-api', '国际站', 'https://api.siliconflow.com/v1', 'siliconflow'),
  ], 'aggregator'),
  preset('openrouter', 'OpenRouter', 'https://openrouter.ai/settings/keys', 'https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties', [variant('api', '普通 API', 'https://openrouter.ai/api/v1', 'openrouter')], 'aggregator'),
  preset('custom', '自定义 OpenAI 兼容接口', '', '', [variant('custom', '自定义地址', '')], 'custom'),
]

export function resolveProviderVariant(presetId: string, variantId: string): { preset: ProviderPreset; variant: ProviderVariant } {
  const preset = providerPresets.find(item => item.id === presetId)
  const variant = preset?.variants.find(item => item.id === variantId)
  if (!preset || !variant) throw new Error('PROVIDER_PRESET_INVALID')
  if (variant.available === false) throw new Error('PROVIDER_VARIANT_UNAVAILABLE')
  return { preset, variant }
}
