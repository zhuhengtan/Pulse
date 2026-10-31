import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ResponsesAdapter } from '../packages/adapters/src/providers/responses.js';
import type { LLMRequestProjection, ProviderHistoryMessage } from '@hunterzhu/pulse-runtime';
const { WebSocketServer } = createRequire(resolve('packages/server/package.json'))('ws');
const request: LLMRequestProjection = { contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'local-ws', instruction: 'local', privacy: 'public', privacyRefs: [] }, blocks: [{ kind: 'system', content: 'local mock only' }, { kind: 'instruction', content: 'local' }], prefixHash: 'p', projectionHash: 'p', builderVersion: '1', policyVersion: '1', toolSetVersion: '1', privacy: 'public', privacyRefs: [] };
const message = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
async function fixture(reply?: (socket: any, body: any, index: number) => void) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }), requests: any[] = [], sockets: any[] = [];
    await once(server, 'listening');
    server.on('connection', (socket: any) => { sockets.push(socket); socket.on('message', (bytes: Buffer) => { const body = JSON.parse(bytes.toString()); requests.push(body); if (reply)
        return reply(socket, body, requests.length); const response = { id: 'r' + requests.length, status: 'completed', output: [message('ok' + requests.length)] }; socket.send(JSON.stringify({ type: 'response.created', response: { id: response.id } })); socket.send(JSON.stringify({ type: 'response.completed', response })); }); });
    const config = { provider: 'openai', apiMode: 'responses' as const, responsesTransport: 'websocket' as const, apiKey: 'fake-key', defaultModel: 'local', baseURL: `http://127.0.0.1:${server.address().port}/v1` };
    return { config, requests, sockets, close: async () => { for (const socket of sockets)
            socket.terminate(); await new Promise<void>(done => server.close(() => done())); } };
}
function continued(result: any): LLMRequestProjection {
    const history: ProviderHistoryMessage[] = [{ role: 'assistant', content: result.text, continuationProvider: result.providerContinuation.provider, providerMetadata: result.providerContinuation.metadata }, { role: 'user', content: 'next' }];
    return { ...request, blocks: [...request.blocks, { kind: 'provider_history', content: history as any }], contextSpec: { ...request.contextSpec, providerHistory: history } };
}
const params = (r = request, key = 'lane') => ({ request: r, connectionKey: key, signal: new AbortController().signal });
it('reuses a local socket, sends only a proven append, and switches to full history on changed instructions/tools', async () => {
    const f = await fixture(), adapter = new ResponsesAdapter('test', f.config);
    try {
        const first = await adapter.executeAttempt(params());
        expect(first.text).toBe('ok1');
        await adapter.executeAttempt(params(continued(first)));
        expect(f.sockets).toHaveLength(1);
        expect(f.requests[0].previous_response_id).toBeNull();
        expect(f.requests[1].previous_response_id).toBe('r1');
        expect(f.requests[1].input).toHaveLength(1);
        expect(f.requests[1]).not.toHaveProperty('stream');
        await adapter.executeAttempt(params({ ...request, blocks: [{ kind: 'system', content: 'changed' }, ...request.blocks.slice(1)] }));
        expect(f.requests[2].previous_response_id).toBeNull();
        await adapter.executeAttempt(params(request, 'other-lane'));
        expect(f.sockets).toHaveLength(2);
        expect(f.requests[3].previous_response_id).toBeNull();
    }
    finally {
        adapter.dispose();
        await f.close();
    }
});
it('cold reconstruction and changed credential/model scope never require cached connection state', async () => {
    const f = await fixture(), a = new ResponsesAdapter('test', f.config);
    try {
        const result = await a.executeAttempt(params());
        a.dispose();
        const b = new ResponsesAdapter('test', { ...f.config, apiKey: 'rotated-fake-key' });
        try {
            await b.executeAttempt(params(continued(result)));
            expect(f.requests[1].previous_response_id).toBeNull();
            expect(f.sockets).toHaveLength(2);
        }
        finally {
            b.dispose();
        }
    }
    finally {
        a.dispose();
        await f.close();
    }
});
it.each(['disconnect', 'partial', 'foreign', 'duplicate'])('fails safely on %s without HTTP fallback or executable partial calls', async (kind) => {
    const f = await fixture((socket, body, index) => {
        if (kind === 'disconnect') {
            socket.terminate();
            return;
        }
        const response = { id: 'r' + index, status: kind === 'partial' ? 'incomplete' : 'completed', output: kind === 'partial' ? [{ type: 'function_call', status: 'in_progress', call_id: 'x', name: 'read', arguments: '{' }] : [message('done')] };
        socket.send(JSON.stringify({ type: 'response.created', response: { id: kind === 'foreign' ? 'different' : response.id } }));
        const event = { type: kind === 'partial' ? 'response.incomplete' : 'response.completed', response };
        socket.send(JSON.stringify(event));
        if (kind === 'duplicate')
            socket.send(JSON.stringify(event));
    }), adapter = new ResponsesAdapter('test', f.config);
    try {
        if (kind === 'partial')
            expect(await adapter.executeAttempt(params())).toMatchObject({ finishReason: 'length', toolCalls: [] });
        else if (kind === 'duplicate') {
            expect(await adapter.executeAttempt(params())).toMatchObject({ text: 'done', toolCalls: [] });
            await new Promise(r => setTimeout(r, 30));
        }
        else
            await expect(adapter.executeAttempt(params())).rejects.toMatchObject({ retryable: false });
        expect(f.requests).toHaveLength(1);
    }
    finally {
        adapter.dispose();
        await f.close();
    }
});
it('cancels a sent request and reconnects with a full history rather than replaying it', async () => {
    const f = await fixture(() => { }), adapter = new ResponsesAdapter('test', f.config), controller = new AbortController();
    try {
        const pending = adapter.executeAttempt({ ...params(), signal: controller.signal });
        while (f.requests.length === 0)
            await new Promise(r => setTimeout(r, 5));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_CANCELLED', retryable: false });
        expect(f.requests).toHaveLength(1);
    }
    finally {
        adapter.dispose();
        await f.close();
    }
});
it('rejects a stale terminal arriving during the next request and never resets to an implicit retry',async()=>{
 const f=await fixture((socket,_body,index)=>{
  socket.send(JSON.stringify({type:'response.created',response:{id:'r'+index}}));
  socket.send(JSON.stringify({type:'response.completed',response:{id:'r1',status:'completed',output:[message('old')]}}));
 }),adapter=new ResponsesAdapter('test',f.config);
 try{const first=await adapter.executeAttempt(params());await expect(adapter.executeAttempt(params(continued(first)))).rejects.toMatchObject({retryable:false});expect(f.requests).toHaveLength(2)}finally{adapter.dispose();await f.close()}
});
it('changes model scope away and back without reusing an old incremental baseline',async()=>{
 const f=await fixture(),adapter=new ResponsesAdapter('test',f.config);
 try{const first=await adapter.executeAttempt({...params(),model:'one'});await adapter.executeAttempt({...params(),model:'two'});await adapter.executeAttempt({...params(continued(first)),model:'one'});expect(f.requests.every(r=>r.previous_response_id===null)).toBe(true);expect(f.sockets).toHaveLength(3)}finally{adapter.dispose();await f.close()}
});
it('a tool-schema change forces full history even if visible messages still append',async()=>{
 const f=await fixture(),adapter=new ResponsesAdapter('test',f.config);
 try{const first=await adapter.executeAttempt(params());const r=continued(first);await adapter.executeAttempt(params({...r,blocks:[{kind:'tools',content:[{name:'local_read',description:'local',inputSchema:{type:'object',properties:{path:{type:'string'}}}}]},...r.blocks]}));expect(f.requests[1].previous_response_id).toBeNull();expect(f.requests[1].tools[0].name).toBe('local_read')}finally{adapter.dispose();await f.close()}
});
it('separates simultaneous lanes and releases only a completed auxiliary scope',async()=>{
 const f=await fixture(),adapter=new ResponsesAdapter('test',f.config);
 try{await Promise.all([adapter.executeAttempt(params(request,'parent:agent:lane')),adapter.executeAttempt(params(request,'child:agent:lane'))]);expect(f.sockets).toHaveLength(2);adapter.releaseConnectionScope('child');await new Promise(r=>setTimeout(r,10));expect(f.sockets.filter(s=>s.readyState===1)).toHaveLength(1);await adapter.executeAttempt(params(request,'parent:agent:lane'));expect(f.sockets).toHaveLength(2)}finally{adapter.dispose();await f.close()}
});
it('closes unowned one-shot requests instead of leaving diagnostic sockets alive',async()=>{
 const f=await fixture(),adapter=new ResponsesAdapter('test',f.config);
 try{const {connectionKey:_,...p}=params();const first=await adapter.executeAttempt(p);const deadline=Date.now()+1000;while(f.sockets.some(s=>s.readyState===1)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));expect(f.sockets.every(s=>s.readyState===3)).toBe(true);await adapter.executeAttempt({request:continued(first),signal:p.signal});expect(f.sockets).toHaveLength(2);expect(f.requests[1].previous_response_id).toBeNull()}finally{adapter.dispose();await f.close()}
});
