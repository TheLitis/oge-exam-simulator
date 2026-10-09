'use strict';
const { fsp, path, JSZip, writeZip } = require('../src/io.cjs');
const { ExamService } = require('../src/service.cjs');
const os = require('node:os');
(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-demo-'));
  try {
    const s = new ExamService(root); await s.init();
    await s.updateEditor({ title: 'Демонстрационный вариант · ОГЭ Информатика', code: 'DEMO-2026' });
    const example = path.join(__dirname, '../examples');
    for (const name of await fsp.readdir(path.join(example, 'images'))) await s.addEditorAsset(path.join(example, 'images', name), name, 1, 'image', true);
    const zip = new JSZip(); zip.file('documents/first.txt', 'Учебный файл 1'); zip.file('documents/second.txt', 'Учебный файл 2'); zip.file('documents/nested/third.txt', 'Учебный файл 3'); zip.file('documents/table.csv', 'a,b\n1,2'); zip.file('other/fourth.txt', 'Не входит в documents');
    await fsp.writeFile(path.join(example, 'resources/files-task-12.zip'), await zip.generateAsync({ type: 'nodebuffer' }));
    const names = ['material.txt', 'files-task-12.zip', 'project-description.txt', 'sales.csv'];
    for (let i = 0; i < names.length; i++) await s.addEditorAsset(path.join(example, 'resources', names[i]), names[i], 11 + i, 'resource');
    const exported = await s.exportExam(true); await fsp.copyFile(s.exportFile(exported.id), path.join(example, 'demo.oge'));
    console.log('Демонстрационный пакет создан. Код: DEMO-2026');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
