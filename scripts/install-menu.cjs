'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
(async()=>{
 const root=path.resolve(process.argv[2]||path.join(__dirname,'../..'));
 const file=path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local/share'),'applications/oge-exam-simulator.desktop');
 if(/[\r\n]/.test(root))throw new Error('Путь к программе содержит перенос строки. Переместите папку.');
 const quoted='"'+path.join(root,'start.sh').replace(/[%]/g,'%%').replace(/[\\"$`]/g,c=>'\\'+c)+'"';
 const icon=path.join(root,'app/ui/icon.svg').replace(/\\/g,'\\\\');
 const contents=`[Desktop Entry]\nType=Application\nName=Симулятор экзамена ОГЭ\nComment=Информатика: 16 заданий, 150 минут\nExec=${quoted}\nIcon=${icon}\nTerminal=false\nCategories=Education;\nStartupNotify=false\n`;
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents,{mode:0o644});
 console.log('Ярлык добавлен в меню приложений: '+file+'\nНе перемещайте папку программы после установки ярлыка.');
})().catch(e=>{console.error('Не удалось создать ярлык: '+e.message);process.exitCode=1;});
