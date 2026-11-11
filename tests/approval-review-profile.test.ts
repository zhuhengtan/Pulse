import {afterEach,expect,it,vi} from 'vitest'
import {approvalReviewProfile} from '../packages/server/src/approval-review-profile.js'
afterEach(()=>vi.unstubAllEnvs())
it('uses the selected connection and resolves an explicitly selected DeepSeek credential at execution time',()=>{
 vi.stubEnv('PULSE_REVIEW_TEST_KEY','fixture-secret')
 const local={provider:'ollama' as const,model:'fixture',baseURL:'http://localhost:11434',timeoutMs:30000}
 expect(approvalReviewProfile(local)).toMatchObject({provider:'ollama',baseURL:'http://localhost:11434'})
 expect(approvalReviewProfile({...local,baseURL:'https://remote.invalid'})).toMatchObject({baseURL:'https://remote.invalid'})
 const remote={...local,provider:'deepseek' as const,model:'deepseek-flash',baseURL:'https://api.deepseek.com',apiKeyEnv:'PULSE_REVIEW_TEST_KEY'}
 expect(approvalReviewProfile(remote)).toMatchObject({provider:'deepseek',apiKey:'fixture-secret',baseURL:'https://api.deepseek.com'})
 expect(JSON.stringify(remote)).not.toContain('fixture-secret')
 expect(()=>approvalReviewProfile({...remote,apiKeyEnv:'PULSE_REVIEW_MISSING_KEY'})).toThrow('reviewer_credential_missing')
 expect(()=>approvalReviewProfile({...remote,baseURL:'http://remote.invalid'})).toThrow('reviewer_endpoint_invalid')
 expect(()=>approvalReviewProfile({...remote,baseURL:'https://user:pass@api.deepseek.com'})).toThrow('reviewer_endpoint_invalid')
})
it('preserves custom API paths, Responses transport and the selected model limits',()=>{
 const config={provider:'openai-compatible',apiMode:'responses' as const,responsesTransport:'websocket' as const,model:'custom-review',baseURL:'https://proxy.example/api',apiKey:'fixture-only',maxContextTokens:200000,maxOutputTokens:8192,reasoningEffort:'low' as const,timeoutMs:30000}
 const profile=approvalReviewProfile(config)
 const {model,timeoutMs:_timeout,...connection}=config
 expect(profile).toEqual({...connection,defaultModel:model})
 expect(approvalReviewProfile({provider:'anthropic',model:'claude-review',baseURL:'https://proxy.example/anthropic',timeoutMs:30000})).toMatchObject({provider:'anthropic',baseURL:'https://proxy.example/anthropic'})
 expect(approvalReviewProfile({provider:'ollama-remote',model:'review',baseURL:'http://192.168.1.5:11434/v1',timeoutMs:30000})).toMatchObject({provider:'ollama-remote'})
 expect(()=>approvalReviewProfile({provider:'openai',model:'review',baseURL:'invalid',timeoutMs:30000})).toThrow('reviewer_endpoint_invalid')
})

it('resolves the default DeepSeek reviewer environment without borrowing worker credentials', () => {
 vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-default-review-key')
 const config = { provider: 'deepseek', model: 'deepseek-flash', timeoutMs: 30000 }
 expect(approvalReviewProfile(config)).toMatchObject({ provider: 'deepseek', defaultModel: 'deepseek-flash', apiKey: 'fixture-default-review-key' })
 expect(config).not.toHaveProperty('apiKey')
})
