import {expect,it} from 'vitest'
// @ts-expect-error desktop ESM module
import {formatAXNode} from '../packages/desktop/src/ax-text.mjs'
it('distinguishes checked, unchecked and mixed controls without hiding falsy values',()=>{
 const checkbox=(value:unknown)=>({role:{value:'checkbox'},name:{value:'显示摘要'},properties:[{name:'checked',value:{value}},{name:'disabled',value:{value:false}}]})
 expect(formatAXNode(checkbox('true'),'e1')).toContain('checked="true" disabled=false')
 expect(formatAXNode(checkbox('false'),'e1')).toContain('checked="false"')
 expect(formatAXNode(checkbox('mixed'),'e1')).toContain('checked="mixed"')
 expect(formatAXNode({role:{value:'slider'},value:{value:0}},'e2')).toContain('value=0')
 expect(formatAXNode({role:{value:'textbox'},value:{value:''}},'e3')).toContain('value=')
})
