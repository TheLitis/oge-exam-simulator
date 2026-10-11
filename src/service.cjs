'use strict';
const { performance } = require('node:perf_hooks');
const { fs, fsp, path, crypto, LIMITS, UserError, check, mkdir, json, readJson, inside, safeName, hashFile, boundedCopy, extractPackage, writeZip, rasterMime } = require('./io.cjs');
const M = require('./model.cjs');
const { migrateLegacyResults } = require('./results.cjs');
const { version } = require('../package.json');
const G = require('./grading.cjs');
const CodeRunner = require('./code-runner.cjs');
const R = require('./review.cjs');
const clone = value => structuredClone(value);
const iso = ms => new Date(ms).toISOString();
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const csv = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, x => "'" + x).replace(/"/g, '""') + '"';

class ExamService {
  constructor(root, { now = Date.now, monotonic = () => performance.now(), resultsRoot, codeRunner = CodeRunner } = {}) {
    this.root = path.resolve(root); this.now = now; this.monotonic = monotonic;
    this.resultsRoot = path.resolve(resultsRoot || this.dir('results'));
    this.config = {}; this.editor = null; this.exam = null; this.attempt = null;
    this.lastCheckpoint = 0; this.nextActivationAt = 0; this.badCodes = 0;
    this.lastError = null; this.recovered = false;
    this.codeRunner = codeRunner; this.checking = null;
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
    try { this.editor = M.validateShape(await readJson(this.dir('editor/manifest.json'), true)); }
    catch { this.editor = M.blankExam(); await this.persistEditor(this.editor); }
    await this.migrateResults();
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
        const a = await readJson(this.dir('sessions', id, 'session.json'), true);
        check(a.schema === 1 && a.id === id && Number.isFinite(a.startedAt) && a.durationSeconds === M.DURATION && ['active','finished'].includes(a.status), 'Повреждён сеанс.');
        if (a.status === 'active' || a.id === this.config.attemptId) candidates.push(a);
      } catch { this.lastError = 'Обнаружен повреждённый сеанс. Скопируйте папку sessions и передайте организатору; файлы не удалены.'; }
    }
    candidates.sort((a, b) => (b.status === 'active') - (a.status === 'active') || b.startedAt - a.startedAt);
    if (candidates.length) {
      this.attempt = candidates[0]; this.sessionExam = await readJson(this.dir('sessions', this.attempt.id, 'exam/manifest.json'));
      await M.validateFiles(this.sessionExam, this.dir('sessions', this.attempt.id, 'exam'), true);
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
    next.elapsedFloorMs = Math.max(next.elapsedFloorMs || 0, this.elapsed());
    next.observedAt = Math.max(next.observedAt || 0, this.now());
    await json(this.dir('sessions', next.id, 'session.json'), next, true); this.attempt = next;
  }
  async persistEditor(next) {
    M.validateShape(next); check(Buffer.byteLength(JSON.stringify(next)) <= LIMITS.json, 'Проект с эталонами превышает 1 МБ. Сократите тесты.');
    await json(this.dir('editor/manifest.json'), next, true); this.editor = next;
  }
  async persistConfig(patch) { const next = { ...this.config, ...patch }; await json(this.dir('config.json'), next, true); this.config = next; }
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
      hasActivation: !!exam.activation,
      tasks: exam.tasks.map(t => ({ id: t.id, kind: M.taskKind(t.id), hasResources: M.hasResources(t.id),
        images: [...t.images].sort(M.lexical).map(({ id, name, size }) => ({ id, name, size })),
        resources: t.resources.map(({ id, name, size }) => ({ id, name, size })),
        ...(includeCheckers ? { checker: G.validateChecker(t.id, t.checker) } : {}) })) };
  }
  sessionView() {
    const a = this.attempt; if (!a) return null;
    const statuses = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, saved: M.answered(a.answers[i+1]), dirty: M.dirty(a, i+1) }));
    return { id: a.id, status: a.status, title: a.title, startedAt: a.startedAt, deadlineAt: a.deadlineAt, finishedAt: a.finishedAt,
      finishReason: a.finishReason, remainingMs: this.remaining(), currentTask: a.currentTask,
      candidate: { surname: a.candidate.surname, name: a.candidate.name, registration: a.candidate.registration },
      statuses, savedCount: statuses.filter(s => s.saved).length, dirtyCount: statuses.filter(s => s.dirty).length,
      resultDir: a.resultDir || null, archiveReady: !!a.archivePath, exportError: a.exportError || null, recovered: this.recovered };
  }
  state() { return { version, theme: this.theme(), exam: this.publicExam(this.exam), editor: this.attempt?.status === 'active' ? null : this.publicExam(this.editor, true), session: this.sessionView(), checking:this.checking, resultsRoot: this.resultsRoot, warning: this.lastError }; }
  async newEditor() { this.assertIdle(); await this.persistEditor(M.blankExam()); return this.publicExam(this.editor, true); }
  async setEditorChecker({taskId, checker} = {}) {
    this.assertIdle(); M.taskKind(taskId); const value=G.validateChecker(taskId, checker);
    const next=clone(this.editor); next.published=false;
    if (value) next.tasks[taskId-1].checker=value; else delete next.tasks[taskId-1].checker;
    await this.persistEditor(next); return this.publicExam(this.editor, true);
  }
  async importReview(file) {
    this.assertIdle(); return R.reviewView(await R.importResult(file, this.dir('reviews'), this.editor));
  }
  async loadReview(id) {
    this.assertIdle(); check(typeof id==='string' && /^[a-f0-9-]{36}$/.test(id), 'Некорректный идентификатор работы.');
    const record=await readJson(this.dir('reviews',id,'review.json')); check(record.id===id && record.attempt?.answers, 'Работа повреждена. Откройте ZIP повторно.');
    record.contextMatch=record.context?R.contextMatches(record.context,this.editor):null; return record;
  }
  async checkReview({id, allowUnmatched=false} = {}) {
    check(typeof allowUnmatched==='boolean', 'Некорректное подтверждение варианта.');
    const record=await this.loadReview(id);
    check(record.contextMatch===true || allowUnmatched, 'Сопоставьте вариант с проектом и подтвердите использование эталонов.');
    const assessment=await G.assessExam({exam:clone(this.editor),attempt:record.attempt,attemptDir:this.dir('reviews',id),examDir:this.dir('editor'),runCode:options=>this.codeRunner.runCode(options)});
    assessment.projectSha256=crypto.createHash('sha256').update(JSON.stringify(this.editor)).digest('hex');
    await R.writeReviewReport(record,assessment,this.dir('reviews',id));
    await json(this.dir('reviews',id,'review.json'),record); return assessment;
  }
  async reviewReport(id) {
    await this.loadReview(id); const file=this.dir('reviews',id,'reviewed-results.zip');
    check(fs.existsSync(file), 'Сначала проверьте работу.'); return file;
  }
  async updateEditor({ title, code, generateCode = false } = {}) {
    this.assertIdle(); const next = clone(this.editor); next.published = false;
    if (title !== undefined) { check(typeof title === 'string', 'Некорректное название.'); next.title = title.trim(); }
    let newCode = null;
    if (generateCode) code = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join('-');
    if (code !== undefined && code !== '') { next.activation = await M.activation(code); newCode = code.trim(); }
    await this.persistEditor(next); return { editor: this.publicExam(this.editor, true), code: newCode };
  }
  async addEditorAsset(file, name, taskId, kind, auto = false) {
    this.assertIdle(); safeName(name); check(['image', 'resource'].includes(kind), 'Некорректный тип вложения.');
    if (auto) {
      const parsed = M.parseImageName(name); if (!parsed) return { ignored: name };
      taskId = parsed.taskId; kind = 'image';
    }
    M.taskKind(taskId); check(kind !== 'resource' || M.hasResources(taskId), 'Исходные файлы доступны только для заданий 11–14.');
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
    this.assertIdle(); const next = clone(this.editor); next.published = false;
    for (const t of next.tasks) { t.images = t.images.filter(a => a.id !== id); t.resources = t.resources.filter(a => a.id !== id); }
    await this.persistEditor(next); return this.publicExam(this.editor, true);
  }
  async exportExam(publish = true) {
    this.assertIdle(); check(typeof publish === 'boolean', 'Некорректное состояние публикации.');
    const next = clone(this.editor); next.id = crypto.randomUUID(); next.published = publish;
    if (publish) for (const task of next.tasks) delete task.checker;
    await M.validateFiles(next, this.dir('editor'), publish);
    const out = this.dir('exports', `${next.id}.oge`);
    const files = [{ name: 'manifest.json', data: JSON.stringify(next, null, 2) }];
    for (const t of next.tasks) for (const a of [...t.images, ...t.resources]) files.push({ name: a.path, file: this.dir('editor', a.path) });
    await writeZip(files, out);
    check((await fsp.stat(out)).size <= LIMITS.archive, 'Упакованный экзамен больше 256 МБ. Уменьшите размеры исходных файлов.');
    return { id: next.id, name: publish ? 'exam.oge' : 'project.oge', published: publish };
  }
  async importExam(file, edit = false) {
    this.assertIdle(); const id = crypto.randomUUID(), dir = this.dir('exams', id);
    try {
      const exam = await extractPackage(file, dir); await M.validateFiles(exam, dir, !edit);
      if (edit) {
        for (const t of exam.tasks) for (const a of [...t.images, ...t.resources]) await fsp.copyFile(path.join(dir, a.path), this.dir('editor', a.path));
        exam.published = false; await this.persistEditor(exam); return this.publicExam(this.editor, true);
      }
      await this.persistConfig({ examId: id }); this.exam = exam; this.examDir = dir; return this.publicExam(exam);
    } catch (e) { await fsp.rm(dir, { recursive: true, force: true }); throw e; }
  }
  async start(input, code) {
    this.assertIdle(); check(this.exam, 'Сначала загрузите экзамен.'); M.validateShape(this.exam, true);
    check(this.now() >= this.nextActivationAt, 'Подождите несколько секунд перед следующей попыткой ввода кода.');
    const person = M.candidate(input);
    if (!await M.verifyCode(code, this.exam.activation)) {
      this.badCodes++; this.nextActivationAt = this.now() + Math.min(30000, 1000 * this.badCodes);
      throw new UserError('Неверный код активации. Проверьте код у организатора.', 403);
    }
    this.badCodes = 0; this.nextActivationAt = 0;
    await M.validateFiles(this.exam, this.examDir, true);
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
    M.taskKind(id); check(this.attempt, 'Нет текущего сеанса.'); const t = this.sessionExam.tasks[id - 1], a = this.attempt;
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
    const contexts = this.attempt?.status === 'active' ? [[this.sessionExam, path.join(this.attemptDir(), 'exam')]] : [[this.editor, this.dir('editor')]];
    for (const [exam, dir] of contexts) for (const t of exam.tasks) for (const a of [...t.images, ...t.resources]) if (a.id === id) return { ...a, file: inside(dir, a.path), isImage: t.images.includes(a) };
    throw new UserError('Файл не найден или недоступен в этом режиме.', 404);
  }
  exportFile(id) { check(/^[a-f0-9-]{36}$/.test(id), 'Некорректный идентификатор.'); this.assertIdle(); return this.dir('exports', `${id}.oge`); }
  async pulse(force = false) {
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
