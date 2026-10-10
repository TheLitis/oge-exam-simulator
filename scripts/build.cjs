'use strict';
// No npm install and no Python needed. Build on Linux using an official Node binary.
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {execArgument}=require('./desktop-entry.cjs');
(async()=>{
 if(process.platform!=='linux'||process.arch!=='x64') throw new Error('This distribution target is Linux x86_64. Build on that platform.');
 const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist');
 const name='oge-exam-simulator-linux-x64',out=path.join(dist,name);
 await fs.mkdir(dist,{recursive:true});await fs.rm(out,{recursive:true,force:true});
 await fs.mkdir(path.join(out,'app'),{recursive:true});await fs.mkdir(path.join(out,'runtime'),{recursive:true});
 for(const item of ['src','ui','vendor','examples','docs','package.json','README.md','LICENSE','SECURITY.md','CHANGELOG.md'])
  await fs.cp(path.join(root,item),path.join(out,'app',item),{recursive:true});
 await fs.mkdir(path.join(out,'app/scripts'),{recursive:true});
 for(const file of ['install-menu.cjs','install-gui.cjs','desktop-entry.cjs'])
  await fs.copyFile(path.join(root,'scripts',file),path.join(out,'app/scripts',file));
 const node=process.env.NODE_RUNTIME||process.execPath;
 await fs.copyFile(node,path.join(out,'runtime/node'));await fs.chmod(path.join(out,'runtime/node'),0o755);
 const license=process.env.NODE_LICENSE||path.resolve(path.dirname(node),'../LICENSE');
 await fs.copyFile(license,path.join(out,'runtime/NODE-LICENSE.txt'));
 const version=execFileSync(node,['--version'],{encoding:'utf8'}).trim();
 await fs.writeFile(path.join(out,'runtime/VERSION.txt'),`${version}\nLinux x86_64\n`);
 for(const file of ['start.sh','install-menu.sh']){await fs.copyFile(path.join(root,'scripts',file),path.join(out,file));await fs.chmod(path.join(out,file),0o755);}
 const bootstrap='unset NODE_OPTIONS NODE_PATH; test -f "$1" || { kdialog --error "Не удалось найти папку приложения. Распакуйте архив целиком и откройте ярлык снова."; exit 1; }; d=$(dirname -- "$1"); ';
 for(const [file,title,icon,command] of [
  ['Установить.desktop','Установить','system-software-install','exec "$d/runtime/node" "$d/app/scripts/install-gui.cjs" "$d"'],
  ['Запустить.desktop','Запустить','applications-education','exec "$d/start.sh"']
 ]){
  const entry='[Desktop Entry]\nType=Application\nName='+title+'\nExec=/bin/sh -c '+execArgument(bootstrap+command)+' oge-launch %k\nIcon='+icon+'\nTerminal=false\nCategories=Education;\nStartupNotify=false\n';
  await fs.writeFile(path.join(out,file),entry,{mode:0o755});
 }
 await fs.copyFile(path.join(root,'docs/QUICKSTART.txt'),path.join(out,'НАЧАТЬ-ЗДЕСЬ.txt'));
 const sums=[];
 async function walk(dir,relative=''){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   const rel=relative+entry.name,full=path.join(dir,entry.name);
   if(entry.isDirectory())await walk(full,rel+'/');
   else sums.push(createHash('sha256').update(await fs.readFile(full)).digest('hex')+'  '+rel);
  }
 }
 await walk(out);await fs.writeFile(path.join(out,'SHA256SUMS.txt'),sums.sort().join('\n')+'\n');
 const archive=path.join(dist,name+'.tar.gz');
 execFileSync('tar',['-czf',archive,'-C',dist,name],{stdio:'inherit'});
 console.log(`Built ${archive}\nRuntime: ${version}; ${sums.length} files. No Python / system Node installation required.`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
