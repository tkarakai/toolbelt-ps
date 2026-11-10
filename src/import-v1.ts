import {cpSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,relative,join} from 'node:path';
/** Explicit DEV-only import of already copied v1 data into an empty temp profile. */
export function importCopiedV1(snapshot:string,profile:string){
 const source=realpathSync(snapshot), target=realpathSync(profile), temp=realpathSync(tmpdir());
 const within=relative(temp,target);
 if(!within||within.startsWith('..')||isAbsolute(within))throw Error('DEV import target must be a disposable temporary profile');
 const dest=join(target,'data/processes');
 if(existsSync(dest))throw Error('DEV import refuses existing Processes data');
 // Caller makes the source copy; this helper never discovers the actual v1 installation.
 mkdirSync(dest,{recursive:true});
 for(const name of ['prefs.json','running','commands.log'])if(existsSync(join(source,name)))cpSync(join(source,name),join(dest,name),{recursive:true,errorOnExist:true,force:false});
 return dest;
}
