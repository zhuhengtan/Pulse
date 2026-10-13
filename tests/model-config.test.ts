import { describe, expect, it } from 'vitest'
import { modelSelectionId, normalizeModelConfig, resolveModelReference } from '../packages/server/src/model-config.js'

describe('provider-owned model catalog', () => {
  it('keeps same-named models distinct and resolves qualified references', () => {
    const config = normalizeModelConfig({
      providers: {
        cloud: { provider: 'deepseek', models: { chat: { displayName: 'chat', modelCode: 'deepseek-chat' } } },
        local: { provider: 'ollama', models: { chat: { displayName: 'chat', modelCode: 'qwen3.5:4b' } } },
      },
    })

    expect(modelSelectionId('cloud', 'chat')).toBe('cloud/chat')
    expect(resolveModelReference(config, 'cloud/chat')).toBe('cloud/chat')
    expect(resolveModelReference(config, 'local/chat')).toBe('local/chat')
    expect(() => resolveModelReference(config, 'chat')).toThrow('AMBIGUOUS_MODEL_REFERENCE:chat:cloud/chat,local/chat')
  })

  it('migrates flat catalog references and inline Ollama feature models without changing the input', () => {
    const original = {
      providers: { deepseek: { provider: 'deepseek', baseURL: 'https://api.deepseek.com' } },
      models: { 'deepseek-flash': { displayName: 'deepseek-flash', provider: 'deepseek', modelCode: 'deepseek-flash' } },
      activeModel: 'deepseek-flash',
      assistantModel: 'deepseek-flash',
      taskRouting: { plan: ['deepseek-flash'] },
      frontModel: { enabled: true, provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434' },
      approvalReview: { provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434' },
    }
    const migrated = normalizeModelConfig(original)

    expect(migrated).not.toHaveProperty('models')
    expect(migrated.activeModel).toBe('deepseek/deepseek-flash')
    expect(migrated.assistantModel).toBe('deepseek/deepseek-flash')
    expect(migrated.taskRouting.plan).toEqual(['deepseek/deepseek-flash'])
    expect(migrated.providers.ollama.models['qwen3.5:4b'].modelCode).toBe('qwen3.5:4b')
    expect(migrated.frontModel).toEqual({ enabled: true, model: 'ollama/qwen3.5:4b' })
    expect(migrated.approvalReview).toEqual({ model: 'ollama/qwen3.5:4b' })
    expect(original.models['deepseek-flash'].provider).toBe('deepseek')
  })
})
