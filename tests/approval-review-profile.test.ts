import {afterEach,expect,it,vi} from 'vitest'
import {approvalReviewProfile} from '../packages/server/src/approval-review-profile.js'
afterEach(()=>vi.unstubAllEnvs())
it('keeps Ollama local and resolves an explicitly selected DeepSeek credential at execution time',()=>{
 vi.stubEnv('PULSE_REVIEW_TEST_KEY','fixture-secret')
 const local={provider:'ollama' as const,model:'fixture',baseURL:'http://localhost:11434',timeoutMs:30000}
 expect(approvalReviewProfile(local)).toMatchObject({provider:'ollama',baseURL:'http://localhost:11434/v1'})
 expect(()=>approvalReviewProfile({...local,baseURL:'https://remote.invalid'})).toThrow('reviewer_must_be_local')
 const remote={...local,provider:'deepseek' as const,model:'deepseek-flash',baseURL:'https://api.deepseek.com',apiKeyEnv:'PULSE_REVIEW_TEST_KEY'}
 expect(approvalReviewProfile(remote)).toMatchObject({provider:'deepseek',apiKey:'fixture-secret',baseURL:'https://api.deepseek.com/v1'})
 expect(JSON.stringify(remote)).not.toContain('fixture-secret')
 expect(()=>approvalReviewProfile({...remote,apiKeyEnv:'PULSE_REVIEW_MISSING_KEY'})).toThrow('reviewer_credential_missing')
 expect(()=>approvalReviewProfile({...remote,baseURL:'http://remote.invalid'})).toThrow('reviewer_endpoint_invalid')
 expect(()=>approvalReviewProfile({...remote,baseURL:'https://user:pass@api.deepseek.com'})).toThrow('reviewer_endpoint_invalid')
})
