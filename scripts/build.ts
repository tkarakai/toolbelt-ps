import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BunPlugin } from 'bun';
const out = resolve('dist/package');
rmSync(out,{recursive:true,force:true}); mkdirSync(`${out}/payload/bin`,{recursive:true});
const stub: BunPlugin = {name:'local devtools stub',setup(b){b.onResolve({filter:/^react-devtools-core$/},()=>({path:resolve('src/running/src/stubs/react-devtools-core.ts')}));}};
async function bundle(entry:string,dest:string,minify=false){
 const result=await Bun.build({entrypoints:[entry],target:'bun',minify,plugins:[stub],define:{__BUILT_WITH_BUN__:JSON.stringify(Bun.version)}});
 if(!result.success) throw new AggregateError(result.logs,`Could not build ${entry}`);
 await Bun.write(dest,result.outputs[0]!);
}
await bundle('src/index.ts',`${out}/index.js`);
await bundle('src/running/src/serve.ts',`${out}/payload/running-core.js`);
await bundle('src/running/src/main.tsx',`${out}/payload/bin/running`,true);
const bin=`${out}/payload/bin/running`; const text=readFileSync(bin,'utf8');
if(!text.startsWith('#!'))writeFileSync(bin,`#!/usr/bin/env bun\n${text}`); chmodSync(bin,0o755);
cpSync('assets',`${out}/assets`,{recursive:true});
const manifest=JSON.parse(readFileSync('toolbelt.json','utf8'));manifest.entry='index.js';
writeFileSync(`${out}/toolbelt.json`,JSON.stringify(manifest,null,2)+'\n');
writeFileSync(`${out}/NOTICE`,readFileSync('docs/running-provenance-original.md','utf8'));
console.log(out);
