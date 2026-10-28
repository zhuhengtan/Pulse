import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Bindings decide what a call is. A read counts only when that expression runs.
// An unknown value is unresolved I/O only when it is the source of a file open.
// Content operations on a known handle are not another path. Parse only.
// Comprehension bodies are uncertain unless iteration is proven. Unhandled syntax is unresolved I/O.
const inspect = String.raw`
import ast,json,sys
d=json.loads(sys.argv[1]); tree=ast.parse(d['source']); argv=d['argv']
unknown=False; paths=set(); fnodes={}; UNK=('?',); RET=('ctrl','ret'); JUMP=('ctrl','jump'); MAYBE=('ctrl','maybe')
PURE={'print','len','int','str','float','bool','ord','chr','abs','min','max','sum','any','all','sorted','enumerate','range','zip','map','filter','list','dict','tuple','set','frozenset','reversed','repr','format','isinstance','issubclass','type','round','divmod','pow','bytes','bytearray','id','hash','hex','oct','bin','ascii','callable','iter','next','object','super','slice','property','classmethod','staticmethod','hasattr','getattr','setattr','vars','dir'}
PATH={'open','ZipFile','zipfile.ZipFile','zipfile.is_zipfile','pptx.Presentation','Presentation','xml.etree.ElementTree.parse','xml.etree.ElementTree.iterparse'}
MEMORY={'xml.etree.ElementTree.fromstring','xml.etree.ElementTree.XML','xml.etree.ElementTree.fromstringlist','xml.etree.ElementTree.tostring','xml.etree.ElementTree.Element','xml.etree.ElementTree.SubElement','xml.etree.ElementTree.indent'}
CTOR={'Path','pathlib.Path'}
def is_unk(v): return isinstance(v,tuple) and v[:1]==('?',)
def record(p):
 global unknown
 if isinstance(p,str) and p: paths.add(p)
 else: unknown=True
def mode_of(args,kw):
 mode=args[1] if len(args)>1 else kw.get('mode','r')
 return mode if isinstance(mode,str) else None
def writable(mode): return isinstance(mode,str) and any(c in mode for c in 'wax+')
def call_known(qual,args,kw):
 if qual in CTOR:
  arg=args[0] if args else UNK
  return ('path',arg) if isinstance(arg,str) else ('path',None)
 if qual in PATH:
  if qual in ('zipfile.is_zipfile',) or not writable(mode_of(args,kw) if qual!='pptx.Presentation' and qual!='Presentation' else 'r'):
   if qual in ('pptx.Presentation','Presentation'): record(args[0] if args else UNK); return ('data',)
   if not writable(mode_of(args,kw)): record(args[0] if args else UNK)
  if qual in ('zipfile.ZipFile','ZipFile'): return ('zip',)
  return ('file',)
 if qual in MEMORY or qual.startswith('re.') or qual.startswith('sys.'):
  if qual.endswith('fromstring') or qual.endswith('.XML'): return ('elem',)
  if qual.startswith('re.compile'): return ('regex',)
  if qual.startswith('re.'): return ('match',)
  return UNK
 return None
def content(recv,attr):
 if recv==('zip',):
  if attr=='read': return ('bytes',)
  if attr in ('namelist','infolist'): return ('seq',)
  return ('data',)
 if recv==('file',) and attr in ('read','readline','readlines'): return ('bytes',)
 if recv==('file',): return ('data',)
 if recv==('bytes',) and attr=='decode': return ('str',)
 if recv==('bytes',): return ('data',)
 if recv==('elem',) and attr in ('find','findtext'): return ('elem',)
 if recv==('elem',) and attr in ('findall','iter'): return ('seq',)
 if recv==('elem',) and attr=='get': return ('str',)
 if recv==('elem',): return ('data',)
 if isinstance(recv,tuple) and recv[:1]==('path',): return None
 if isinstance(recv,(list,dict,set,tuple)) or recv in (('seq',),('regex',),('match',),('data',)): return ('data',)
 if isinstance(recv,str):
  if attr in ('isdigit','isupper','islower','isspace'): return getattr(recv,attr)()
  return ('str',)
 if recv==('str',):
  if attr in ('isdigit','isupper','islower','isspace','startswith','endswith'): return UNK
  return ('str',)
 if recv==('num',) or isinstance(recv,(int,float,bool)): return ('num',)
 return None
def resolve(func,env):
 if not isinstance(func,ast.Name): return ('unknown-call',)
 if func.id in env:
  b=env[func.id]
  if isinstance(b,tuple) and b and b[0]=='local': return b
  if isinstance(b,tuple) and b and b[0]=='fn': return b
  if is_unk(b): return ('unknown-call',)
  return ('not-io',)
 if func.id in PATH or func.id in CTOR or func.id in PURE: return ('fn',func.id)
 return ('unknown-call',)
def eval(n,env,depth=0):
 global unknown
 if n is None or depth>32:
  if depth>32: unknown=True
  return UNK
 if isinstance(n,list):
  for i,s in enumerate(n):
   sig=eval(s,env,depth+1)
   if sig==RET or sig==JUMP: return sig
   if sig==MAYBE:
    uncertain(n[i+1:],env,depth+1); return MAYBE
  return UNK
 if isinstance(n,ast.Constant): return n.value
 if isinstance(n,ast.Name): return env.get(n.id,UNK)
 if isinstance(n,ast.List): return [eval(x,env,depth) for x in n.elts]
 if isinstance(n,ast.Tuple):
  for x in n.elts: eval(x,env,depth)
  return ('seq',)
 if isinstance(n,ast.Subscript) and ast.unparse(n.value)=='sys.argv':
  i=eval(n.slice,env,depth)
  return argv[i] if isinstance(i,int) and 0<=i<len(argv) else UNK
 if isinstance(n,ast.Subscript):
  base=eval(n.value,env,depth); eval(n.slice,env,depth)
  if base==('str',) or isinstance(base,str): return ('str',)
  return UNK
 if isinstance(n,ast.Attribute):
  base=eval(n.value,env,depth)
  if isinstance(base,tuple) and base and base[0]=='mod':
   qual=base[1]+'.'+n.attr
   if qual in PATH or qual in MEMORY or qual in CTOR or qual.startswith('re.') or qual.startswith('sys.'): return ('fn',qual)
   return ('mod',qual)
  if base==('elem',) and n.attr in ('text','tail','tag'): return ('str',)
  if content(base,n.attr) is not None: return content(base,n.attr)
  return UNK
 if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id not in env and n.func.id=='len' and len(n.args)==1 and ast.unparse(n.args[0])=='sys.argv':
  return len(argv)
 if isinstance(n,ast.Call): return eval_call(n,env,depth)
 if isinstance(n,ast.IfExp):
  test=eval(n.test,env,depth)
  if test is True: return eval(n.body,env,depth)
  if test is False: return eval(n.orelse,env,depth)
  return uncertain_value(n.body,n.orelse,env,depth)
 if isinstance(n,ast.Compare) and len(n.ops)==1:
  a=eval(n.left,env,depth); b=eval(n.comparators[0],env,depth)
  if is_unk(a) or is_unk(b) or isinstance(a,tuple) or isinstance(b,tuple): return UNK
  op=n.ops[0]
  try:
   if isinstance(op,ast.Gt): return a>b
   if isinstance(op,ast.GtE): return a>=b
   if isinstance(op,ast.Lt): return a<b
   if isinstance(op,ast.LtE): return a<=b
   if isinstance(op,ast.Eq): return a==b
   if isinstance(op,ast.NotEq): return a!=b
   if isinstance(op,ast.Is): return a is b
   if isinstance(op,ast.IsNot): return a is not b
  except TypeError: return UNK
  return UNK
 if isinstance(n,ast.BoolOp): return eval_bool(n,env,depth)
 if isinstance(n,ast.UnaryOp):
  a=eval(n.operand,env,depth)
  if isinstance(n.op,ast.Not) and isinstance(a,bool): return not a
  if isinstance(n.op,ast.USub) and isinstance(a,(int,float)): return -a
  return UNK
 if isinstance(n,ast.BinOp):
  a=eval(n.left,env,depth); b=eval(n.right,env,depth)
  if isinstance(n.op,ast.Add) and isinstance(a,str) and isinstance(b,str): return a+b
  return UNK
 if isinstance(n,(ast.ListComp,ast.SetComp,ast.GeneratorExp,ast.DictComp)): return eval_comp(n,env,depth)
 if isinstance(n,ast.Lambda):
  uncertain(n.body,dict(env),depth+1)
  return ('data',)
 if isinstance(n,ast.NamedExpr):
  v=eval(n.value,env,depth); bind(n.target,v,env); return v
 if isinstance(n,ast.JoinedStr):
  for v in n.values: eval(v,env,depth)
  return ('str',)
 if isinstance(n,ast.FormattedValue):
  eval(n.value,env,depth); return ('str',)
 if isinstance(n,ast.Import):
  for a in n.names: env[a.asname or a.name.split('.')[0]]=('mod',a.name)
  return UNK
 if isinstance(n,ast.ImportFrom) and n.module:
  for a in n.names:
   if a.name=='*': unknown=True; continue
   env[a.asname or a.name]=('fn',n.module+'.'+a.name)
  return UNK
 if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)):
  fnodes[id(n)]=n; env[n.name]=('local',id(n)); return UNK
 if isinstance(n,ast.Assign):
  v=eval(n.value,env,depth)
  for t in n.targets: bind(t,v,env)
  return UNK
 if isinstance(n,ast.AnnAssign) and n.value is not None:
  bind(n.target,eval(n.value,env,depth),env); return UNK
 if isinstance(n,ast.AugAssign):
  eval(n.value,env,depth); bind(n.target,UNK,env); return UNK
 if isinstance(n,ast.If):
  test=eval(n.test,env,depth)
  if test is True: return eval(n.body,env,depth)
  if test is False: return eval(n.orelse,env,depth)
  left=uncertain(n.body,env,depth); right=uncertain(n.orelse,env,depth)
  if left in (RET,JUMP,MAYBE) or right in (RET,JUMP,MAYBE): return MAYBE
  return UNK
 if isinstance(n,ast.While):
  test=eval(n.test,env,depth)
  if test is True:
   sig=eval(n.body,env,depth)
   if sig==RET: return RET
   return UNK
  if test is False: return eval(n.orelse,env,depth)
  left=uncertain(n.body,env,depth); right=uncertain(n.orelse,env,depth)
  if left in (RET,MAYBE) or right in (RET,MAYBE): return MAYBE
  return UNK
 if isinstance(n,ast.For):
  eval(n.iter,env,depth); eval(n.target,env,depth)
  inner=dict(env); bind(n.target,('str',),inner)
  sig=uncertain(n.body,inner,depth); uncertain(n.orelse,env,depth)
  for k,v in inner.items():
   if env.get(k)!=v: env[k]=UNK
  if sig in (RET,MAYBE): return MAYBE
  return UNK
 if isinstance(n,ast.Try):
  sigs=[uncertain(n.body,env,depth)]
  for h in n.handlers: sigs.append(uncertain(h.body,env,depth))
  sigs.append(uncertain(n.orelse,env,depth)); sigs.append(uncertain(n.finalbody,env,depth))
  if any(s in (RET,JUMP,MAYBE) for s in sigs): return MAYBE
  return UNK
 if isinstance(n,ast.With):
  for item in n.items:
   val=eval(item.context_expr,env,depth)
   if item.optional_vars is not None: bind(item.optional_vars,val,env)
  sig=eval(n.body,env,depth)
  if sig in (RET,JUMP,MAYBE): return sig
  return UNK
 if isinstance(n,ast.Expr): return eval(n.value,env,depth)
 if isinstance(n,ast.Assert): return eval(n.test,env,depth)
 if isinstance(n,ast.Return):
  if n.value is not None: eval(n.value,env,depth)
  return RET
 if isinstance(n,ast.Pass): return UNK
 if isinstance(n,(ast.Break,ast.Continue)): return JUMP
 if isinstance(n,ast.ClassDef):
  uncertain(n.body,dict(env),depth+1); return UNK
 kids=list(ast.iter_child_nodes(n))
 if kids: uncertain(kids,env,depth)
 return UNK
def eval_call(n,env,depth):
 global unknown
 args=[eval(a,env,depth) for a in n.args]
 kw={}
 for k in n.keywords:
  if k.arg is None: eval(k.value,env,depth)
  else: kw[k.arg]=eval(k.value,env,depth)
 if isinstance(n.func,ast.Attribute):
  if n.func.attr in ('read_bytes','read_text'):
   base=eval(n.func.value,env,depth)
   got=base if isinstance(base,str) else (base[1] if isinstance(base,tuple) and base[:1]==('path',) and isinstance(base[1],str) else None)
   if isinstance(got,str): record(got); return ('bytes',)
   unknown=True; return UNK
  recv=eval(n.func.value,env,depth)
  if isinstance(recv,tuple) and recv[:1]==('path',) and n.func.attr=='open':
   mode=args[0] if args else kw.get('mode','r')
   if not isinstance(mode,str): unknown=True
   elif not writable(mode): record(recv[1] if isinstance(recv[1],str) else UNK)
   return ('file',)
  if isinstance(recv,tuple) and recv and recv[0]=='mod':
   hit=call_known(recv[1]+'.'+n.func.attr,args,kw)
   if hit is None: unknown=True; return UNK
   return hit
  if isinstance(recv,tuple) and recv and recv[0]=='fn':
   hit=call_known(recv[1],args,kw)
   if hit is None: unknown=True; return UNK
   return hit
  got=content(recv,n.func.attr)
  if got is not None: return got
  unknown=True; return UNK
 ident=resolve(n.func,env)
 if ident==('unknown-call',):
  unknown=True; return UNK
 if ident==('not-io',): return UNK
 if ident[0]=='local':
  node=fnodes.get(ident[1])
  if node is None: unknown=True; return UNK
  local=dict(env)
  for i,p in enumerate(node.args.args): local[p.arg]=args[i] if i<len(args) else UNK
  eval(node.body,local,depth+1); return UNK
 hit=call_known(ident[1],args,kw)
 if ident[1] in PURE: return UNK
 if hit is None: unknown=True; return UNK
 return hit
def eval_bool(n,env,depth):
 vals=n.values
 acc=None
 for i,v in enumerate(vals):
  x=eval(v,env,depth)
  if isinstance(n.op,ast.And) and x is False: return False
  if isinstance(n.op,ast.Or) and x is True: return True
  if not isinstance(x,bool):
   uncertain(vals[i+1:],env,depth); return UNK
  acc=x
 return acc if isinstance(acc,bool) else UNK
def eval_comp(n,env,depth):
 def walk(i,env):
  if i==len(n.generators): return
  g=n.generators[i]
  eval(g.iter,env,depth)
  inner=dict(env); bind(g.target,('str',),inner)
  walk(i+1,inner)
 walk(0,dict(env))
 extra=[]
 for g in n.generators: extra.extend(g.ifs)
 if isinstance(n,ast.DictComp): extra.extend([n.key,n.value])
 else: extra.append(n.elt)
 uncertain(extra,env,depth)
 return ('seq',)
def uncertain_value(a,b,env,depth):
 global unknown
 saved=set(paths); before=unknown
 va=eval(a,dict(env),depth); vb=eval(b,dict(env),depth)
 if paths!=saved or unknown!=before: unknown=True; paths.clear(); paths.update(saved)
 return va if va==vb and not is_unk(va) else UNK
def uncertain(nodes,env,depth):
 global unknown
 saved=set(paths); before=unknown; copy=dict(env)
 sig=eval(nodes,copy,depth)
 if paths!=saved or unknown!=before: unknown=True; paths.clear(); paths.update(saved)
 for k,v in copy.items():
  if env.get(k)!=v: env[k]=UNK
 return sig
def bind(target,val,env):
 if isinstance(target,ast.Name): env[target.id]=val
 elif isinstance(target,(ast.Tuple,ast.List)):
  for elt in target.elts: bind(elt,UNK,env)
eval(tree.body,{'__name__':'__main__' if d.get('entry') else 'imported'})
print(json.dumps({'paths':sorted(paths),'unknown':unknown}))
`

export async function pythonCheckInputs(command: string, source: string, argv: string[], entry = false): Promise<{ paths: string[]; unknown: boolean }> {
  if (Buffer.byteLength(source) > 64 * 1024) return { paths: [], unknown: true }
  try {
    const { stdout } = await promisify(execFile)(command, ['-I', '-c', inspect, JSON.stringify({ source, argv, entry })], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true })
    const result = JSON.parse(stdout)
    return Array.isArray(result.paths) && result.paths.every((p: unknown) => typeof p === 'string') && typeof result.unknown === 'boolean' ? result : { paths: [], unknown: true }
  } catch { return { paths: [], unknown: true } }
}
