import {$} from 'bun';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parsePackageManifest} from '@toolbelt/sdk/package';
const root=mkdtempSync(join(tmpdir(),'processes-package-'));
try {
 const pkg=join(root,'package'),data=join(root,'data');mkdirSync(pkg);mkdirSync(data);
 await $`tar -xzf artifacts/toolbelt-ps-0.0.1-darwin-arm64.tar.gz -C ${pkg}`;
 const manifest=parsePackageManifest(JSON.parse(readFileSync(join(pkg,'toolbelt.json'),'utf8')));
 const proc=Bun.spawn([process.execPath,join(pkg,'index.js')],{cwd:root,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:root,TOOLBELT_PLUGIN:'processes',TOOLBELT_PLUGIN_VERSION:manifest.version,TOOLBELT_CONFIG_DIR:root,TOOLBELT_DATA_DIR:data,TOOLBELT_PACKAGE_ROOT:pkg},stdin:'pipe',stdout:'pipe',stderr:'inherit',timeout:15000});
 const send=(msg:unknown)=>proc.stdin.write(JSON.stringify(msg)+'\n');
 send({type:'hello',protocol:1});
 let buffer='',ready=false,prepared=false;const rendered=new Set<string>();
 for await(const bytes of proc.stdout){buffer+=new TextDecoder().decode(bytes);let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const msg=JSON.parse(line);
 if(msg.type==='ready'){ready=true;for(const screen of manifest.screens)send({type:'open',surface:`screen:${screen.id}`});send({type:'open',surface:'quick'});}
 if(msg.type==='render'){rendered.add(msg.surface);if(rendered.size===4)send({type:'prepare',reason:'upgrade',requestId:'test'});}
 if(msg.type==='prepared'){if(!msg.ready)throw Error('Prepare unexpectedly deferred');prepared=true;send({type:'shutdown'});proc.stdin.end();}
 }}
 if(await proc.exited!==0||!ready||!prepared||rendered.size!==4)throw Error(`Package contract failed: ${JSON.stringify({ready,prepared,rendered:[...rendered]})}`);
 console.log('Clean package: handshake, ready, all 3 screens + quick view, prepare and shutdown passed.');
}finally{rmSync(root,{recursive:true,force:true});}
