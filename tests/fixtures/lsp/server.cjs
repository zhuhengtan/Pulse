const fs = require('node:fs'), net = require('node:net')
let buffer = Buffer.alloc(0), document, version, pid = process.pid
const send = value => { const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',...value}));process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body])) }
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const size=Number(/Content-Length: (\d+)/.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+size)return;const m=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);handle(m)}})
const range={start:{line:0,character:0},end:{line:0,character:3}}
function symbol(name,children){return {name,kind:children?5:12,range,selectionRange:range,...(children?{children}:{})}}
function handle(m){
 if(m.method==='initialize')return send({id:m.id,result:{capabilities:{diagnosticProvider:{interFileDependencies:false,workspaceDiagnostics:false}}}})
 if(m.method==='textDocument/didOpen'||m.method==='textDocument/didChange'){document=m.params.textDocument.uri;version=m.params.textDocument.version;return}
 if(m.method==='textDocument/documentSymbol'){
  if(process.argv.includes('crash'))return process.exit(1)
  if(process.argv.includes('hang')){const hold=process.argv.find(arg=>arg.startsWith('hold='));if(!hold||fs.existsSync(hold.slice(5)))return}
  if(process.argv.includes('oversize'))return process.stdout.write('Content-Length: 999999999\r\n\r\n')
  if(process.argv.includes('tree'))return send({id:m.id,result:[symbol('Outer',[symbol('Inner',[symbol('Leaf')])])]})
  if(process.argv.includes('wide'))return send({id:m.id,result:[symbol('Root',Array.from({length:120},(_,i)=>symbol('N'+i)))]})
  if(process.argv.includes('deep')){let node=symbol('D10');for(let i=9;i>=0;i--)node=symbol('D'+i,[node]);return send({id:m.id,result:[node]})}
  if(process.argv.includes('flat'))return send({id:m.id,result:[{name:'NamedSymbol',kind:12,location:{uri:document,range}},{name:'OutsideSymbol',kind:13,location:{uri:'file:///etc/passwd',range}},{name:'RemoteSymbol',kind:14,location:{uri:'file://files.example/share/a.ts',range}},symbol('Outer',[symbol('Inner')])]})
  let write='denied';try{fs.writeFileSync('unauthorized.txt','bad');write='allowed'}catch{}
  return send({id:m.id,result:[symbol(`pid=${pid};write=${write};home=${process.env.HOME}`)]})
 }
 if(m.method==='textDocument/definition'||m.method==='textDocument/references')return send({id:m.id,result:[{uri:document,range},{uri:'file:///etc/passwd',range:{}}]})
 if(m.method==='textDocument/diagnostic'){const tracked=process.argv.includes('track')?';pid='+pid:'';return send({id:m.id,result:{kind:'full',items:[{message:'v'+version+tracked,range:{start:{line:0,character:0},end:{line:0,character:1}},severity:2}]}})}
}
