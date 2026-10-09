'use strict';
const {readdirSync,statSync}=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..');let count=0;
for(const folder of ['src','ui','scripts','test']){
  for(const name of readdirSync(path.join(root,folder))){
    const file=path.join(root,folder,name);
    if(statSync(file).isFile()&&/\.(cjs|js)$/.test(name)) {execFileSync(process.execPath,['--check',file],{stdio:'inherit'});count++;}
  }
}
console.log(`Syntax OK: ${count} JavaScript files.`);
