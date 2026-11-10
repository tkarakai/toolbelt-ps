import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importCopiedV1} from '../src/import-v1';
test('explicit copied v1 import preserves preferences and engine data and refuses overwrite',()=>{
 const root=mkdtempSync(join(tmpdir(),'processes-import-'));
 try{const snapshot=join(root,'snapshot'),profile=join(root,'profile');mkdirSync(join(snapshot,'running'),{recursive:true});mkdirSync(profile);
 const prefs=JSON.stringify({showAll:true,terminal:'terminal',filters:{agent:['codex']}});writeFileSync(join(snapshot,'prefs.json'),prefs);
 writeFileSync(join(snapshot,'running/kept.yaml'),'commands: []\n');writeFileSync(join(snapshot,'running/settings.json'),'{"sort":{"key":"memory","desc":false}}');
 const dest=importCopiedV1(snapshot,profile);expect(readFileSync(join(dest,'prefs.json'),'utf8')).toBe(prefs);expect(readFileSync(join(dest,'running/kept.yaml'),'utf8')).toBe('commands: []\n');
 expect(()=>importCopiedV1(snapshot,profile)).toThrow('existing');
 expect(()=>importCopiedV1(snapshot,process.cwd())).toThrow('temporary');
 }finally{rmSync(root,{recursive:true,force:true});}
});
