'use strict';
// Compatibility entry point. Both GUI and command-line installation create
// a persistent user copy instead of referencing the extracted download.
const path = require('node:path');
const { installBundle } = require('./install-gui.cjs');
async function main(root = path.resolve(__dirname, '../..')) {
  const installed = await installBundle(root);
  console.log('Приложение установлено для текущего пользователя: ' + installed.currentRoot);
  console.log('Ярлык добавлен в меню приложений: ' + installed.menuFile);
  if (installed.desktopFile) console.log('Ярлык добавлен на рабочий стол: ' + installed.desktopFile);
}
module.exports = { main };
if (require.main === module) main(process.argv[2]).catch(error => { console.error('Не удалось установить приложение: ' + error.message); process.exitCode = 1; });
