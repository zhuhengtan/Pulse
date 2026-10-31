import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooksCommand } from '../packages/cli/src/hooks.js';
it('loads disabled immutable versions and requires an explicit trusted hash to enable',async()=>{
 const base=await mkdtemp(join(tmpdir(),'pulse-hook-cli-')), config=join(base,'config.json'), source=join(base,'source');
 const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 try {
  await mkdir(source); await writeFile(config,JSON.stringify({unrelated:{keep:true}}));
  const definition=join(source,'hooks.json'), script=join(source,'hook.cjs');
  await writeFile(script,'process.stdout.write("{}")');
  await writeFile(definition,JSON.stringify({hooks:{PreToolUse:[{matcher:'Read',hooks:[{type:'command',command:[process.execPath,'hook.cjs']}]}]}}));
  await runHooksCommand(['load',definition],config);
  const first=JSON.parse(await readFile(config,'utf8')).hooks;
  expect(first.enabled).toBe(false);
  await expect(runHooksCommand(['enable'],config)).rejects.toThrow('HOOK_EXPLICIT_HASH_REQUIRED');
  await runHooksCommand(['check',first.hash],config);
  await runHooksCommand(['enable',first.hash],config);
  expect(JSON.parse(await readFile(config,'utf8')).hooks.enabled).toBe(true);
  await writeFile(script,'process.stdout.write("{\\"continue\\":false}")');
  await runHooksCommand(['load',definition],config);
  expect(JSON.parse(await readFile(config,'utf8')).hooks.hash).not.toBe(first.hash);
  await runHooksCommand(['enable',first.hash],config);
  expect(JSON.parse(await readFile(config,'utf8')).hooks).toEqual({...first,enabled:true});
  await runHooksCommand(['disable'],config);
  const final=JSON.parse(await readFile(config,'utf8')); expect(final.hooks.enabled).toBe(false);expect(final.unrelated).toEqual({keep:true});
 }finally {stdout.mockRestore();await rm(base,{recursive:true,force:true})}
});
