import * as V from './views.js';
const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
let token = location.hash.slice(1) || sessionStorage.getItem('oge-key');
if (token) { sessionStorage.setItem('oge-key', token); history.replaceState(null, '', location.pathname); }
const state = { data: null, mode: 'home', task: null, editorTask: 1, editorCode: '', busy: false, zoom: 0, paperOriginal: false, stopped: false, review: null, assessment: null, allowUnmatched: false };
const imageUrls = new Map();
const checkerDrafts = new Map();
let toastTimer, draftTimer, metaTimer, pendingDraft = null, pendingTitle = null, draftChain = Promise.resolve(), polling = false, imageGeneration = 0;

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const button = app.querySelector('[data-action="theme"]');
  if (button) {
    button.title = dark ? 'Включить светлую тему' : 'Включить ночную тему';
    button.setAttribute('aria-pressed', String(dark));
    button.innerHTML = V.icon(dark ? 'sun' : 'moon');
  }
}

function applyPaper() {
  document.documentElement.dataset.paper = state.paperOriginal ? 'original' : 'comfortable';
  const button = app.querySelector('[data-action="paper"]');
  if (button) {
    button.setAttribute('aria-pressed', String(state.paperOriginal));
    button.title = state.paperOriginal ? 'Приглушить яркость условия' : 'Показать оригинальную яркость условия';
  }
}

function toast(message, error = false, persistent = false) {
  const el = document.querySelector('#toast'); clearTimeout(toastTimer); el.textContent = message; el.className = 'visible' + (error ? ' error' : '');
  if (!persistent) toastTimer = setTimeout(() => { el.className = ''; }, error ? 7500 : 4200);
}
async function request(route, data, upload) {
  const options = { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' };
  if (upload) { options.method = 'POST'; options.body = upload; options.headers['Content-Type'] = 'application/octet-stream'; }
  else if (data !== undefined) { options.method = 'POST'; options.body = JSON.stringify(data); options.headers['Content-Type'] = 'application/json'; }
  let response;
  try { response = await fetch(route, options); } catch { throw new Error('Нет связи с локальным приложением. Не закрывайте страницу; повторите действие после восстановления связи.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('Не удалось прочитать ответ приложения.'); }
  if (!response.ok || !body.ok) throw new Error(body.error || 'Не удалось выполнить действие.');
  return body.value;
}
async function download(route, name) {
  const response = await fetch(route, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { const b = await response.json(); throw new Error(b.error || 'Не удалось скачать файл.'); }
  const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function setBusy(value) {
  state.busy = value; document.body.dataset.busy = String(value); app.setAttribute('aria-busy', String(value));
  app.querySelectorAll('button,input,textarea,select').forEach(el => {
    if (value) { el.dataset.disabledBeforeBusy = String(el.disabled); el.disabled = true; }
    else if (el.dataset.disabledBeforeBusy !== undefined) { el.disabled = el.dataset.disabledBeforeBusy === 'true'; delete el.dataset.disabledBeforeBusy; }
  });
}
async function run(fn, message) {
  if (state.busy) return;
  const focusedAnswer = document.activeElement?.id === 'answer-text'
    ? { task: state.task?.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  setBusy(true);
  if (message) toast(message, false, true);
  try { await fn(); }
  catch (e) { toast(e.message, true); }
  finally {
    setBusy(false);
    if (focusedAnswer && state.mode === 'exam' && state.task?.id === focusedAnswer.task) {
      const input = document.querySelector('#answer-text');
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(focusedAnswer.start, focusedAnswer.end);
    }
  }
}
function ask(title, message, confirm = 'Подтвердить', danger = false) {
  return new Promise(resolve => {
    if (modal.open) modal.close('cancel');
    modal.innerHTML = `<h2 id="modal-title">${V.esc(title)}</h2><p>${V.esc(message)}</p><div class="button-row"><button class="secondary" data-choice="cancel" autofocus>Отмена</button><button class="primary${danger ? ' danger' : ''}" data-choice="ok">${V.esc(confirm)}</button></div>`;
    modal.returnValue = '';
    modal.onclick = e => { const b = e.target.closest('[data-choice]'); if (b) modal.close(b.dataset.choice); };
    modal.onclose = () => { resolve(modal.returnValue === 'ok'); modal.onclick = null; modal.onclose = null; };
    modal.showModal();
  });
}
function pickFiles({ accept = '', multiple = false, directory = false } = {}) {
  return new Promise(resolve => {
    const input = document.querySelector(directory ? '#folder-input' : '#file-input'); input.value = ''; input.accept = accept; input.multiple = multiple || directory;
    input.onchange = () => { resolve([...input.files]); input.onchange = null; input.oncancel = null; };
    input.oncancel = () => { resolve([]); input.onchange = null; input.oncancel = null; };
    input.click();
  });
}
const imageAccept = '.png,.jpg,.jpeg,.gif,.webp,.bmp';
async function loadImages() {
  const generation = ++imageGeneration;
  for (const image of document.querySelectorAll('img[data-image-id]')) {
    const id = image.dataset.imageId;
    try {
      if (!imageUrls.has(id)) {
        const response = await fetch(`/api/asset?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('Изображение условия недоступно.');
        const blob = await response.blob();
        if (generation !== imageGeneration) return;
        imageUrls.set(id, URL.createObjectURL(blob));
        if (imageUrls.size > 24) { const first = imageUrls.keys().next().value; URL.revokeObjectURL(imageUrls.get(first)); imageUrls.delete(first); }
      }
      if (generation === imageGeneration) image.src = imageUrls.get(id);
    } catch (e) { if (generation === imageGeneration) { image.alt = 'Не удалось загрузить условие. Обратитесь к организатору.'; toast(e.message, true); } }
  }
}
function render(keepScroll = false) {
  const oldScroll = keepScroll ? document.querySelector('#task-content')?.scrollTop || 0 : 0;
  const oldEditorScroll = document.querySelector('.editor-nav')?.scrollTop || 0;
  const s = state.data;
  applyTheme(s.theme);
  if (state.mode === 'exam' && state.task) app.innerHTML = V.exam(s, state.task);
  else if (state.mode === 'editor') app.innerHTML = V.editor(pendingTitle !== null ? { ...s, editor: { ...s.editor, title: pendingTitle } } : s, state.editorTask, state.editorCode, getCheckerDraft());
  else if (state.mode === 'review' && state.review) app.innerHTML = V.review(s, state.review, state.assessment, state.allowUnmatched);
  else if (state.mode === 'registration') app.innerHTML = V.registration(s);
  else if (state.mode === 'result') app.innerHTML = V.result(s);
  else app.innerHTML = V.home(s);
  applyPaper();
  document.querySelector('#task-content')?.scrollTo(0, oldScroll);
  const editorNav = document.querySelector('.editor-nav');
  if (editorNav) {
    editorNav.scrollTop = oldEditorScroll;
    const current = editorNav.querySelector('[aria-current="step"]');
    if (current) {
      const item = current.getBoundingClientRect(), frame = editorNav.getBoundingClientRect();
      if (item.bottom > frame.bottom) editorNav.scrollTop += item.bottom - frame.bottom + 8;
      else if (item.top < frame.top) editorNav.scrollTop -= frame.top - item.top + 8;
    }
  }
  if (state.mode === 'exam') applyZoom();
  loadImages();
  if (state.busy) setBusy(true);
}
function updateNav() {
  const nav = document.querySelector('#task-nav');
  if (nav && state.task) nav.innerHTML = V.nav(state.data, state.task.id);
}
function markDirty() {
  if (state.mode !== 'exam') return;
  const status = state.data.session.statuses.find(t => t.id === state.task.id); status.dirty = true; updateNav();
  const label = document.querySelector('#answer-status'); if (label) { label.textContent = 'Черновик'; label.className = 'small amber-text'; }
}
async function flushDraft() {
  clearTimeout(draftTimer);
  if (!pendingDraft) return draftChain;
  const work = pendingDraft; pendingDraft = null;
  draftChain = draftChain.catch(() => {}).then(async () => {
    try {
      const s = await request('/api/draft', work); if (state.data) state.data.session = s;
      if (state.mode === 'exam') updateNav();
    } catch (e) {
      if (!pendingDraft && state.data?.session?.status === 'active') pendingDraft = work;
      throw e;
    }
  });
  return draftChain;
}
async function flushMeta(applyCode = false) {
  clearTimeout(metaTimer);
  const title = document.querySelector('#exam-title')?.value ?? pendingTitle;
  const code = applyCode ? document.querySelector('#editor-code')?.value : undefined;
  if (title === null && !code) return;
  const result = await request('/api/editor/update', { ...(title !== null ? { title } : {}), ...(code ? { code } : {}) });
  state.data.editor = result.editor; pendingTitle = null;
  if (result.code) state.editorCode = result.code;
}
function getCheckerDraft(taskId = state.editorTask) {
  if (!checkerDrafts.has(taskId)) {
    const task = state.data.editor.tasks.find(t => t.id === taskId), c = task?.checker;
    checkerDrafts.set(taskId, { mode: c?.type || 'manual', answersText: c?.answers?.join('\n') || '', expected: c?.expected || '', caseSensitive: c?.caseSensitive !== false, ignoreWhitespace: !!c?.ignoreWhitespace, comparison: c?.comparison || 'trim', language: c?.language || 'python', tests: c?.tests?.map(t => ({ ...t })) || [{ input: '', expected: '' }], dirty: false, open: !!c });
  }
  return checkerDrafts.get(taskId);
}
function checkerValue(draft) {
  if (draft.mode === 'manual') return null;
  if (draft.mode === 'short') return { type: 'short', answers: draft.answersText.split(/\r?\n/).filter(answer => answer.trim().length), caseSensitive: draft.caseSensitive, ignoreWhitespace: draft.ignoreWhitespace };
  if (draft.mode === 'text') return { type: 'text', expected: draft.expected, comparison: draft.comparison, caseSensitive: draft.caseSensitive };
  return { type: 'code', language: draft.language, tests: draft.tests.map(test => ({ input: test.input, expected: test.expected })), comparison: draft.comparison };
}
function markCheckerDirty() {
  const draft = getCheckerDraft(); draft.dirty = true; draft.open = true;
  const label = document.querySelector('#checker-summary');
  if (label) { label.textContent = 'Не применено'; label.classList.add('amber-text'); }
  const apply = document.querySelector('[data-action="checker-apply"]');
  if (apply) { apply.disabled = state.busy; if (state.busy) apply.dataset.disabledBeforeBusy = 'false'; }
}
async function flushChecker() {
  for (const [taskId, draft] of checkerDrafts) {
    if (!draft.dirty) continue;
    const editor = await request('/api/editor/checker', { taskId, checker: checkerValue(draft) });
    state.data.editor = editor.editor || editor; draft.dirty = false;
  }
}
async function flushEditor(applyCode = false) { await flushMeta(applyCode); await flushChecker(); }
async function refresh() {
  const next = await request('/api/state'); state.data = next;
  if (next.session?.status === 'finished' && state.mode === 'exam') {
    if (modal.open) modal.close('expired'); pendingDraft = null; clearTimeout(draftTimer);
    state.mode = 'result'; state.task = null; render(); toast('Экзамен завершён. Новые ответы больше не принимаются.');
  }
  return next;
}
async function navigate(id) {
  if (id < 1 || id > 16 || id === state.task?.id) return;
  await flushDraft(); state.task = await request('/api/navigate', { id });
  state.data.session.currentTask = id; render();
}
async function save() {
  const text = document.querySelector('#answer-text')?.value;
  await flushDraft(); const result = await request('/api/save', { id: state.task.id, text });
  state.task = result.task; state.data.session = result.session; render(true); toast('Ответ сохранён на компьютере.');
}
async function importImageFiles(files, auto = true) {
  if (!files.length) return;
  await flushEditor();
  const names = new Set();
  for (const f of files) { if (names.has(f.name.toLowerCase())) throw new Error(`В выбранных папках повторяется имя «${f.name}». Переименуйте файлы перед импортом.`); names.add(f.name.toLowerCase()); }
  let count = 0, ignored = 0; const errors = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (auto && !/^(0?[1-9]|1[0-6])\.\d+\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) { ignored++; continue; }
    try {
      toast(`Импорт изображений: ${i + 1} из ${files.length}`, false, true);
      const v = await request(`/api/upload?kind=image&auto=${auto ? 1 : 0}&task=${state.editorTask}&name=${encodeURIComponent(f.name)}`, undefined, f);
      if (v.ignored) ignored++; else { state.data.editor = v.editor; count++; }
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  render(); toast(`Добавлено: ${count}. Пропущено по имени: ${ignored}.${errors.length ? ` Ошибок: ${errors.length}. ${errors[0]}` : ''}`, !!errors.length);
}
function applyZoom() {
  const el = document.querySelector('#task-content'), label = document.querySelector('#zoom-label');
  if (!el) return;
  el.classList.remove('zoom-75', 'zoom-100', 'zoom-150');
  const classes = ['', 'zoom-100', 'zoom-150', 'zoom-75'];
  if (classes[state.zoom]) el.classList.add(classes[state.zoom]);
  if (label) label.textContent = ['По ширине', '100%', '150%', '75%'][state.zoom];
}
const actions = {
  paper: async () => { state.paperOriginal = !state.paperOriginal; applyPaper(); },
  theme: async () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    state.data.theme = await request('/api/theme', { theme });
    // Change only the palette and toggle, preserving inputs, drafts and scroll.
    applyTheme(state.data.theme);
  },
  help: async () => {
    const sections = {
      home: ['Справка', 'Откройте файл .oge или .zip от организатора. Для тренировки доступен демонстрационный вариант с кодом DEMO-2026.\n\nВ редакторе можно создать собственный вариант.'],
      registration: ['Перед началом', 'Таймер начнётся после ввода данных и правильного кода активации. Для демонстрационного варианта: DEMO-2026.\n\nДля тренировки используйте вымышленные данные. Регистрация хранится на этом компьютере и не проверяется по государственным базам.'],
      exam: ['Работа с заданиями', 'В заданиях 1–12 введите краткий ответ. В заданиях 13–16 прикрепите файл. После каждого задания нажимайте «Сохранить» или Ctrl+Enter. Черновики не считаются сданными ответами.\n\nФайлы для работы доступны в заданиях 11–14. После изменения файла прикрепите его заново.\n\nТаймер не останавливается при закрытии окна или перезапуске.'],
      editor: ['Подготовка варианта', 'Имена изображений: 1.1.png, 1.2.png, 2.1.png и так далее. Импорт из папки распределяет их по номеру задания. Порядок лексикографический: 1.10.png раньше 1.2.png. Для числового порядка используйте 1.01.png, 1.02.png.\n\nВ задания 11–14 добавьте исходные файлы. Установите код активации перед экспортом.\n\nАвтопроверка необязательна. Для краткого ответа добавьте допустимые ответы; для файла выберите текст или программу с тестами. Нажмите «Применить». При переходе к другому заданию, экспорте или проверке изменения также сохраняются.\n\n«Сохранить проект» сохраняет эталоны. «Экспорт экзамена» проверяет все 16 заданий и удаляет эталоны из файла для учеников.'],
      review: ['Проверка работы', 'Откройте ZIP с результатами ученика из редактора проекта с эталонами. Проверяются только сданные ответы. Черновики не участвуют в проверке.\n\nПрограммы запускаются в изолированной среде с ограничениями. Недоступность среды или ошибка запуска отображаются отдельно. Задания без эталона проверяются учителем вручную.\n\nОтчёт можно скачать вместе с исходной работой. Итоговая оценка выставляется учителем.'],
      result: ['Результаты', 'Папка и ZIP содержат сохранённые ответы, отдельно черновики и регистрационные данные. Архив не зашифрован: передавайте его только организатору.\n\nЧисло сохранённых ответов не является оценкой. Учитель может проверить работу в редакторе своего проекта.']
    };
    const [title, message] = sections[state.mode] || sections.home;
    await new Promise(resolve => {
      modal.innerHTML = `<h2 id="modal-title">${V.esc(title)}</h2><p>${V.esc(message)}</p><div class="button-row"><button class="primary" data-choice="close" autofocus>Понятно</button></div>`;
      modal.onclick = e => { if (e.target.closest('[data-choice]')) modal.close(); };
      modal.onclose = () => { modal.onclick = null; modal.onclose = null; resolve(); };
      modal.showModal();
    });
  },
  home: async () => { if (state.mode === 'editor') await flushEditor(); state.mode = 'home'; await refresh(); render(); },
  editor: async () => { await refresh(); state.mode = 'editor'; render(); },
  registration: async () => { state.mode = 'registration'; render(); },
  'open-exam': async () => {
    const [file] = await pickFiles({ accept: '.oge,.zip' }); if (!file) return;
    toast('Проверяем файл экзамена…', false, true);
    state.data.exam = await request(`/api/upload?kind=package&name=${encodeURIComponent(file.name)}`, undefined, file);
    state.mode = 'registration'; render(); toast('Вариант загружен. Введите регистрационные данные.');
  },
  demo: async () => { state.data.exam = await request('/api/demo', {}); state.mode = 'registration'; render(); toast('Код демонстрационного экзамена: DEMO-2026. Используйте вымышленные данные.'); },
  task: async el => navigate(Number(el.dataset.id)), previous: async () => navigate(state.task.id - 1), next: async () => navigate(state.task.id + 1),
  save,
  attach: async () => {
    const [file] = await pickFiles(); if (!file) return;
    toast('Сохраняем копию выбранного файла…', false, true);
    state.task = await request(`/api/upload?kind=answer&task=${state.task.id}&name=${encodeURIComponent(file.name)}`, undefined, file);
    await refresh(); render(true); toast('Файл прикреплён. Теперь нажмите «Сохранить».');
  },
  'clear-answer': async () => {
    if (!await ask('Очистить ответ?', 'Сохранённый ответ и черновик этого задания будут очищены. Исходный файл на вашем компьютере не изменится.', 'Очистить', true)) return;
    await flushDraft(); const v = await request('/api/clear', { id: state.task.id }); state.task = v.task; state.data.session = v.session; render(true); toast('Ответ очищен.');
  },
  finish: async () => {
    await flushDraft(); await refresh(); if (state.data.session.status !== 'active') return;
    const a = state.data.session;
    if (!await ask('Завершить экзамен?', `Сохранено ответов: ${a.savedCount} из 16. Без ответа: ${16-a.savedCount}.\n${a.dirtyCount ? `Есть несохранённые изменения: ${a.dirtyCount}. ` : ''}Черновики попадут в отдельный раздел архива и не будут считаться сданными ответами.\nПосле завершения изменить ответы нельзя. Таймер продолжает идти, пока открыто это окно.`, 'Завершить экзамен', true)) return;
    toast('Собираем папку и ZIP с результатами…', false, true);
    state.data.session = await request('/api/finish', { confirm: true }); state.mode = 'result'; state.task = null; render(); toast('Экзамен завершён.');
  },
  fullscreen: async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); },
  'zoom-in': async () => { state.zoom = state.zoom === 3 ? 0 : Math.min(2, state.zoom + 1); applyZoom(); },
  'zoom-out': async () => { state.zoom = state.zoom === 0 ? 3 : state.zoom === 3 ? 3 : state.zoom - 1; applyZoom(); },
  'download-asset': async el => { await download(`/api/asset?id=${encodeURIComponent(el.dataset.id)}&download=1`, el.dataset.name); toast('Файл передан в загрузки браузера.'); },
  'editor-task': async el => { await flushEditor(); state.editorTask = Number(el.dataset.id); render(); },
  'checker-apply': async () => { await flushEditor(); render(); toast('Настройки проверки сохранены.'); },
  'checker-add-test': async () => { const draft = getCheckerDraft(); if (draft.tests.length >= 16) return; draft.tests.push({ input: '', expected: '' }); markCheckerDirty(); render(); },
  'checker-remove-test': async el => { const draft = getCheckerDraft(); if (draft.tests.length < 2) return; draft.tests.splice(Number(el.dataset.id), 1); markCheckerDirty(); render(); },
  'generate-code': async () => { await flushEditor(); const v = await request('/api/editor/update', { generateCode: true }); state.data.editor = v.editor; state.editorCode = v.code; render(); toast('Новый код установлен. Сохраните его отдельно и сообщите ученикам.'); },
  'set-code': async () => { await flushEditor(true); render(); toast('Название и код сохранены.'); },
  'import-images': async () => importImageFiles(await pickFiles({ directory: true }), true),
  'import-images-files': async () => importImageFiles(await pickFiles({ multiple: true, accept: imageAccept }), true),
  'add-image': async () => importImageFiles(await pickFiles({ multiple: true, accept: imageAccept }), false),
  'add-resource': async () => {
    const files = await pickFiles({ multiple: true }); if (!files.length) return; await flushEditor();
    for (const f of files) {
      const v = await request(`/api/upload?kind=resource&task=${state.editorTask}&name=${encodeURIComponent(f.name)}`, undefined, f); state.data.editor = v.editor;
    }
    render(); toast('Исходные файлы добавлены.');
  },
  'remove-asset': async el => {
    if (!await ask('Удалить файл из задания?', 'Файл будет удалён из проекта. Оригинал на компьютере останется без изменений.', 'Удалить', true)) return;
    await flushEditor(); state.data.editor = await request('/api/editor/remove', { id: el.dataset.id }); render(); toast('Файл удалён из задания.');
  },
  'export-project': async () => exportEditor(false), 'export-exam': async () => exportEditor(true),
  'open-project': async () => {
    const [file] = await pickFiles({ accept: '.oge,.zip' }); if (!file) return;
    if (!await ask('Открыть другой проект?', 'Текущий локальный проект будет заменён. Ранее скачанные проекты и экзамены сохранятся.', 'Открыть')) return;
    await flushEditor();
    toast('Проверяем проект…', false, true);
    state.data.editor = await request(`/api/upload?kind=package&edit=1&name=${encodeURIComponent(file.name)}`, undefined, file);
    state.editorTask = 1; state.editorCode = ''; pendingTitle = null; checkerDrafts.clear(); render(); toast('Проект открыт. Можно сохранить прежний код или установить новый.');
  },
  'new-project': async () => {
    if (!await ask('Начать новый проект?', 'Сначала скачайте текущий проект, если он нужен. Локальный рабочий проект будет заменён.', 'Создать')) return;
    await flushEditor(); state.data.editor = await request('/api/editor/new', {}); state.editorTask = 1; state.editorCode = ''; pendingTitle = null; checkerDrafts.clear(); render(); toast('Создан новый проект.');
  },
  'open-review': async () => {
    if (state.mode === 'editor') await flushEditor();
    const [file] = await pickFiles({ accept: '.zip' }); if (!file) return;
    toast('Открываем работу…', false, true);
    const work = await request(`/api/upload?kind=review&name=${encodeURIComponent(file.name)}`, undefined, file);
    state.review = work; state.assessment = null; state.allowUnmatched = false; state.mode = 'review'; render(); toast('Работа открыта.');
  },
  'back-editor': async () => { await refresh(); state.mode = 'editor'; render(); },
  'check-review': async () => {
    if (state.review.contextMatch !== true && !state.allowUnmatched) throw new Error('Подтвердите использование текущих эталонов.');
    toast('Проверяем ответы…', false, true);
    state.assessment = await request('/api/review/check', { id: state.review.id, allowUnmatched: state.allowUnmatched });
    render(); toast('Проверка завершена.');
  },
  'download-review': async () => { await download(`/api/review/report?id=${encodeURIComponent(state.review.id)}`, `OGE_${state.review.registration}_reviewed-results.zip`); toast('Отчёт передан в загрузки браузера.'); },
  'download-result': async () => { await download('/api/result', `OGE_${state.data.session.candidate.registration}_results.zip`); toast('Архив передан в загрузки браузера. Основная копия остаётся в папке результатов.'); },
  'open-folder': async () => { await request('/api/open-folder', {}); },
  'open-results': async () => { await request('/api/open-folder', { root: true }); },
  'retry-export': async () => { toast('Повторяем экспорт…', false, true); state.data.session = await request('/api/export/retry', {}); render(); toast(state.data.session.archiveReady ? 'Архив сформирован.' : 'Экспорт пока не завершён.', !state.data.session.archiveReady); },
  dismiss: async () => { state.data = await request('/api/dismiss', {}); state.mode = 'home'; render(); },
  quit: async () => {
    const active = state.data.session?.status === 'active';
    if (!await ask('Закрыть приложение?', active ? 'Экзамен не будет сдан досрочно. Время не ставится на паузу: после повторного запуска сеанс восстановится, а просроченный экзамен завершится автоматически. Для сдачи сейчас нажмите «Завершить».' : 'Все уже сохранённые проекты и результаты останутся на этом компьютере.', 'Закрыть приложение')) return;
    if (active) await flushDraft(); if (state.mode === 'editor') await flushEditor();
    await request('/api/quit', { confirm: true }); state.stopped = true;
    app.innerHTML = `<main class="loading"><h1>Приложение закрыто</h1><p>Эту вкладку можно закрыть. Для продолжения запустите симулятор через ярлык или start.sh.</p></main>`;
  }
};
async function exportEditor(publish) {
  await flushEditor(true); toast(publish ? 'Проверяем задания и собираем экзамен…' : 'Собираем проект…', false, true);
  const v = await request('/api/editor/export', { publish });
  await download(`/api/package?id=${encodeURIComponent(v.id)}`, publish ? 'exam.oge' : 'project.oge');
  render(); toast(publish ? 'Экзамен экспортирован. Передайте ученикам файл exam.oge, код — отдельно.' : 'Проект сохранён вместе с эталонами. Для учеников используйте «Экспорт экзамена».');
}
app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]'); if (!el || el.disabled) return;
  const action = actions[el.dataset.action]; if (action) { e.preventDefault(); run(() => action(el)); }
});
app.addEventListener('submit', e => {
  if (e.target.id !== 'registration-form') return;
  e.preventDefault(); const form = e.target, b = Object.fromEntries(new FormData(form));
  run(async () => {
    try {
      const code = b.code; delete b.code;
      state.data.session = await request('/api/start', { candidate: b, code });
      state.editorCode = ''; checkerDrafts.clear(); state.review = null; state.assessment = null; state.data.editor = null; state.task = await request('/api/task?id=1'); state.mode = 'exam'; render(); toast('Экзамен начался.');
    } catch (e) { const error = document.querySelector('#registration-error'); if (error) error.textContent = e.message; else throw e; }
  });
});
app.addEventListener('input', e => {
  if (e.target.id === 'answer-text') {
    state.task.text = e.target.value; pendingDraft = { id: state.task.id, text: e.target.value }; markDirty();
    clearTimeout(draftTimer); draftTimer = setTimeout(() => flushDraft().catch(e => toast(e.message, true)), 400);
  } else if (e.target.id === 'exam-title') {
    pendingTitle = e.target.value; clearTimeout(metaTimer); metaTimer = setTimeout(() => flushMeta().catch(e => toast(e.message, true)), 700);
  } else if (e.target.id === 'editor-code') state.editorCode = e.target.value;
  else if (state.mode === 'editor' && e.target.dataset.checkerField && !['enabled', 'mode'].includes(e.target.dataset.checkerField)) {
    const draft = getCheckerDraft(), field = e.target.dataset.checkerField;
    if (e.target.dataset.checkerTest !== undefined) draft.tests[Number(e.target.dataset.checkerTest)][field] = e.target.value;
    else draft[field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    markCheckerDirty();
  }
});
app.addEventListener('change', e => {
  if (state.mode === 'editor' && ['enabled', 'mode'].includes(e.target.dataset.checkerField)) {
    const draft = getCheckerDraft(); draft.mode = e.target.dataset.checkerField === 'enabled' ? e.target.checked ? 'short' : 'manual' : e.target.value;
    markCheckerDirty(); render();
  } else if (state.mode === 'editor' && e.target.dataset.checkerField === 'language') render();
  else if (e.target.id === 'review-allow-unmatched') {
    state.allowUnmatched = e.target.checked;
    const button = document.querySelector('[data-action="check-review"]'); if (button) button.disabled = !state.allowUnmatched;
  }
});
app.addEventListener('toggle', e => { if (e.target.id === 'checker-panel' && state.mode === 'editor') getCheckerDraft().open = e.target.open; }, true);
app.addEventListener('dragover', e => { if (state.mode === 'editor' && e.target.closest('#drop-area')) { e.preventDefault(); document.querySelector('#drop-area').classList.add('drag-over'); } });
app.addEventListener('dragleave', e => { if (e.target.closest('#drop-area')) document.querySelector('#drop-area')?.classList.remove('drag-over'); });
app.addEventListener('drop', e => {
  if (state.mode !== 'editor' || !e.target.closest('#drop-area')) return;
  e.preventDefault(); document.querySelector('#drop-area').classList.remove('drag-over'); const files = [...e.dataTransfer.files]; run(() => importImageFiles(files, false));
});
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.mode === 'exam' && !modal.open) { e.preventDefault(); run(save); } });
window.addEventListener('beforeunload', e => { if (!state.stopped && (state.data?.session?.status === 'active' || pendingTitle !== null || [...checkerDrafts.values()].some(draft => draft.dirty))) { e.preventDefault(); e.returnValue = ''; } });
async function boot() {
  if (!token) {
    app.innerHTML = `<main class="loading"><h1>Откройте приложение через ярлык</h1><p>Страница без локального ключа не имеет доступа к экзаменам. Запустите start.sh или откройте приватный файл OPEN-IN-BROWSER.html в папке данных приложения.</p></main>`; return;
  }
  try {
    await refresh();
    if (state.data.session?.status === 'active') { state.task = await request(`/api/task?id=${state.data.session.currentTask}`); state.mode = 'exam'; }
    else if (state.data.session?.status === 'finished') state.mode = 'result';
    render(); if (state.data.session?.recovered) toast('Сеанс восстановлен. Ответы сохранены, таймер не обнулён.');
  } catch (e) { app.innerHTML = `<main class="loading"><h1>Не удалось открыть приложение</h1><p>${V.esc(e.message)}</p><p>Повторно запустите симулятор через start.sh.</p></main>`; }
}
setInterval(async () => {
  if (polling || state.stopped || state.mode !== 'exam') return; polling = true;
  try {
    await refresh();
    const timer = document.querySelector('#timer');
    if (timer) { timer.textContent = V.time(state.data.session.remainingMs); timer.parentElement.classList.toggle('urgent', state.data.session.remainingMs <= 300000); updateNav(); }
    const banner = document.querySelector('#connection-banner');
    if (banner) { banner.hidden = !state.data.warning; banner.textContent = state.data.warning || ''; }
  } catch (e) {
    const banner = document.querySelector('#connection-banner'); if (banner) { banner.hidden = false; banner.textContent = 'Связь с приложением потеряна. Таймер не ставится на паузу. Не закрывайте страницу; сообщите организатору.'; }
  } finally { polling = false; }
}, 1000);
boot();
