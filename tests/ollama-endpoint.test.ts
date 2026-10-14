import { afterEach, expect, it, vi } from 'vitest'
import { createProviderAdapter } from '@hunterzhu/pulse-adapters'
import type { LLMRequestProjection } from '@hunterzhu/pulse-runtime'

afterEach(()=>vi.unstubAllGlobals())
it.each([
  [undefined,'http://127.0.0.1:11434/v1/chat/completions'],
  ['http://127.0.0.1:11434','http://127.0.0.1:11434/v1/chat/completions'],
  ['http://127.0.0.1:11434/v1/','http://127.0.0.1:11434/v1/chat/completions'],
  ['https://example.test/ollama/v1','https://example.test/ollama/v1/chat/completions'],
])('uses the Ollama compatible endpoint for base %s',async(baseURL,expected)=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}}))
  vi.stubGlobal('fetch',fetch)
  const request:LLMRequestProjection={contextSpec:{globalSnapshotVersion:0,laneSnapshotVersion:0,resultRefs:[],eventIds:[],toolSetId:'none',instruction:'Reply OK',privacy:'local_only',privacyRefs:[]},blocks:[{kind:'instruction',content:'Reply OK'}],prefixHash:'p',projectionHash:'q',builderVersion:'1',policyVersion:'1',toolSetVersion:'1',privacy:'local_only',privacyRefs:[]}
  const adapter=createProviderAdapter({provider:'ollama',defaultModel:'qwen3.5:4b',...(baseURL?{baseURL}:{})})
  expect((await adapter.executeAttempt({request,signal:new AbortController().signal})).text).toBe('OK')
  expect(fetch.mock.calls[0]?.[0]).toBe(expected)
})
