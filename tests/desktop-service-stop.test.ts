import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

// Exercise the actual launcher closures with fake Electron/process I/O. Nothing
// is started or signalled; both sides of the lifecycle race run in one scope.
const source = readFileSync(new URL('../packages/desktop/src/main.mjs', import.meta.url), 'utf8')
const stop = source.slice(source.indexOf('    async function stopOwnedService()'), source.indexOf('    async function openCli()'))
const begin = source.indexOf('        const serviceMonitor = setInterval(async () => {')
const monitor = source.slice(begin, source.indexOf('        serviceMonitor.unref();', begin))
function fixture() {
  return new Function(`
    let serviceStoppedByUser=false, setupPending, base='http://original', serviceError='', ownedPid=1;
    let backendInfo={pid:1}, monitorBusy=false, callback, prepares=0, first=true, signals=0;
    let resolveProbe, rejectProbe, resolveSetup;
    const probe=new Promise((resolve,reject)=>{resolveProbe=resolve;rejectProbe=reject});
    const descriptor={pid:1,port:1}, directory='/unused', app={isQuitting:false};
    const readFile=async()=>JSON.stringify(descriptor), join=(...x)=>x.join('/');
    const isOwnedService=()=>true, dialog={showMessageBox:async()=>({response:1})};
    const ownershipFile=()=>'/unused', rm=async()=>{}, updateTray=()=>{};
    const chat={close(){}}, browserHost={close(){}}, notifications={sync:async()=>{}};
    const process={kill(_pid,signal){if(signal===0)throw Object.assign(Error('gone'),{code:'ESRCH'});signals++}};
    const http=async()=>{if(first){first=false;return probe}return{ok:true,json:async()=>({serverPid:1})}};
    const serviceMonitorAction=s=>s.stoppedByUser||s.setupPending?'wait':s.base?'probe':'reconnect';
    const prepareDesktop=async()=>{prepares++;serviceStoppedByUser=false;base='http://replacement'};
    const setInterval=fn=>{callback=fn;return{}};
    ${stop}
    ${monitor}
    return {stop:stopOwnedService, poll:()=>callback(),
      reject:()=>rejectProbe(Error('connection closed')),
      resolve:()=>resolveProbe({ok:true,json:async()=>({serverPid:2})}),
      setup:()=>{setupPending=new Promise(resolve=>{resolveSetup=()=>{setupPending=undefined;resolve()}})},
      finishSetup:()=>resolveSetup(),
      state:()=>({serviceStoppedByUser,prepares,base,signals,monitorBusy})};
  `)()
}

it.each(['failed', 'changed'] as const)('ignores a %s in-flight probe after the user stops the service', async outcome => {
  const app = fixture(), polling = app.poll()
  expect(await app.stop()).toBe(true)
  if (outcome === 'failed') app.reject(); else app.resolve()
  await polling
  expect(app.state()).toEqual({serviceStoppedByUser:true,prepares:0,base:'',signals:1,monitorBusy:false})
  await app.poll()
  expect(app.state().prepares).toBe(0)
})

it('waits for setup already in flight before signalling the owned service', async () => {
  const app = fixture()
  // Consume the first probe so stop's identity check uses the ordinary reply.
  const polling = app.poll(); app.resolve(); await polling
  app.setup()
  const stopping = app.stop()
  await vi.waitFor(() => expect(app.state().serviceStoppedByUser).toBe(true))
  expect(app.state().signals).toBe(0)
  app.finishSetup(); expect(await stopping).toBe(true)
  expect(app.state().signals).toBe(1)
})
