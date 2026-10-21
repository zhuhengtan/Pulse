import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { ConversationDatabase } from '../packages/data/src/sqlite.mjs'

it('keeps a committed conversation readable during a separate WAL transaction', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'pulse-conversation-atomic-'))
  const directory=join(cwd,'data'),host=createLocalHost({cwd,dataDir:directory,jarvis:{enabled:false}})
  let writer:ConversationDatabase|undefined,reader:ConversationDatabase|undefined
  try{
    const conversation=await host.createConversation({title:'before'})
    writer=new ConversationDatabase(directory);reader=new ConversationDatabase(directory,true)
    const updated={...writer.get(conversation.id),title:'after'}
    writer.transaction(()=>{
      writer!.db.prepare('UPDATE conversations SET body=? WHERE id=?').run(JSON.stringify(updated),conversation.id)
      expect(reader!.get(conversation.id).title).toBe('before')
    })
    expect((await host.getConversation(conversation.id)).summary.title).toBe('after')
    expect((await host.listConversations()).map(item=>item.id)).toContain(conversation.id)
  }finally{writer?.close();reader?.close();await host.close();await new Promise(resolve=>setTimeout(resolve,1700));await rm(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})
