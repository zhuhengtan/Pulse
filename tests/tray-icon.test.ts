import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
function alpha(png: Buffer) {
 let offset=8,w=0,h=0,channels=0; const chunks: Buffer[]=[]
 while(offset<png.length){const n=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+n);if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);expect(data[8]).toBe(8);expect(data[9]).toBe(6);channels=4}if(type==='IDAT')chunks.push(data);offset+=n+12}
 const raw=inflateSync(Buffer.concat(chunks)), stride=w*channels, rows: number[][]=[]
 let at=0
 const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
 for(let y=0;y<h;y++){const filter=raw[at++]!,row:number[]=[];for(let x=0;x<stride;x++){const a=x>=4?row[x-4]!:0,b=rows[y-1]?.[x]??0,c=x>=4?(rows[y-1]?.[x-4]??0):0;row[x]=(raw[at++]!+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255}rows.push(row)}
 return {w,h,values:rows.flatMap(row=>row.filter((_,i)=>i%4===3))}
}
it.each([['trayTemplate.png',18],['trayTemplate@2x.png',36]] as const)('uses a transparent Pulse silhouette at the correct scale: %s',async(name,size)=>{
 const image=alpha(await readFile(new URL('../packages/desktop/src/assets/'+name,import.meta.url)))
 expect([image.w,image.h]).toEqual([size,size]);expect(Math.min(...image.values)).toBe(0);expect(Math.max(...image.values)).toBe(255)
 // The inner stroke is a separate component; dropping it produced a visibly incomplete P.
 const remaining=new Set(image.values.flatMap((a,i)=>a>=128?[i]:[])), components:number[]=[]
 while(remaining.size){const first=remaining.values().next().value!;remaining.delete(first);const queue=[first];for(let at=0;at<queue.length;at++){const p=queue[at]!,x=p%size,y=Math.floor(p/size);for(const next of [x>0?p-1:-1,x+1<size?p+1:-1,y>0?p-size:-1,y+1<size?p+size:-1])if(remaining.delete(next))queue.push(next)}components.push(queue.length)}
 expect(components.filter(n=>n>=size)).toHaveLength(2)
 const coverage=image.values.filter(a=>a>127).length/image.values.length
 expect(coverage).toBeGreaterThan(.2);expect(coverage).toBeLessThan(.45)
 const at=(x:number,y:number)=>image.values[Math.floor(y*size/36)*size+Math.floor(x*size/36)]!
 // Inner stroke, outer top and stem survive; the two characteristic gaps stay transparent.
 for(const [x,y] of [[12,14],[12,5],[7,28]])expect(at(x!,y!)).toBeGreaterThan(127)
 for(const [x,y] of [[12,10],[9,21]])expect(at(x!,y!)).toBeLessThan(128)
 for(let i=0;i<size;i++)for(const edge of [i,(size-1)*size+i,i*size,i*size+size-1])expect(image.values[edge]).toBe(0)
})
