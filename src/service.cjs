'use strict';
const { performance } = require('node:perf_hooks');
const { fs, fsp, path, crypto, LIMITS, UserError, check, mkdir, json, readJson, inside, safeName, hashFile, boundedCopy, extractPackage, writeZip, rasterMime } = require('./io.cjs');
const M = require('./model.cjs');
const { migrateLegacyResults } = require('./results.cjs');
const { version } = require('../package.json');
const G = require('./grading.cjs');
const CodeRunner = require('./code-runner.cjs');
const R = require('./review.cjs');
const ResultProtection = require('./result-protection.cjs');
const ResultStorage = require('./result-storage.cjs');
const { TeacherProtection, publicEditor, isProtectedProject, readLegacyPackage } = require('./teacher.cjs');
const clone = value => structuredClone(value);
const iso = ms => new Date(ms).toISOString();
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const csv = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, x => "'" + x).replace(/"/g, '""') + '"';

class ExamService {
  constructor(root, { now = Date.now, monotonic = () => performance.now(), resultsRoot, codeRunner = CodeRunner, allowLegacyResults = false } = {}) {
    this.root = path.resolve(root); this.now = now; this.monotonic = monotonic;
    this.resultsRoot = path.resolve(resultsRoot || this.dir('results'));
    this.config = {}; this.editor = null; this.exam = null; this.attempt = null;
    this.lastCheckpoint = 0; this.nextActivationAt = 0; this.badCodes = 0;
    this.lastError = null; this.recovered = false;
    this.codeRunner = codeRunner; this.checking = null;
    // Historical fixtures and migration can still read the original ZIP format.
    // The desktop HTTP entry point never enables unprotected new attempts.
    this.allowLegacyResults = allowLegacyResults;
    this.teacherTemporaries = new Set();
    this.teacher = new TeacherProtection(this.dir('teacher'), { monotonic: this.monotonic, onLock: () => {
      this.editor = publicEditor(this.editor); this.clearTeacherTemporaries();
    } });
  }
  dir(...parts) { return path.join(this.root, ...parts); }
  attemptDir() { return this.dir('sessions', this.attempt.id); }
  async init() {
    for (const p of ['', 'editor/assets', 'exams', 'sessions', 'exports', 'incoming', 'reviews']) await mkdir(this.dir(p));
    this.checking = await this.codeRunner.capabilities();
    try { await mkdir(this.resultsRoot); }
    catch { this.lastError = 'Не удалось открыть папку результатов. Сеансы сохранены; проверьте доступ к папке Документы.'; }
    // Incoming uploads are never submitted answers and are safe to discard after a restart.
    for (const n of await fsp.readdir(this.dir('incoming'))) await fsp.rm(this.dir('incoming', n), { force: true });
    try { this.config = await readJson(this.dir('config.json'), true); } catch (e) { if (e.code !== 'ENOENT') this.lastError = 'Настройки повреждены; выполнен поиск сохранённого сеанса.'; }
    let savedEditor, backupEditor;
    try { savedEditor = await readJson(this.dir('editor/manifest.json')); } catch {}
    try { backupEditor = await readJson(this.dir('editor/manifest.json.bak')); } catch {}
    await this.teacher.init({ required: this.config.teacherProtection === 1 || savedEditor?.teacherProtected === true || backupEditor?.teacherProtected === true });
    await this.cleanTeacherRuntime();
    let editorValid = true;
    try { this.editor = M.validateShape(savedEditor || backupEditor); }
    catch { this.editor = M.blankExam(); editorValid = false; }
    if (this.teacherConfigured()) {
      this.editor = publicEditor(this.editor);
      await this.writePublicEditor(this.editor, backupEditor);
      if (this.config.teacherProtection !== 1) await this.persistConfig({ teacherProtection: 1 });
    } else if (!editorValid) await this.persistEditor(this.editor);
    if(this.allowLegacyResults)await this.migrateResults();
    if (/^[a-f0-9-]{36}$/.test(this.config.examId ?? '')) {
      try {
        this.examDir = this.dir('exams', this.config.examId);
        this.exam = await readJson(path.join(this.examDir, 'manifest.json')); await M.validateFiles(this.exam, this.examDir, true);
      } catch { this.exam = null; this.lastError = 'Не удалось восстановить загруженный вариант. Откройте файл экзамена повторно.'; }
    }
    const candidates = [];
    for (const id of await fsp.readdir(this.dir('sessions'))) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        let receipt;
        try { receipt = await ResultStorage.readReceipt(this.dir('sessions',id),id); }
        catch(e) { if(e.code !== 'ENOENT')throw e; }
        if(receipt) {
          await ResultStorage.cleanupSession(this.dir('sessions',id));
          try {receipt=await ResultStorage.publishReceipt(receipt,this.dir('sessions',id),this.resultsRoot);}
          catch {receipt.archivePath=null;receipt.resultDir=null;receipt.exportError='Не удалось восстановить файл в папке результатов. Зашифрованная резервная копия сохранена.';this.lastError=receipt.exportError;await json(this.dir('sessions',id,'receipt.json'),receipt);}
          if(receipt.id===this.config.attemptId)candidates.push(receipt);
          continue;
        }
        const a = await readJson(this.dir('sessions', id, 'session.json'), true);
        check(a.schema === 1 && a.id === id && Number.isFinite(a.startedAt) && a.durationSeconds === M.DURATION && ['active','finished'].includes(a.status), 'Повреждён сеанс.');
        if (a.status === 'active' || a.id === this.config.attemptId) candidates.push(a);
      } catch { this.lastError = 'Обнаружен повреждённый сеанс. Скопируйте папку sessions и передайте организатору; файлы не удалены.'; }
    }
    candidates.sort((a, b) => (b.status === 'active') - (a.status === 'active') || b.startedAt - a.startedAt);
    if (candidates.length) {
      this.attempt = candidates[0];
      if(!this.attempt.sealed) {
        this.sessionExam = await readJson(this.dir('sessions', this.attempt.id, 'exam/manifest.json'));
        await M.validateFiles(this.sessionExam, this.dir('sessions', this.attempt.id, 'exam'), true);
      }
      if (this.config.attemptId !== this.attempt.id) await this.persistConfig({ attemptId: this.attempt.id });
      this.setAnchor(); this.recovered = this.attempt.status === 'active';
      if (this.attempt.status === 'active') await this.pulse(true);
      else if (!this.attempt.archivePath || !fs.existsSync(this.attempt.archivePath)) await this.exportResults();
    }
    return this.state();
  }
  setAnchor() {
    this.anchorMono = this.monotonic();
    this.anchorElapsed = Math.max(0, this.attempt.elapsedFloorMs || 0, this.now() - this.attempt.startedAt);
  }
  elapsed() {
    if (!this.attempt) return 0;
    if (this.attempt.status === 'finished') return this.attempt.elapsedMs;
    return Math.max(0, this.attempt.elapsedFloorMs || 0, this.now() - this.attempt.startedAt, this.anchorElapsed + this.monotonic() - this.anchorMono);
  }
  remaining() { return this.attempt ? Math.max(0, this.attempt.durationSeconds * 1000 - this.elapsed()) : 0; }
  async commit(mutator) {
    const next = clone(this.attempt); mutator(next);
    if(next.sealed) { await json(this.dir('sessions',next.id,'receipt.json'),next); this.attempt=next; return; }
    next.elapsedFloorMs = Math.max(next.elapsedFloorMs || 0, this.elapsed());
    next.observedAt = Math.max(next.observedAt || 0, this.now());
    await json(this.dir('sessions', next.id, 'session.json'), next, true); this.attempt = next;
  }
  async persistEditor(next) {
    M.validateShape(next); check(Buffer.byteLength(JSON.stringify(next)) <= LIMITS.json, 'Проект с эталонами превышает 1 МБ. Сократите тесты.');
    if (this.teacherConfigured()) {
      await this.teacher.save(next);
      await json(this.dir('editor/manifest.json'), publicEditor(next), true);
      await fsp.chmod(this.dir('editor/manifest.json.bak'), 0o600);
      this.editor = this.teacher.unlocked() ? next : publicEditor(next);
    } else { await json(this.dir('editor/manifest.json'), next, true); this.editor = next; }
  }
  teacherConfigured() { return this.teacher.configured(); }
  teacherAuthorized(token) { return this.teacher.authorized(token); }
  assertTeacherUnlocked() { if (this.teacherConfigured()) this.teacher.assertUnlocked(); }
  clearTeacherTemporaries() {
    for (const file of this.teacherTemporaries) {
      try { fs.rmSync(file, { recursive: true, force: true }); this.teacherTemporaries.delete(file); }
      catch { this.lastError = 'Не удалось удалить временный отчёт учителя. Закройте его и повторите блокировку.'; }
    }
  }
  async cleanTeacherRuntime() {
    const dir = this.dir('teacher/runtime'); await mkdir(dir);
    const stat = await fsp.lstat(dir); check(stat.isDirectory() && !stat.isSymbolicLink(), 'Папка временных файлов учителя недоступна.');
    await fsp.chmod(dir, 0o700);
    for (const name of await fsp.readdir(dir)) {
      if (/^(?:workspace|report|import|migration)-[a-f0-9-]{36}(?:\.zip)?$/.test(name)) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
  async writePublicEditor(editor, backup = editor) {
    let previous = editor;
    try { previous = M.validateShape(backup); } catch {}
    await fsp.chmod(this.dir('editor'), 0o700);
    await json(this.dir('editor/manifest.json'), publicEditor(editor));
    await json(this.dir('editor/manifest.json.bak'), publicEditor(previous));
  }
  async protectStoredTeacherFiles() {
    this.assertTeacherUnlocked();
    for (const entry of await fsp.readdir(this.dir('exports'), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.oge$/.test(entry.name)) continue;
      const file = this.dir('exports', entry.name); if (await isProtectedProject(file)) continue;
      let legacy;
      try { legacy = await readLegacyPackage(file); M.validateShape(legacy.manifest); }
      catch (e) { if (e.code === 'ENOENT') continue; legacy = null; }
      if (legacy?.manifest.published && !legacy.manifest.tasks.some(task => task.checker)) continue;
      if (!legacy) {
        // Keep unrecognized historical bytes recoverable under the vault key,
        // without treating them as an exam or leaving private plaintext behind.
        await this.teacher.protectProject(file, file, { allowLegacySize: true }); continue;
      }
      const temporary = this.dir('teacher/runtime', `migration-${crypto.randomUUID()}.zip`); this.teacherTemporaries.add(temporary);
      try {
        await fsp.writeFile(temporary, legacy.buffer, { flag:'wx', mode:0o600 });
        await this.teacher.protectProject(temporary, file);
      } finally { await fsp.rm(temporary, { force: true }); this.teacherTemporaries.delete(temporary); }
    }
    // Older editor imports left their unpacked project in the exams cache.
    // Retain the course assets and encrypt only its private manifest.
    for (const id of await fsp.readdir(this.dir('exams'))) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const file=this.dir('exams',id,'manifest.json');
      try {
        if(await isProtectedProject(file))continue;
        let project;
        try { project=M.validateShape(await readJson(file)); } catch(e){if(e.code==='ENOENT')continue;}
        if(!project?.published || project.tasks.some(task=>task.checker))await this.teacher.protectProject(file,file,{allowLegacySize:true});
      } catch(e){if(e.code!=='ENOENT')throw e;}
    }
    for (const id of await fsp.readdir(this.dir('reviews'))) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      for (const name of ['assessment.json', 'assessment.html', 'assessment.csv', 'SHA256.json', 'reviewed-results.zip']) {
        const file = this.dir('reviews', id, name);
        try { if (!await isProtectedProject(file)) await this.teacher.protectProject(file); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }
  async configureTeacher(password) {
    this.assertIdle();
    if (this.teacherConfigured()) throw new UserError('Пароль учителя уже настроен.', 409);
    const editor = this.editor; let backupEditor = editor, legacyBackup;
    try {
      const file = this.dir('editor/manifest.json.bak'), stat = await fsp.lstat(file);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMITS.json, 'Резервный проект недоступен или слишком большой.');
      const originalBackup = await fsp.readFile(file);
      try { backupEditor = M.validateShape(JSON.parse(originalBackup.toString('utf8'))); }
      catch { legacyBackup = { encoding:'base64', data:originalBackup.toString('base64') }; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try {
      const result = await this.teacher.configure(password, editor, { backupEditor, legacyBackup }); this.editor = editor;
      await this.protectStoredTeacherFiles(); await this.writePublicEditor(editor, backupEditor);
      await this.protectStoredResults();
      await this.persistConfig({ teacherProtection: 1, teacherFilesProtected: 1 }); return result;
    } catch (e) {
      if (this.teacherConfigured()) {
        this.teacher.lock(); await this.writePublicEditor(editor, backupEditor).catch(() => {});
        await this.persistConfig({ teacherProtection: 1 }).catch(() => {});
      }
      throw e;
    }
  }
  async unlockTeacher(password) {
    this.assertIdle(); let established = false;
    try {
      const { token, editor } = await this.teacher.unlock(password); established = true; M.validateShape(editor); this.editor = editor;
      if (this.config.teacherFilesProtected !== 1) {
        await this.protectStoredTeacherFiles(); await this.persistConfig({ teacherFilesProtected: 1 });
      }
      await this.protectStoredResults();
      return { token };
    } catch (e) { if(established)this.teacher.lock(); throw e; }
  }
  async lockTeacher() { this.teacher.lock(); this.clearTeacherTemporaries(); return this.state(); }
  async persistConfig(patch) { const next = { ...this.config, ...patch }; await json(this.dir('config.json'), next, true); this.config = next; }
  ownsResultPath(file) {
    if(typeof file!=='string' || !path.isAbsolute(file))return false;
    return [this.resultsRoot,this.dir('results')].some(root=>{const rel=path.relative(root,file);return rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);});
  }
  async validateStoredResult(file) {
    const workspace=this.dir('teacher/runtime',`workspace-${crypto.randomUUID()}`);this.teacherTemporaries.add(workspace);
    try {await mkdir(workspace);return await R.importResult(file,workspace,this.editor);}
    finally {await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace);}
  }
  async verifyEncryptedCopy(file,sourceHash) {
    const workspace=this.dir('teacher/runtime',`workspace-${crypto.randomUUID()}`);this.teacherTemporaries.add(workspace);
    try {await mkdir(workspace);const restored=path.join(workspace,'verify.zip');await ResultProtection.decryptFile(file,restored,this.teacher.resultPrivateKeys());check(await hashFile(restored)===sourceHash,'Зашифрованная копия отличается от исходной работы. Оригинал сохранён.');}
    finally {await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace);}
  }
  async protectStoredResults() {
    this.assertTeacherUnlocked(); const recipient=this.teacher.resultRecipient();if(!recipient)return;
    let pending=false;
    // Old imported answers and source ZIPs need protection as well as reports.
    for(const id of await fsp.readdir(this.dir('reviews'))) {
      if(!/^[a-f0-9-]{36}$/.test(id))continue;
      await this.storeReviewDirectory(this.dir('reviews',id),this.dir('reviews',id));
    }
    for(const id of await fsp.readdir(this.dir('sessions'))) {
      if(!/^[a-f0-9-]{36}$/.test(id))continue;
      const dir=this.dir('sessions',id);
      let receipt;
      try {receipt=await ResultStorage.readReceipt(dir,id);}catch(e){if(e.code!=='ENOENT'){pending=true;continue;}}
      if(receipt){await ResultStorage.cleanupSession(dir);continue;}
      let a;
      try {a=await readJson(path.join(dir,'session.json'),true);}catch(e){if(e.code!=='ENOENT')pending=true;continue;}
      if(a.status!=='finished')continue;
      try {
        let sourceZip;
        if(this.ownsResultPath(a.archivePath) && fs.existsSync(a.archivePath) && a.archivePath.endsWith('.zip')) {
          const original=await this.validateStoredResult(a.archivePath);check(original.sessionId===a.id,'Архив не соответствует сеансу.');sourceZip=a.archivePath;
        }
        const exam=await readJson(path.join(dir,'exam/manifest.json'));
        receipt=await ResultStorage.sealSession(a,exam,dir,recipient,{sourceZip});
        try {receipt=await ResultStorage.publishReceipt(receipt,dir,this.resultsRoot);}catch(e){receipt.exportError='Не удалось сохранить работу в Документы. Зашифрованная резервная копия сохранена.';await json(path.join(dir,'receipt.json'),receipt);pending=true;}
        if(this.attempt?.id===id){this.attempt=receipt;this.sessionExam=null;}
      }catch {pending=true;}
    }
    // Only app-format OGE_*.zip files inside explicitly configured result roots
    // are migrated. Unrelated user archives are never selected for removal.
    for(const root of new Set([this.resultsRoot,this.dir('results')])) {
      let entries;try {entries=await fsp.readdir(root,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')pending=true;continue;}
      for(const entry of entries) {
        if(!entry.isFile() || !/^OGE_.+\.zip$/.test(entry.name))continue;
        const source=path.join(root,entry.name);
        try {
          const original=await this.validateStoredResult(source), hash=await hashFile(source);
          const encrypted=path.join(root,`OGE_protected_${original.sessionId}_${hash.slice(0,12)}.ogeresult`);
          if(!fs.existsSync(encrypted))await ResultProtection.encryptFile(source,encrypted,recipient);
          await this.verifyEncryptedCopy(encrypted,hash);
          const folder=source.slice(0,-4);
          if(!await ResultStorage.removeMatchingFolder(folder,source)){pending=true;continue;}
          await fsp.unlink(source);
        } catch {pending=true;}
      }
      for(const entry of entries) {
        if(!entry.isDirectory() || !entry.name.startsWith('OGE_') || entry.name.endsWith('.tmp'))continue;
        const folder=path.join(root,entry.name);
        if(fs.existsSync(folder+'.zip') || fs.existsSync(path.join(folder,'result.ogeresult')) || !fs.existsSync(path.join(folder,'answers.json')))continue;
        const encrypted=path.join(root,`OGE_migrated_${crypto.randomUUID()}.ogeresult`);
        try {
          await ResultProtection.encryptStream(ResultStorage.zipStream(await ResultStorage.legacyFolderEntries(folder)),encrypted,recipient);
          const workspace=this.dir('teacher/runtime',`workspace-${crypto.randomUUID()}`);this.teacherTemporaries.add(workspace);
          try {
            await mkdir(workspace);const plain=path.join(workspace,'work.zip');await ResultProtection.decryptFile(encrypted,plain,this.teacher.resultPrivateKeys());
            await this.validateStoredResult(plain);check(await ResultStorage.removeMatchingFolder(folder,plain),'Прежняя папка содержит другие файлы. Оригинал сохранён.');
          }finally {await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace);}
        }catch {pending=true;await fsp.rm(encrypted,{force:true}).catch(()=>{});}
      }
    }
    await this.persistConfig({resultsProtection:pending?0:1});
    if(pending)this.lastError='Некоторые прежние файлы не удалось защитить. Они сохранены. Проверьте доступ и повторно войдите как учитель.';
  }
  resultKeyBackup() {this.assertIdle();this.assertTeacherUnlocked();return this.teacher.exportResultKeyBackup();}
  async importResultKey(file,password) {this.assertIdle();this.assertTeacherUnlocked();return this.teacher.importResultKeyBackup(file,password);}
  async resultDownload() {
    const a=this.attempt;check(a?.status==='finished' && a.archivePath,'Итоговая работа пока недоступна. Повторите экспорт.');
    if(a.sealed) {
      const receipt=await ResultStorage.readReceipt(this.attemptDir(),a.id);
      const expected=ResultStorage.visibleArchive(receipt,this.resultsRoot);
      const st=await fsp.lstat(expected);
      check(a.archivePath===expected && st.isFile() && !st.isSymbolicLink() && st.size<=ResultProtection.RESULT_LIMIT && await hashFile(expected)===receipt.archiveSha256,
        'Файл результатов изменён или повреждён. Повторите экспорт из зашифрованной резервной копии.');
    }
    return {file:a.archivePath,encrypted:!!a.sealed};
  }
  async migrateResults() {
    if (this.resultsRoot === this.dir('results')) return;
    try {
      const moved = await migrateLegacyResults(this.dir('results'), this.resultsRoot);
      if (!moved.size) return;
      for (const id of await fsp.readdir(this.dir('sessions'))) {
        if (!/^[a-f0-9-]{36}$/.test(id)) continue;
        const file = this.dir('sessions', id, 'session.json');
        let session;
        try { session = await readJson(file, true); } catch { continue; }
        if (session.status !== 'finished') continue;
        const resultDir = moved.get(session.resultDir) || session.resultDir;
        const archivePath = moved.get(session.archivePath) || session.archivePath;
        if (resultDir !== session.resultDir || archivePath !== session.archivePath)
          await json(file, { ...session, resultDir, archivePath }, true);
      }
    } catch {
      this.lastError = 'Не удалось перенести прежние результаты в Документы. Оригиналы сохранены; проверьте свободное место и доступ к папке.';
    }
  }
  theme() { return this.config.theme === 'dark' ? 'dark' : 'light'; }
  async setTheme(theme) {
    check(theme === 'light' || theme === 'dark', 'Некорректная тема.');
    await this.persistConfig({ theme });
    return this.theme();
  }
  assertIdle() { check(!this.attempt || this.attempt.status !== 'active', 'Во время экзамена редактор и смена варианта недоступны.'); }
  async assertActive() {
    check(this.attempt?.status === 'active', 'Экзамен не начат или уже завершён.');
    if (this.remaining() <= 0) { await this.finish('timeout'); throw new UserError('Время экзамена истекло. Новые ответы не принимаются.', 409); }
  }
  publicExam(exam, includeCheckers = false) {
    if (!exam) return null;
    return { id: exam.id, title: exam.title, published: exam.published, durationSeconds: M.DURATION,
      hasActivation: !!(exam.activation || exam.teacherHasActivation), resultsProtected:!!(exam.resultRecipient || this.teacher.resultRecipient()),
      tasks: exam.tasks.map(t => ({ id: t.id, kind: M.taskKind(t.id), hasResources: M.hasResources(t.id), requiresResources: M.requiresResources(t.id),
        images: [...t.images].sort(M.lexical).map(({ id, name, size }) => ({ id, name, size })),
        resources: t.resources.map(({ id, name, size }) => ({ id, name, size })),
        ...(includeCheckers ? { checker: G.validateChecker(t.id, t.checker) } : {}) })) };
  }
  sessionView() {
    const a = this.attempt; if (!a) return null;
    const statuses = a.sealed ? a.statuses : Array.from({ length: 16 }, (_, i) => ({ id: i + 1, saved: M.answered(a.answers[i+1]), dirty: M.dirty(a, i+1) }));
    return { id: a.id, status: a.status, title: a.title, startedAt: a.startedAt, deadlineAt: a.deadlineAt, finishedAt: a.finishedAt,
      finishReason: a.finishReason, remainingMs: this.remaining(), currentTask: a.currentTask,
      candidate: { surname: a.candidate?.surname || '', name: a.candidate?.name || '', registration: a.candidate?.registration || '' },
      statuses, savedCount: statuses.filter(s => s.saved).length, dirtyCount: statuses.filter(s => s.dirty).length,
      resultDir: a.resultDir || null, archiveReady: !!a.archivePath, archiveName:a.archivePath?path.basename(a.archivePath):null,
      encrypted:!!a.sealed, exportError: a.exportError || null, recovered: this.recovered };
  }
  state({ teacherAccess = false } = {}) {
    const idle = this.attempt?.status !== 'active', allowed = !!teacherAccess && (!this.teacherConfigured() || this.teacher.unlocked()) && idle;
    // Expiry also discards the decrypted editor when the caller is a pupil.
    this.teacher.unlocked();
    return { version, theme: this.theme(), exam: this.publicExam(this.exam), editor: idle ? this.publicExam(this.editor, allowed) : null,
      teacher: { configured: this.teacherConfigured(), unlocked: allowed, resultProtection:{ready:!!this.teacher.resultRecipient(),keyId:this.teacher.resultRecipient()?.keyId || null,migrationPending:this.teacherConfigured() && this.config.resultsProtection!==1} }, session: this.sessionView(), checking:this.checking, resultsRoot:this.resultsRoot, warning:this.lastError };
  }
  async newEditor() { this.assertIdle(); this.assertTeacherUnlocked(); await this.persistEditor(M.blankExam()); return this.publicExam(this.editor, true); }
  async setEditorChecker({taskId, checker} = {}) {
    this.assertIdle(); this.assertTeacherUnlocked(); M.taskKind(taskId); const value=G.validateChecker(taskId, checker);
    const next=clone(this.editor); next.published=false;
    if (value) next.tasks[taskId-1].checker=value; else delete next.tasks[taskId-1].checker;
    await this.persistEditor(next); return this.publicExam(this.editor, true);
  }
  async previewReference({taskId} = {}) {
    this.assertIdle(); this.assertTeacherUnlocked(); M.taskKind(taskId);
    const task=clone(this.editor.tasks[taskId-1]), checker=G.validateChecker(taskId,task.checker);
    check(checker?.type==='code' && checker.reference, 'Добавьте эталонную программу в настройки проверки.');
    const result=await G.previewReference({task,checker,examDir:this.dir('editor'),runCode:options=>this.codeRunner.runCode(options)});
    this.assertTeacherUnlocked(); return result;
  }
  async importReview(file) {
    this.assertIdle(); this.assertTeacherUnlocked();
    if(!this.teacherConfigured())return R.reviewView(await R.importResult(file,this.dir('reviews'),this.editor));
    const workspace=this.dir('teacher/runtime',`workspace-${crypto.randomUUID()}`);this.teacherTemporaries.add(workspace);
    let record;
    try {
      await mkdir(workspace); let source=file;
      if(await ResultProtection.isEncryptedResult(file)) {
        source=path.join(workspace,'result.zip');
        await ResultProtection.decryptFile(file,source,this.teacher.resultPrivateKeys());
      }
      record=await R.importResult(source,path.join(workspace,'imported'),this.editor);
      record.sourceEncrypted=source!==file;
      await json(path.join(workspace,'imported',record.id,'review.json'),record);
      await this.storeReviewDirectory(path.join(workspace,'imported',record.id),this.dir('reviews',record.id));
      return R.reviewView(record);
    } catch(e) {
      if(record)await fsp.rm(this.dir('reviews',record.id),{recursive:true,force:true});throw e;
    } finally {await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace);}
  }
  async storeReviewDirectory(source,target) {
    this.assertTeacherUnlocked(); await mkdir(target);
    for(const entry of await fsp.readdir(source,{withFileTypes:true})) {
      check(!entry.isSymbolicLink(),'Недопустимая ссылка в проверяемой работе.');
      const file=path.join(source,entry.name), out=path.join(target,entry.name);
      if(entry.isDirectory()){check(entry.name==='blobs','Неизвестная папка работы.');await this.storeReviewDirectory(file,out);}
      else {check(entry.isFile(),'Недопустимый файл работы.');if(file===out && await isProtectedProject(file))continue;await this.teacher.protectProject(file,out);}
    }
  }
  async reviewWorkspace(id,fn) {
    check(typeof id==='string' && /^[a-f0-9-]{36}$/.test(id),'Некорректный идентификатор работы.');
    this.assertIdle();this.assertTeacherUnlocked();
    if(!this.teacherConfigured())return fn(this.dir('reviews',id));
    const workspace=this.dir('teacher/runtime',`workspace-${crypto.randomUUID()}`);this.teacherTemporaries.add(workspace);
    const source=this.dir('reviews',id);
    try {
      await mkdir(workspace);
      async function restore(service,from,to) {
        for(const entry of await fsp.readdir(from,{withFileTypes:true})) {
          check(!entry.isSymbolicLink(),'Недопустимая ссылка в проверяемой работе.');
          const file=path.join(from,entry.name),out=path.join(to,entry.name);
          if(entry.isDirectory()){check(entry.name==='blobs','Неизвестная папка работы.');await mkdir(out);await restore(service,file,out);}
          else if(entry.name==='review.json' || entry.name==='original-results.zip' || /^[a-f0-9-]{36}$/.test(entry.name)) {
            check(entry.isFile(),'Недопустимый файл работы.');
            if(await isProtectedProject(file))await service.teacher.openProject(file,out);
            else await fsp.copyFile(file,out);
          }
        }
      }
      await restore(this,source,workspace);return await fn(workspace);
    } finally {await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace);}
  }
  async loadReview(id) {
    this.assertIdle(); this.assertTeacherUnlocked(); check(typeof id==='string' && /^[a-f0-9-]{36}$/.test(id), 'Некорректный идентификатор работы.');
    const record=await this.reviewWorkspace(id,dir=>readJson(path.join(dir,'review.json'))); check(record.id===id && record.attempt?.answers, 'Работа повреждена. Откройте работу повторно.');
    record.contextMatch=record.context?R.contextMatches(record.context,this.editor):null; return record;
  }
  async checkReview({id, allowUnmatched=false} = {}) {
    check(typeof allowUnmatched==='boolean', 'Некорректное подтверждение варианта.');
    const record=await this.loadReview(id);
    check(record.contextMatch===true || allowUnmatched, 'Сопоставьте вариант с проектом и подтвердите использование эталонов.');
    const assessment=await this.reviewWorkspace(id,async dir=>{
      const grade=await G.assessExam({exam:clone(this.editor),attempt:record.attempt,attemptDir:dir,examDir:this.dir('editor'),runCode:options=>this.codeRunner.runCode(options)});
      grade.projectSha256=crypto.createHash('sha256').update(JSON.stringify(this.editor)).digest('hex');
      this.assertTeacherUnlocked();
      if(this.teacherConfigured()) {
        await R.writeReviewReport(record,grade,dir);
        await json(path.join(dir,'review.json'),record);
        await this.storeReviewDirectory(dir,this.dir('reviews',id));
      } else await R.writeReviewReport(record,grade,dir);
      return grade;
    });
    if(!this.teacherConfigured())await json(this.dir('reviews',id,'review.json'),record); return assessment;
  }
  async reviewReport(id) {
    await this.loadReview(id); const file=this.dir('reviews',id,'reviewed-results.zip');
    check(fs.existsSync(file), 'Сначала проверьте работу.');
    if (!this.teacherConfigured()) return file;
    const workspace=this.dir('teacher/runtime',`workspace-${crypto.randomUUID()}`);this.teacherTemporaries.add(workspace);
    const temporary=path.join(workspace,'report.zip');
    try { await mkdir(workspace);await this.teacher.openProject(file,temporary); }
    catch (e) { await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace); throw e; }
    return { file:temporary, cleanup:async()=>{await fsp.rm(workspace,{recursive:true,force:true});this.teacherTemporaries.delete(workspace);} };
  }
  async updateEditor({ title, code, generateCode = false } = {}) {
    this.assertIdle(); this.assertTeacherUnlocked(); const next = clone(this.editor); next.published = false;
    if (title !== undefined) { check(typeof title === 'string', 'Некорректное название.'); next.title = title.trim(); }
    let newCode = null;
    if (generateCode) code = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join('-');
    if (code !== undefined && code !== '') { next.activation = await M.activation(code); newCode = code.trim(); }
    await this.persistEditor(next); return { editor: this.publicExam(this.editor, true), code: newCode };
  }
  async addEditorAsset(file, name, taskId, kind, auto = false) {
    this.assertIdle(); this.assertTeacherUnlocked(); safeName(name); check(['image', 'resource'].includes(kind), 'Некорректный тип вложения.');
    if (auto) {
      const parsed = M.parseImageName(name); if (!parsed) return { ignored: name };
      taskId = parsed.taskId; kind = 'image';
    }
    M.taskKind(taskId); check(kind !== 'resource' || M.hasResources(taskId), 'Исходные файлы доступны только для заданий 11–16.');
    const next = clone(this.editor); next.published = false; const task = next.tasks[taskId - 1];
    const key = kind === 'image' ? 'images' : 'resources';
    check(task[key].length < 16 || task[key].some(a => a.name === name), 'В одном задании допустимо до 16 файлов каждого типа.');
    const id = crypto.randomUUID(), ext = kind === 'image' ? path.extname(name).slice(1).toLowerCase() : 'bin';
    const relative = `assets/${id}.${ext}`; let mime = 'application/octet-stream';
    if (kind === 'image') {
      const h = await fsp.open(file, 'r'); const b = Buffer.alloc(16);
      try { await h.read(b, 0, 16, 0); } finally { await h.close(); }
      mime = rasterMime(b, ext);
    }
    const dest = this.dir('editor', relative);
    try {
      const meta = await boundedCopy(fs.createReadStream(file), dest, kind === 'image' ? LIMITS.image : LIMITS.file);
      check(kind !== 'image' || meta.size > 16, 'Изображение повреждено.');
      task[key] = task[key].filter(a => a.name.toLowerCase() !== name.toLowerCase());
      task[key].push({ id, name, path: relative, mime, ...meta }); task[key].sort(M.lexical);
      await this.persistEditor(next);
    } catch (e) { await fsp.rm(dest, { force: true }); throw e; }
    return { taskId, editor: this.publicExam(this.editor, true) };
  }
  async removeEditorAsset(id) {
    this.assertIdle(); this.assertTeacherUnlocked(); const next = clone(this.editor); next.published = false;
    for (const t of next.tasks) { t.images = t.images.filter(a => a.id !== id); t.resources = t.resources.filter(a => a.id !== id); }
    await this.persistEditor(next); return this.publicExam(this.editor, true);
  }
  async exportExam(publish = true) {
    this.assertIdle(); this.assertTeacherUnlocked(); check(typeof publish === 'boolean', 'Некорректное состояние публикации.');
    const next = clone(this.editor); next.id = crypto.randomUUID(); next.published = publish;
    if(publish) {
      const recipient=this.teacher.resultRecipient();
      check(recipient || this.allowLegacyResults, 'Сначала задайте пароль учителя и сохраните резервную копию ключа результатов.');
      if(recipient)next.resultRecipient=recipient;
    }
    if (publish) for (const task of next.tasks) delete task.checker;
    await M.validateFiles(next, this.dir('editor'), publish);
    const out = this.dir('exports', `${next.id}.oge`);
    const files = [{ name: 'manifest.json', data: JSON.stringify(next, null, 2) }];
    for (const t of next.tasks) for (const a of [...t.images, ...t.resources]) files.push({ name: a.path, file: this.dir('editor', a.path) });
    if (!publish && this.teacherConfigured()) {
      const temporary=this.dir('teacher/runtime',`report-${crypto.randomUUID()}.zip`); this.teacherTemporaries.add(temporary);
      try { await writeZip(files,temporary); await this.teacher.protectProject(temporary,out); }
      finally { await fsp.rm(temporary,{force:true});this.teacherTemporaries.delete(temporary); }
    } else {
      await writeZip(files,out);
      check((await fsp.stat(out)).size<=LIMITS.archive,'Упакованный экзамен больше 256 МБ. Уменьшите размеры исходных файлов.');
    }
    return { id: next.id, name: publish ? 'exam.oge' : 'project.oge', published: publish };
  }
  async importExam(file, edit = false, projectPassword) {
    this.assertIdle(); if (edit) this.assertTeacherUnlocked(); const id = crypto.randomUUID();
    const dir = edit ? this.dir('teacher/runtime', `workspace-${id}`) : this.dir('exams', id);
    if(edit)this.teacherTemporaries.add(dir);
    let decrypted;
    try {
      if (await isProtectedProject(file)) {
        check(edit, 'Защищённый проект нужно открыть в режиме учителя.');
        decrypted=this.dir('teacher/runtime',`import-${crypto.randomUUID()}.zip`);this.teacherTemporaries.add(decrypted);
        await this.teacher.openProject(file,decrypted,projectPassword);
      }
      const exam = await extractPackage(decrypted||file, dir); await M.validateFiles(exam, dir, !edit);
      if (edit) {
        for (const t of exam.tasks) for (const a of [...t.images, ...t.resources]) await fsp.copyFile(path.join(dir, a.path), this.dir('editor', a.path));
        exam.published = false; await this.persistEditor(exam); return this.publicExam(this.editor, true);
      }
      await this.persistConfig({ examId: id }); this.exam = exam; this.examDir = dir; await this.lockTeacher(); return this.publicExam(exam);
    } catch (e) { if(!edit)await fsp.rm(dir, { recursive: true, force: true }); throw e; }
    finally {
      if(edit){await fsp.rm(dir,{recursive:true,force:true});this.teacherTemporaries.delete(dir);}
      if(decrypted){await fsp.rm(decrypted,{force:true});this.teacherTemporaries.delete(decrypted);}
    }
  }
  async start(input, code) {
    this.assertIdle(); check(this.exam, 'Сначала загрузите экзамен.'); M.validateShape(this.exam, true);
    check(this.exam.resultRecipient || this.teacher.resultRecipient() || this.allowLegacyResults,
      'В экзамене нет ключа результатов. Попросите учителя опубликовать вариант заново или настроить защиту на этом компьютере.');
    check(this.now() >= this.nextActivationAt, 'Подождите несколько секунд перед следующей попыткой ввода кода.');
    const person = M.candidate(input);
    if (!await M.verifyCode(code, this.exam.activation)) {
      this.badCodes++; this.nextActivationAt = this.now() + Math.min(30000, 1000 * this.badCodes);
      throw new UserError('Неверный код активации. Проверьте код у организатора.', 403);
    }
    this.badCodes = 0; this.nextActivationAt = 0;
    await M.validateFiles(this.exam, this.examDir, true);
    await this.lockTeacher();
    const id = crypto.randomUUID(), dir = this.dir('sessions', id);
    await mkdir(dir); await fsp.cp(this.examDir, path.join(dir, 'exam'), { recursive: true });
    const now = this.now();
    const a = { schema: 1, id, examId: this.exam.id, title: this.exam.title, candidate: person, startedAt: now,
      deadlineAt: now + M.DURATION * 1000, durationSeconds: M.DURATION, elapsedFloorMs: 0, observedAt: now,
      currentTask: 1, status: 'active', answers: {}, drafts: {}, draftFiles: {}, events: [{ type: 'started', at: iso(now) }] };
    await json(path.join(dir, 'session.json'), a); this.attempt = a; this.sessionExam = clone(this.exam); this.setAnchor(); this.recovered = false;
    await this.persistConfig({ attemptId: id }); return this.sessionView();
  }
  task(id) {
    M.taskKind(id); check(this.attempt && !this.attempt.sealed && this.sessionExam, 'Сеанс завершён. Ответы доступны учителю в защищённой работе.'); const t = this.sessionExam.tasks[id - 1], a = this.attempt;
    const saved = a.answers[id];
    return { ...this.publicExam({ ...this.sessionExam, tasks: [t] }).tasks[0],
      text: a.drafts[id] ?? saved?.text ?? '', savedText: saved?.text ?? '', savedAt: saved?.savedAt ?? null,
      savedFile: saved?.file ? { name: saved.file.name, size: saved.file.size } : null,
      draftFile: a.draftFiles[id] ? { name: a.draftFiles[id].name, size: a.draftFiles[id].size } : null,
      dirty: M.dirty(a, id) };
  }
  async navigate(id) { await this.assertActive(); M.taskKind(id); await this.commit(a => { a.currentTask = id; }); return this.task(id); }
  async saveDraft(id, text) {
    await this.assertActive(); check(M.taskKind(id) === 'short' && typeof text === 'string' && text.length <= 4096, 'Краткий ответ должен быть текстом до 4096 символов.');
    await this.commit(a => { a.drafts[id] = text; }); return this.sessionView();
  }
  async attachFile(id, file, name) {
    await this.assertActive(); check(M.taskKind(id) === 'file', 'В этом задании нужен краткий ответ.'); safeName(name);
    const assetId = crypto.randomUUID(), relative = `blobs/${assetId}`; const dest = inside(this.attemptDir(), relative);
    try {
      const meta = await boundedCopy(fs.createReadStream(file), dest);
      await this.assertActive();
      await this.commit(a => { a.draftFiles[id] = { id: assetId, path: relative, name, ...meta }; });
    } catch (e) { await fsp.rm(dest, { force: true }); throw e; }
    return this.task(id);
  }
  async saveAnswer(id, text) {
    await this.assertActive(); const kind = M.taskKind(id);
    if (kind === 'short') check(typeof text === 'string' && text.length <= 4096, 'Краткий ответ должен быть текстом до 4096 символов.');
    else check(this.attempt.draftFiles[id] || this.attempt.answers[id]?.file, 'Сначала прикрепите файл ответа.');
    await this.commit(a => {
      a.answers[id] = kind === 'short' ? { kind, text, savedAt: iso(this.now()) } : { kind, file: clone(a.draftFiles[id] || a.answers[id].file), savedAt: iso(this.now()) };
      if (kind === 'short') a.drafts[id] = text;
      a.events.push({ type: 'answer_saved', task: id, at: iso(this.now()) });
    });
    return { task: this.task(id), session: this.sessionView() };
  }
  async clearAnswer(id) {
    await this.assertActive(); M.taskKind(id);
    await this.commit(a => { delete a.answers[id]; delete a.draftFiles[id]; delete a.drafts[id]; a.events.push({ type: 'answer_cleared', task: id, at: iso(this.now()) }); });
    return { task: this.task(id), session: this.sessionView() };
  }
  asset(id) {
    check(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'Некорректный файл.');
    if(this.attempt?.status!=='active')this.assertTeacherUnlocked();
    const contexts = this.attempt?.status === 'active' ? [[this.sessionExam, path.join(this.attemptDir(), 'exam')]] : [[this.editor, this.dir('editor')]];
    for (const [exam, dir] of contexts) for (const t of exam.tasks) for (const a of [...t.images, ...t.resources]) if (a.id === id) return { ...a, file: inside(dir, a.path), isImage: t.images.includes(a) };
    throw new UserError('Файл не найден или недоступен в этом режиме.', 404);
  }
  exportFile(id) { check(/^[a-f0-9-]{36}$/.test(id), 'Некорректный идентификатор.'); this.assertIdle(); this.assertTeacherUnlocked(); return this.dir('exports', `${id}.oge`); }
  async pulse(force = false) {
    this.teacher.unlocked();
    if (this.attempt?.status !== 'active') return;
    if (this.remaining() <= 0) return this.finish('timeout');
    if (force || this.monotonic() - this.lastCheckpoint >= 5000) {
      await this.commit(a => {
        if (this.now() + 2000 < a.observedAt && !a.events.some(e => e.type === 'clock_rollback')) a.events.push({ type: 'clock_rollback', at: iso(this.now()) });
      });
      this.lastCheckpoint = this.monotonic();
    }
  }
  async finish(reason = 'manual') {
    check(['manual', 'timeout'].includes(reason), 'Некорректная причина завершения.');
    if (this.attempt?.status === 'finished') return this.sessionView();
    check(this.attempt?.status === 'active', 'Нет активного экзамена.');
    if (this.remaining() <= 0) reason = 'timeout';
    const elapsed = Math.min(M.DURATION * 1000, this.elapsed());
    await this.commit(a => { a.status = 'finished'; a.finishReason = reason; a.finishedAt = this.now(); a.elapsedMs = elapsed; a.events.push({ type: 'finished', reason, at: iso(this.now()) }); });
    await this.exportResults(); return this.sessionView();
  }
  async exportResults() {
    check(this.attempt?.status === 'finished', 'Экзамен ещё не завершён.');
    const recipient=this.sessionExam?.resultRecipient || this.teacher.resultRecipient();
    if(!this.attempt.sealed && !recipient && !this.allowLegacyResults) {
      const message='Для защиты прежнего сеанса учитель должен один раз войти с паролем. Ответы сохранены; затем повторите экспорт.';
      this.lastError=message;await this.commit(s=>{s.exportError=message;});return this.sessionView();
    }
    if(this.attempt.sealed || recipient) {
      try {
        if(!this.attempt.sealed)this.attempt=await ResultStorage.sealSession(this.attempt,this.sessionExam,this.attemptDir(),recipient);
        else {this.attempt=await ResultStorage.readReceipt(this.attemptDir(),this.attempt.id);await ResultStorage.cleanupSession(this.attemptDir());}
        this.attempt=await ResultStorage.publishReceipt(this.attempt,this.attemptDir(),this.resultsRoot);
        this.sessionExam=null;
      } catch(e) {
        const message=e instanceof UserError?e.message:`Не удалось сохранить защищённую работу (${e.code || 'ошибка записи'}). Резервные данные сохранены; повторите экспорт.`;
        // An interrupted cleanup must never cause a valid encrypted receipt to
        // be replaced by a plaintext session checkpoint on the next retry.
        try {this.attempt=await ResultStorage.readReceipt(this.attemptDir(),this.attempt.id);await ResultStorage.cleanupSession(this.attemptDir());}catch{}
        if(this.attempt.sealed){this.attempt.archivePath=null;this.attempt.resultDir=null;this.sessionExam=null;}
        this.lastError=message; await this.commit(s=>{s.exportError=message;}).catch(()=>{});
      }
      return this.sessionView();
    }
    const a = clone(this.attempt), suffix = `${new Date(a.startedAt).toISOString().slice(0,10)}_${a.candidate.registration}_${a.id.slice(0,8)}`;
    let final = path.join(this.resultsRoot, `OGE_${suffix}`);
    if (fs.existsSync(final)) final += `_${crypto.randomUUID().slice(0,6)}`;
    const temp = `${final}.tmp`, zipPath = `${final}.zip`;
    try {
      await mkdir(temp);
      const answers = [], drafts = {}, files = [];
      for (let id = 1; id <= 16; id++) {
        const answer = a.answers[id], record = { task: id, kind: M.taskKind(id), saved: M.answered(answer), savedAt: answer?.savedAt ?? null };
        if (record.kind === 'short') record.answer = answer?.text ?? '';
        if (answer?.file) {
          const rel = `files/task-${id}/${safeName(answer.file.name)}`;
          await mkdir(path.dirname(path.join(temp, rel)));
          check(await hashFile(inside(this.attemptDir(), answer.file.path)) === answer.file.sha256, `Файл ответа ${id} повреждён. Оригинал сеанса сохранён.`);
          await fsp.copyFile(inside(this.attemptDir(), answer.file.path), path.join(temp, rel));
          record.file = { path: rel, name: answer.file.name, size: answer.file.size, sha256: answer.file.sha256 };
        }
        if (M.dirty(a, id)) {
          if (record.kind === 'short') drafts[id] = { text: a.drafts[id], submitted: false };
          else {
            const f = a.draftFiles[id], rel = `draft-files/task-${id}/${safeName(f.name)}`;
            await mkdir(path.dirname(path.join(temp, rel)));
            check(await hashFile(inside(this.attemptDir(), f.path)) === f.sha256, `Черновик задания ${id} повреждён. Оригинал сеанса сохранён.`);
            await fsp.copyFile(inside(this.attemptDir(), f.path), path.join(temp, rel));
            drafts[id] = { file: rel, sha256: f.sha256, submitted: false };
          }
        }
        answers.push(record);
      }
      const meta = { format: 'oge-results', version: 1, sessionId: a.id, examId: a.examId, examTitle: a.title, startedAt: iso(a.startedAt), deadlineAt: iso(a.deadlineAt), finishedAt: iso(a.finishedAt), elapsedSeconds: Math.round(a.elapsedMs / 1000), finishReason: a.finishReason, savedCount: answers.filter(x => x.saved).length };
      await json(path.join(temp, 'candidate.json'), a.candidate);
      await json(path.join(temp, 'answers.json'), { ...meta, answers });
      await json(path.join(temp, 'grading-context.json'), R.gradingContext(this.sessionExam));
      await json(path.join(temp, 'drafts.json'), { note: 'Черновики не являются сохранёнными ответами. Не оценивать без решения организатора.', drafts });
      await json(path.join(temp, 'events.json'), a.events);
      await fsp.writeFile(path.join(temp, 'answers.csv'), '\ufeff' + ['Задание;Тип;Сохранён;Ответ или файл;Время сохранения', ...answers.map(r => [r.task, r.kind, r.saved ? 'да' : 'нет', r.answer ?? r.file?.path ?? '', r.savedAt].map(csv).join(';'))].join('\r\n'), { mode: 0o600 });
      const rows = answers.map(r => `<tr><td>${r.task}</td><td>${r.saved ? 'Сохранён' : 'Нет ответа'}</td><td>${html(r.answer ?? r.file?.name ?? '—')}</td></tr>`).join('');
      await fsp.writeFile(path.join(temp, 'report.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Результат экзамена</title><style>body{font:16px/1.6 sans-serif;max-width:1000px;margin:40px auto;padding:24px;color:#152c3c}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:10px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:26px}</style><h1>${html(a.title)}</h1><p>${html(a.candidate.surname)} ${html(a.candidate.name)} · Бланк ${html(a.candidate.registration)}</p><p>Сохранено: ${meta.savedCount}/16. Завершение: ${a.finishReason === 'timeout' ? 'время истекло' : 'по подтверждению ученика'}.<br>Начало: ${html(meta.startedAt)}<br>Завершение: ${html(meta.finishedAt)}</p><table><thead><tr><th>Задание</th><th>Статус</th><th>Ответ / файл</th></tr></thead><tbody>${rows}</tbody></table><p>Черновики хранятся отдельно в drafts.json и draft-files. Паспортные данные — в candidate.json. Автоматическое оценивание не выполнялось.</p></html>`, { mode: 0o600 });
      await fsp.writeFile(path.join(temp, 'README.txt'), 'Результаты локального учебного экзамена.\nАрхив НЕ зашифрован и содержит персональные данные в candidate.json.\nНе публикуйте его в GitHub или общем доступе.\nСохранённые ответы: answers.json, answers.csv, report.html и files/.\nЧерновики: drafts.json, draft-files/ — НЕ являются сданными ответами.\nКонтрольные суммы: SHA256.json (обнаружение повреждений, не цифровая подпись).\nВремя записано в UTC в ISO 8601.\n', { mode: 0o600 });
      async function walk(dir, prefix = '') {
        for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
          if (ent.isDirectory()) await walk(path.join(dir, ent.name), `${prefix}${ent.name}/`);
          else files.push({ name: `${prefix}${ent.name}`, file: path.join(dir, ent.name) });
        }
      }
      await walk(temp);
      const sums = {}; for (const f of files) sums[f.name] = await hashFile(f.file);
      await json(path.join(temp, 'SHA256.json'), sums);
      await fsp.rename(temp, final);
      files.length = 0; await walk(final); await writeZip(files, zipPath);
      await this.commit(s => { s.resultDir = final; s.archivePath = zipPath; s.exportError = null; });
    } catch (e) {
      const message = e instanceof UserError ? e.message : `Не удалось сформировать итоговый архив (${e.code || 'ошибка записи'}). Ответы остались в папке сеанса. Повторите экспорт.`;
      this.lastError = message;
      try { await this.commit(s => { s.exportError = message; if (fs.existsSync(final)) s.resultDir = final; }); } catch {}
    }
    return this.sessionView();
  }
  async dismissResult() { this.assertIdle(); await this.persistConfig({ attemptId: null }); this.attempt = null; this.sessionExam = null; return this.state(); }
}
module.exports = { ExamService, html, csv };
