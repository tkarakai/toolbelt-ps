import {importCopiedV1} from '../src/import-v1';
const [flag,source,profile]=process.argv.slice(2);
if(flag!=='--copied-v1-data'||!source||!profile)throw Error('Usage: bun scripts/import-v1.ts --copied-v1-data <copied snapshot> <empty temporary profile>');
console.log(importCopiedV1(source,profile));
