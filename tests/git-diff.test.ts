import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGitDiff } from '../packages/server/src/git-diff.js'
const exec=promisify(execFile), roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'pulse-diff-'));roots.push(root);const git=(...args:string[])=>exec('git',args,{cwd:root});await git('init','--quiet');await git('config','user.name','Test');await git('config','user.email','test@localhost');await mkdir(join(root,'nested'));await writeFile(join(root,'main.ts'),'before\n');await writeFile(join(root,'nested/old.ts'),'deleted\n');await git('add','.');await git('commit','--quiet','-m','base');return{root,git}}
it('returns current worktree/index diffs without changing the repository',async()=>{const{root,git}=await fixture();await writeFile(join(root,'main.ts'),'after\n');expect((await readGitDiff(root,'main.ts')).diff).toContain('-before\n+after');await git('add','main.ts');expect((await readGitDiff(root,'main.ts')).diff).toBe('');expect((await readGitDiff(root,'main.ts',true)).diff).toContain('+after');expect((await git('diff','--cached','--name-only')).stdout.trim()).toBe('main.ts')})
it('supports untracked files, deletion of an entire directory, binary files and renames',async()=>{const{root,git}=await fixture();await writeFile(join(root,'新 文件.ts'),'created\n');expect((await readGitDiff(root,'新 文件.ts')).diff).toContain('+created');await rm(join(root,'nested'),{recursive:true});expect((await readGitDiff(root,'nested/old.ts')).diff).toContain('-deleted');await writeFile(join(root,'binary.bin'),Buffer.from([0,1,2,0,255]));expect((await readGitDiff(root,'binary.bin')).diff).toContain('Binary files');await git('mv','main.ts','renamed.ts');expect((await readGitDiff(root,undefined,true)).diff).toContain('rename to renamed.ts')})
it('rejects escaping paths and treats Git pathspec syntax literally',async()=>{const{root}=await fixture();await expect(readGitDiff(root,'../outside')).rejects.toThrow('PATH_OUTSIDE_WORKSPACE');await symlink(tmpdir(),join(root,'escape'));await expect(readGitDiff(root,'escape/secret')).rejects.toThrow('PATH_OUTSIDE_WORKSPACE');await writeFile(join(root,':(glob)*'),'literal\n');expect((await readGitDiff(root,':(glob)*')).diff).toContain('+literal')})
