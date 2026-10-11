export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fmtSize = n => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
export const pad = n => String(n).padStart(2, '0');
export function time(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
export function icon(name, cls = '') {
  const paths = {
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>', download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    check: '<path d="m5 12 4 4L19 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
    file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 13h8M8 17h5"/>', folder: '<path d="M3 7V5h6l3 3h9v12H3z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    screen: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4M12 17h.01"/>',
    power: '<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
    moon: '<path d="M20.9 13.1A9 9 0 0 1 10.9 3.1a9 9 0 1 0 10 10z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-3-9-1.4 1.4M7.4 16.6 6 18m12 0-1.4-1.4M7.4 7.4 6 6"/>',
    contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  };
  return `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
export function header(section = 'ОГЭ по информатике', right = '') {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<header class="topbar" aria-label="${esc(section)}">
    <div class="brand"><img src="/icon.svg" width="36" height="36" alt=""><strong>Симулятор экзамена</strong></div>
    <div class="header-actions">${right}
      <button class="icon-button theme-toggle" data-action="theme" title="${dark ? 'Включить светлую тему' : 'Включить ночную тему'}" aria-label="Ночная тема" aria-pressed="${dark}">${icon(dark ? 'sun' : 'moon')}</button>
      <button class="icon-button" data-action="help" title="Справка" aria-label="Справка">${icon('help')}</button>
      <button class="icon-button" data-action="quit" title="Закрыть приложение" aria-label="Закрыть приложение">${icon('power')}</button>
    </div>
  </header>`;
}
const warning = s => s.warning ? `<div class="warning-banner" role="alert">${esc(s.warning)}</div>` : '';
export function home(s) {
  return header() + warning(s) + `<main class="home">
    <div class="home-content">
      <div class="home-intro"><h1>ОГЭ по информатике</h1><p class="home-meta"><span>16 заданий</span><span>150 минут</span></p></div>
      <div class="home-actions">
        <button class="primary" data-action="open-exam">${icon('folder')} Открыть экзамен ${icon('arrow')}</button>
        <button class="text-button demo-button" data-action="demo">Демонстрационный вариант ${icon('arrow')}</button>
      </div>
      ${s.exam ? `<div class="loaded-exam"><strong>${esc(s.exam.title)}</strong><button class="primary" data-action="registration">Продолжить ${icon('arrow')}</button></div>` : ''}
      <div class="home-utilities">
        <button class="text-button" data-action="editor">${icon('edit')} Редактор экзамена ${icon('arrow')}</button>
        <button class="text-button" data-action="open-results" title="Открыть папку результатов">${icon('folder')} Результаты ${icon('arrow')}</button>
      </div>
    </div>
    <footer class="home-footer"><span>${esc(s.version)}</span></footer>
  </main>`;
}
export function registration(s) {
  return header('Регистрация участника', `<button class="text-button" data-action="home">${icon('back')} На главную</button>`) + `<main class="registration">
    <div class="page-heading"><h1>Регистрация</h1><p>Таймер начнётся после активации.</p></div>
    <div class="registration-grid">
      <form id="registration-form" class="registration-form">
        <label>Номер бланка<input name="registration" inputmode="numeric" pattern="[0-9]{1,32}" maxlength="32" placeholder="00012345" autocomplete="off" required></label>
        <div class="field-row"><label>Фамилия<input name="surname" placeholder="Иванов" maxlength="80" autocomplete="off" required></label><label>Имя<input name="name" placeholder="Иван" maxlength="80" autocomplete="off" required></label></div>
        <div class="field-row passport-row"><label>Серия паспорта<input name="passportSeries" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" placeholder="0000" autocomplete="off" required></label><label>Номер паспорта<input name="passportNumber" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" autocomplete="off" required></label></div>
        <p class="form-note">Для тренировки используйте вымышленные данные.</p>
        <div class="activation-box"><label>Код активации<input name="code" type="text" placeholder="Введите код" maxlength="128" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
        </div>
        <button class="primary wide" type="submit">Начать экзамен ${icon('arrow')}</button>
        <p id="registration-error" class="form-error" role="alert"></p>
      </form>
      <aside class="registration-summary">
        <h2>${esc(s.exam?.title || 'Экзамен')}</h2><div class="large-time">150 <span>минут</span></div><p>16 заданий</p>
        <hr><div class="summary-row"><strong>01–12</strong><span>Краткий ответ</span></div><div class="summary-row"><strong>13–16</strong><span>Ответ файлом</span></div>
        <hr><p class="summary-note">Без паузы. Таймер продолжит отсчёт после закрытия приложения.</p>
      </aside>
    </div>
  </main>`;
}
export function nav(s, current) {
  const a = s.session;
  return `<div class="nav-heading"><h2>Задания</h2><span id="saved-count">${a.savedCount} / 16</span></div>
    <nav class="task-grid" aria-label="Переход к заданию">${a.statuses.map(t => `<button class="task-number ${t.id === current ? 'current' : ''} ${t.saved ? 'saved' : ''} ${t.dirty ? 'dirty' : ''}" data-action="task" data-id="${t.id}" aria-current="${t.id === current ? 'step' : 'false'}" aria-label="Задание ${t.id}. ${t.saved ? 'Ответ сохранён' : 'Нет ответа'}${t.dirty ? '. Есть несохранённые изменения' : ''}">${pad(t.id)}${t.saved ? `<span class="mini-check">${icon('check')}</span>` : ''}${t.dirty ? '<span class="draft-dot"></span>' : ''}</button>`).join('')}</nav>
    <div class="legend"><span><i class="legend-saved"></i>Сохранено</span><span><i class="legend-draft"></i>Черновик</span></div>`;
}
export function imageStack(images, removable = false) {
  if (!images.length) return `<div class="empty-media">${icon('file')}<strong>Добавьте условие задания</strong><span>Изображение до 16 МБ</span></div>`;
  return `<div class="image-stack">${images.map((a, i) => `<figure class="task-image">${removable ? `<figcaption><span>${esc(a.name)}</span><span><button class="icon-button danger-text" data-action="remove-asset" data-id="${esc(a.id)}" title="Удалить изображение" aria-label="Удалить ${esc(a.name)}">${icon('close')}</button></span></figcaption>` : images.length > 1 ? `<figcaption><span>Страница ${i + 1} из ${images.length}</span></figcaption>` : ''}<div class="image-holder"><img data-image-id="${esc(a.id)}" alt="Условие задания, страница ${i + 1} из ${images.length}"></div></figure>`).join('')}</div>`;
}
export function resourceList(resources, editable = false) {
  if (!resources.length) return '<p class="muted small">Файлы не добавлены.</p>';
  return `<div class="resource-list">${resources.map(a => `<div class="resource-row"><span class="file-symbol">${icon('file')}</span><div><strong>${esc(a.name)}</strong><span>${fmtSize(a.size)}</span></div><button class="secondary compact" data-action="download-asset" data-id="${esc(a.id)}" data-name="${esc(a.name)}">${icon('download')} Скачать</button>${editable ? `<button class="icon-button danger-text" data-action="remove-asset" data-id="${esc(a.id)}" aria-label="Удалить ${esc(a.name)}">${icon('close')}</button>` : ''}</div>`).join('')}</div>`;
}
export function exam(s, task) {
  const a = s.session, file = task.draftFile || task.savedFile;
  const saved = task.savedAt ? `Сохранено в ${new Date(task.savedAt).toLocaleTimeString('ru-RU')}` : 'Не сохранено';
  return header('Идёт экзамен', `<button class="icon-button" data-action="fullscreen" title="Полный экран" aria-label="Полный экран">${icon('screen')}</button><button class="finish-button" data-action="finish" aria-label="Завершить экзамен">Завершить</button>`) + `<div id="connection-banner" class="connection-banner" hidden></div>
    <main class="exam-layout">
      <aside class="exam-sidebar">
        <div class="timer-box"><span>Осталось</span><strong id="timer">${time(a.remainingMs)}</strong></div>
        <div id="task-nav">${nav(s, task.id)}</div>
        <div class="candidate-mini"><strong>${esc(a.candidate.surname)} ${esc(a.candidate.name)}</strong><span>Бланк ${esc(a.candidate.registration)}</span></div>
      </aside>
      <section class="exam-main">
        <div class="task-heading"><h1>Задание ${pad(task.id)}</h1>
          <div class="task-tools"><button class="icon-button paper-toggle" data-action="paper" title="Показать оригинальную яркость условия" aria-label="Оригинальная яркость условия" aria-pressed="false">${icon('contrast')}</button><div class="zoom-controls" aria-label="Масштаб условия"><button data-action="zoom-out" title="Уменьшить" aria-label="Уменьшить условие">−</button><span id="zoom-label">По ширине</span><button data-action="zoom-in" title="Увеличить" aria-label="Увеличить условие">+</button></div></div>
        </div>
        <div class="task-content" id="task-content">${task.hasResources ? `<section class="resources-panel"><h2>Файлы для работы</h2>${resourceList(task.resources)}</section>` : ''}${imageStack(task.images)}</div>
        <div class="answer-panel">
          <div class="answer-label">${task.kind === 'short' ? '<label for="answer-text">Ответ</label>' : '<span>Файл ответа</span>'}<span id="answer-status" class="small ${task.dirty ? 'amber-text' : 'muted'}">${task.dirty ? 'Черновик' : saved}</span></div>
          ${task.kind === 'short' ? `<div class="answer-row"><input id="answer-text" value="${esc(task.text)}" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Введите ответ"><button class="primary" data-action="save" aria-label="Сохранить ответ">${icon('check')} Сохранить</button></div>` : `<div class="answer-row file-answer"><div class="chosen-file">${icon('file')}<div><strong>${file ? esc(file.name) : 'Файл не выбран'}</strong>${file ? `<span>${fmtSize(file.size)}</span>` : ''}</div></div><button class="secondary" data-action="attach">${icon('upload')} ${file ? 'Заменить файл' : 'Прикрепить файл'}</button><button class="primary" data-action="save" aria-label="Сохранить ответ">${icon('check')} Сохранить</button></div><p class="small muted file-hint">После изменения файла прикрепите его заново.</p>`}
          <div class="answer-meta"><span title="Сохранить ответ">Ctrl + Enter</span>${task.savedAt || file ? '<button class="text-button small danger-text" data-action="clear-answer">Очистить ответ</button>' : ''}</div>
        </div>
        <footer class="task-footer"><button class="secondary" data-action="previous" aria-label="Предыдущее задание" ${task.id === 1 ? 'disabled' : ''}>${icon('back')} Назад</button><span>${task.id} из 16</span><button class="secondary" data-action="next" aria-label="Следующее задание" ${task.id === 16 ? 'disabled' : ''}>Далее ${icon('arrow')}</button></footer>
      </section>
    </main>`;
}
export function officeCriterionDefaults(type, kind = type === 'spreadsheet' ? 'cellValue' : 'slideCount') {
  const defaults = {
    cellValue: { sheet: 'Лист1', cell: 'A1', mode: 'text', expected: '', caseSensitive: true, tolerance: 0 },
    cellFormula: { sheet: 'Лист1', cell: 'A1', expected: '' }, sheetCount: { expected: 1 },
    sheetExists: { sheet: 'Лист1' }, chartCount: { sheet: 'Лист1', minimum: 1 },
    slideCount: { expected: 1 }, slideText: { slide: 1, expected: '', comparison: 'contains', caseSensitive: true },
    imageCount: { slide: 1, minimum: 1 }
  };
  return { kind, ...defaults[kind] };
}
const officeKinds = {
  spreadsheet: [['cellValue', 'Значение ячейки'], ['cellFormula', 'Формула ячейки'], ['sheetCount', 'Количество листов'], ['sheetExists', 'Наличие листа'], ['chartCount', 'Количество диаграмм']],
  presentation: [['slideCount', 'Количество слайдов'], ['slideText', 'Текст слайда'], ['imageCount', 'Количество изображений']]
};
function officeCriteriaPanel(c) {
  const criteria = c[`${c.mode}Criteria`];
  return `<p class="small muted">${c.mode === 'spreadsheet' ? 'ODS, XLSX · значения из сохранённого файла, без пересчёта формул.' : 'ODP, PPTX'}</p><div class="checker-criteria">${criteria.map((item, index) => {
    const field = (name, label, attrs = '', value = item[name]) => `<label>${label}<input data-checker-criterion="${index}" data-checker-field="${name}" value="${esc(value)}" ${attrs}></label>`;
    const sheet = field('sheet', 'Лист', 'maxlength="128" autocomplete="off"');
    const cell = field('cell', 'Ячейка', 'maxlength="12" pattern="[A-Za-z]{1,3}[1-9][0-9]{0,6}" placeholder="A1" autocomplete="off" spellcheck="false"');
    const slide = field('slide', 'Слайд', 'type="number" min="1" max="256" step="1"');
    const expectedText = label => `<label>${label}<textarea data-checker-criterion="${index}" data-checker-field="expected" rows="2" maxlength="4096" spellcheck="false">${esc(item.expected)}</textarea></label>`;
    const sensitive = `<label class="check-option"><input type="checkbox" data-checker-criterion="${index}" data-checker-field="caseSensitive" ${item.caseSensitive ? 'checked' : ''}> Учитывать регистр</label>`;
    let fields = '';
    if (item.kind === 'cellValue') fields = `<div class="checker-field-row">${sheet}${cell}</div><div class="checker-field-row"><label>Тип значения<select data-checker-criterion="${index}" data-checker-field="mode"><option value="text" ${item.mode === 'text' ? 'selected' : ''}>Текст</option><option value="number" ${item.mode === 'number' ? 'selected' : ''}>Число</option></select></label>${item.mode === 'number' ? field('expected', 'Ожидаемое число', 'type="number" step="any"') : expectedText('Ожидаемый текст')}</div>${item.mode === 'number' ? field('tolerance', 'Допустимая погрешность', 'type="number" min="0" step="any"', item.tolerance ?? 0) : sensitive}`;
    else if (item.kind === 'cellFormula') fields = `<div class="checker-field-row">${sheet}${cell}</div>${field('expected', 'Ожидаемая формула', 'maxlength="4096" autocomplete="off" spellcheck="false" placeholder="=SUM(A1:A5)"')}`;
    else if (item.kind === 'sheetCount') fields = field('expected', 'Количество листов', 'type="number" min="1" max="256" step="1"');
    else if (item.kind === 'sheetExists') fields = sheet;
    else if (item.kind === 'chartCount') fields = `<div class="checker-field-row">${sheet}${field('minimum', 'Минимум диаграмм', 'type="number" min="1" max="1024" step="1"')}</div>`;
    else if (item.kind === 'slideCount') fields = field('expected', 'Количество слайдов', 'type="number" min="1" max="256" step="1"');
    else if (item.kind === 'slideText') fields = `<div class="checker-field-row">${slide}<label>Сравнение<select data-checker-criterion="${index}" data-checker-field="comparison"><option value="contains" ${item.comparison === 'contains' ? 'selected' : ''}>Содержит текст</option><option value="exact" ${item.comparison === 'exact' ? 'selected' : ''}>Точное совпадение</option></select></label></div>${expectedText('Ожидаемый текст')}${sensitive}`;
    else if (item.kind === 'imageCount') fields = `<div class="checker-field-row">${slide}${field('minimum', 'Минимум изображений', 'type="number" min="1" max="1024" step="1"')}</div>`;
    return `<section class="checker-criterion"><div class="split"><h3>Критерий ${index + 1}</h3><button class="icon-button danger-text" data-action="checker-remove-criterion" data-id="${index}" aria-label="Удалить критерий ${index + 1}">${icon('close')}</button></div><label>Критерий<select data-checker-criterion="${index}" data-checker-field="kind">${officeKinds[c.mode].map(([kind, label]) => `<option value="${kind}" ${item.kind === kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${fields}</section>`;
  }).join('')}</div><button class="text-button checker-add-test" data-action="checker-add-criterion" ${criteria.length >= 32 ? 'disabled' : ''}>${icon('plus')} Добавить критерий <span class="muted small">${criteria.length} / 32</span></button>`;
}
export function checkerPanel(task, draft, checking = {}) {
  const c = draft || { mode: task.checker?.type || 'manual', answersText: task.checker?.answers?.join('\n') || '', expected: task.checker?.expected || '', caseSensitive: task.checker?.caseSensitive !== false, ignoreWhitespace: !!task.checker?.ignoreWhitespace, comparison: task.checker?.comparison || 'trim', language: task.checker?.language || 'python', tests: task.checker?.tests || [{ input: '', expected: '' }], spreadsheetCriteria: task.checker?.type === 'spreadsheet' ? task.checker.criteria : [officeCriterionDefaults('spreadsheet')], presentationCriteria: task.checker?.type === 'presentation' ? task.checker.criteria : [officeCriterionDefaults('presentation')], dirty: false, open: !!task.checker };
  const enabled = c.mode !== 'manual';
  const comparison = `<label>Сравнение<select data-checker-field="comparison"><option value="trim" ${c.comparison === 'trim' ? 'selected' : ''}>Без пробелов по краям</option><option value="exact" ${c.comparison === 'exact' ? 'selected' : ''}>Точное совпадение</option></select></label>`;
  return `<details class="checker-panel" id="checker-panel" ${c.open || c.dirty ? 'open' : ''}><summary><span>Автопроверка</span><span class="checker-summary ${c.dirty ? 'amber-text' : ''}" id="checker-summary">${c.dirty ? 'Не применено' : enabled ? 'Настроена' : 'Не настроена'}</span></summary><div class="checker-body">
    ${task.kind === 'short' ? `<label class="check-option"><input type="checkbox" data-checker-field="enabled" ${enabled ? 'checked' : ''}> Проверять ответ</label>` : `<label>Способ проверки<select data-checker-field="mode"><option value="manual" ${c.mode === 'manual' ? 'selected' : ''}>Ручная проверка</option><option value="text" ${c.mode === 'text' ? 'selected' : ''}>Текстовый файл</option><option value="code" ${c.mode === 'code' ? 'selected' : ''}>Программа</option><option value="spreadsheet" ${c.mode === 'spreadsheet' ? 'selected' : ''}>Электронная таблица</option><option value="presentation" ${c.mode === 'presentation' ? 'selected' : ''}>Презентация</option></select></label>`}
    ${c.mode === 'short' ? `<label>Правильные ответы<textarea data-checker-field="answersText" rows="3" maxlength="16384" spellcheck="false" placeholder="Один допустимый ответ на строке">${esc(c.answersText)}</textarea></label><details class="checker-options"><summary>Параметры сравнения</summary><div class="checker-options-body"><label class="check-option"><input type="checkbox" data-checker-field="caseSensitive" ${c.caseSensitive ? 'checked' : ''}> Учитывать регистр</label><label class="check-option"><input type="checkbox" data-checker-field="ignoreWhitespace" ${c.ignoreWhitespace ? 'checked' : ''}> Не учитывать пробелы</label></div></details>` : ''}
    ${c.mode === 'text' ? `<label>Ожидаемое содержимое файла<textarea data-checker-field="expected" rows="4" maxlength="65536" spellcheck="false">${esc(c.expected)}</textarea></label><div class="checker-field-row">${comparison}<label class="check-option"><input type="checkbox" data-checker-field="caseSensitive" ${c.caseSensitive ? 'checked' : ''}> Учитывать регистр</label></div>` : ''}
    ${c.mode === 'code' ? `<div class="checker-field-row"><label>Язык<select data-checker-field="language"><option value="python" ${c.language === 'python' ? 'selected' : ''}>Python 3</option><option value="javascript" ${c.language === 'javascript' ? 'selected' : ''}>JavaScript · Node.js</option></select></label>${comparison}</div>${!checking.available || !checking.languages?.[c.language] ? `<p class="checker-runtime-note">${esc(checking.message || 'Среда запуска этого языка недоступна на этом компьютере. Настройки можно сохранить для проверки на другом компьютере.')}</p>` : ''}<div class="checker-tests">${c.tests.map((test, i) => `<section class="checker-test"><div class="split"><h3>Тест ${i + 1}</h3><button class="icon-button danger-text" data-action="checker-remove-test" data-id="${i}" aria-label="Удалить тест ${i + 1}" ${c.tests.length < 2 ? 'disabled' : ''}>${icon('close')}</button></div><div class="checker-field-row"><label>Входные данные<textarea data-checker-test="${i}" data-checker-field="input" rows="3" maxlength="65536" spellcheck="false">${esc(test.input)}</textarea></label><label>Ожидаемый вывод<textarea data-checker-test="${i}" data-checker-field="expected" rows="3" maxlength="65536" spellcheck="false">${esc(test.expected)}</textarea></label></div></section>`).join('')}</div><button class="text-button checker-add-test" data-action="checker-add-test" ${c.tests.length >= 16 ? 'disabled' : ''}>${icon('plus')} Добавить тест <span class="muted small">${c.tests.length} / 16</span></button>` : ''}
    ${['spreadsheet', 'presentation'].includes(c.mode) ? officeCriteriaPanel(c) : ''}
    <div class="checker-footer"><p class="small muted">Эталоны сохраняются в проекте и не попадают в экзамен для ученика.</p><button class="secondary compact" data-action="checker-apply" ${!c.dirty ? 'disabled' : ''}>Применить</button></div>
  </div></details>`;
}
export function editor(s, selected, currentCode = '', checkerDraft) {
  const e = s.editor, t = e.tasks[selected - 1];
  const complete = e.tasks.filter(x => x.images.length && (!x.hasResources || x.resources.length)).length;
  return header('Редактор экзамена', `<button class="text-button" data-action="home">${icon('back')} На главную</button>`) + `<main class="editor-page">
    <div class="editor-top"><h1>Редактор экзамена</h1><div class="button-row"><button class="secondary" data-action="export-project">Сохранить проект</button><button class="primary" data-action="export-exam">${icon('download')} Экспорт экзамена</button></div></div>
    <div class="editor-settings"><label>Название<input id="exam-title" maxlength="160" value="${esc(e.title)}"></label>
      <div class="code-settings"><label>Код активации<input id="editor-code" value="${esc(currentCode)}" maxlength="128" placeholder="${e.hasActivation ? 'Код установлен' : 'Введите код'}" autocomplete="off"></label><button class="icon-button" data-action="generate-code" title="Сгенерировать новый код" aria-label="Сгенерировать код">${icon('refresh')}</button><button class="secondary compact" data-action="set-code">Применить</button></div>
    </div>
    <div class="editor-toolbar"><div class="button-row"><button class="secondary" data-action="import-images">${icon('folder')} Импорт из папки</button><button class="text-button" data-action="import-images-files">Выбрать изображения</button></div><div class="button-row"><button class="text-button" data-action="open-review">${icon('check')} Проверить работу</button><button class="text-button" data-action="open-project">Открыть проект</button><button class="text-button danger-text" data-action="new-project">Новый проект</button></div></div>
    <p class="import-note"><strong>${complete} / 16</strong> заданий готово</p>
    <div class="editor-layout">
      <nav class="editor-nav" aria-label="Задания редактора">${e.tasks.map(x => `<button data-action="editor-task" data-id="${x.id}" class="${x.id === selected ? 'selected' : ''}" aria-current="${x.id === selected ? 'step' : 'false'}" aria-label="Задание ${x.id}: ${x.images.length} изображений${x.hasResources ? `, ${x.resources.length} файлов` : ''}"><span class="editor-task-id">${pad(x.id)}</span><span><strong>${x.kind === 'short' ? 'Краткий ответ' : 'Ответ файлом'}</strong><small>${x.images.length} изобр.${x.hasResources ? ` · ${x.resources.length} файл.` : ''}</small></span>${x.images.length && (!x.hasResources || x.resources.length) ? icon('check','ready-check') : '<span class="empty-dot"></span>'}</button>`).join('')}</nav>
      <section class="editor-canvas">
        <div class="editor-task-heading"><div><h2>Задание ${pad(selected)}</h2><p>${t.kind === 'short' ? 'Краткий ответ' : 'Ответ файлом'}</p></div><div class="button-row"><button class="icon-button paper-toggle" data-action="paper" title="Показать оригинальную яркость условия" aria-label="Оригинальная яркость условия" aria-pressed="false">${icon('contrast')}</button><button class="secondary" data-action="add-image">${icon('plus')} Добавить изображение</button></div></div>
        ${t.hasResources ? `<section class="resources-panel"><div class="split"><h3>Исходные файлы</h3><button class="text-button" data-action="add-resource">${icon('plus')} Добавить файлы</button></div>${resourceList(t.resources, true)}</section>` : ''}
        ${checkerPanel(t, checkerDraft, s.checking)}
        <div class="drop-area" id="drop-area">${imageStack(t.images, true)}</div>
        <div class="canvas-footnote">Условия сохраняются автоматически</div>
      </section>
    </div>
  </main>`;
}
const reviewStatuses = { correct: 'Верно', incorrect: 'Неверно', unanswered: 'Нет ответа', manual: 'Ручная проверка', error: 'Ошибка проверки', unavailable: 'Проверка недоступна' };
function reviewCriteria(criteria) {
  if (!criteria?.length) return '';
  const value = input => input === null ? 'Не найдено' : typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input);
  return `<details class="review-details review-criteria"><summary>Критерии проверки <span class="muted">${criteria.filter(item => item.status === 'correct').length} / ${criteria.length}</span></summary>${criteria.map((item, index) => {
    const status = Object.hasOwn(reviewStatuses, item.status) ? item.status : 'error';
    return `<section class="review-criterion"><div class="split"><strong>${esc(item.label || `Критерий ${item.index || index + 1}`)}</strong><span class="review-status ${status}">${reviewStatuses[status]}</span></div>${item.message ? `<p class="review-message">${esc(item.message)}</p>` : ''}${item.actual !== undefined || item.expected !== undefined ? `<div class="review-criterion-values">${item.expected !== undefined ? `<div><span>Ожидаемое</span><pre>${esc(value(item.expected))}</pre></div>` : ''}${item.actual !== undefined ? `<div><span>Полученное</span><pre>${esc(value(item.actual))}</pre></div>` : ''}</div>` : ''}</section>`;
  }).join('')}</details>`;
}
export function review(s, work, assessment, allowUnmatched = false) {
  const summary = assessment?.summary;
  return header('Проверка работы', `<button class="text-button" data-action="back-editor">${icon('back')} В редактор</button>`) + `<main class="review-page"><div class="review-heading"><div><h1>Проверка работы</h1><p>${esc(work.title)}</p></div><button class="secondary" data-action="open-review">${icon('folder')} Другая работа</button></div>
    <section class="review-candidate"><div><h2>${esc(work.surname)} ${esc(work.name)}</h2><p>Бланк ${esc(work.registration)}</p></div><span>${work.savedCount} / 16 ответов${work.draftCount ? ` · Черновиков: ${work.draftCount}` : ''}</span></section>
    ${work.contextMatch !== true ? `<div class="review-context"><p>${work.contextMatch === false ? 'Условия работы отличаются от открытого проекта. Сопоставьте вариант перед проверкой.' : 'В этом ZIP нет состава условий. Сопоставьте вариант с проектом перед проверкой.'}</p><label class="check-option"><input id="review-allow-unmatched" type="checkbox" ${allowUnmatched ? 'checked' : ''}> Использовать текущие эталоны</label></div>` : ''}
    <div class="review-actions"><button class="primary" data-action="check-review" ${work.contextMatch !== true && !allowUnmatched ? 'disabled' : ''}>${icon('check')} ${assessment ? 'Проверить снова' : 'Проверить'}</button>${assessment ? `<button class="secondary" data-action="download-review">${icon('download')} Скачать отчёт</button>` : ''}<span class="small muted">Проверяются только сданные ответы.</span></div>
    ${summary ? `<div class="review-summary" aria-label="Результат автопроверки"><div class="correct"><strong>${summary.correct}</strong><span>Верно</span></div><div class="incorrect"><strong>${summary.incorrect}</strong><span>Неверно</span></div><div><strong>${summary.manual}</strong><span>Вручную</span></div><div><strong>${summary.unanswered}</strong><span>Без ответа</span></div>${summary.error || summary.unavailable ? `<div class="review-summary-error"><strong>${summary.error + summary.unavailable}</strong><span>Не проверено</span></div>` : ''}</div>` : ''}
    <div class="review-task-list">${(assessment?.tasks || work.answers).map(task => { const answer = work.answers.find(a => a.id === task.id) || task; return `<section class="review-task"><div class="review-task-title"><h3>Задание ${pad(task.id)}</h3>${task.status ? `<span class="review-status ${esc(task.status)}">${esc(reviewStatuses[task.status] || task.status)}</span>` : ''}</div>${answer.kind === 'short' ? `<p class="review-answer">${answer.text ? esc(answer.text) : '<span class="muted">Ответ не сдан</span>'}</p>` : `<p class="review-file">${icon('file')} ${answer.fileName ? esc(answer.fileName) : '<span class="muted">Файл не сдан</span>'}</p>`}${task.message ? `<p class="review-message">${esc(task.message)}</p>` : ''}${task.actual !== undefined && answer.kind !== 'short' ? `<details class="review-details"><summary>Полученный результат</summary><pre>${esc(task.actual)}</pre></details>` : ''}${task.tests?.length ? `<details class="review-details"><summary>Тесты программы</summary>${task.tests.map((test, i) => `<div class="review-test"><div class="split"><strong>Тест ${i + 1}</strong><span class="review-status ${esc(test.status || '')}">${esc(reviewStatuses[test.status] || test.message || '')}</span></div>${test.message ? `<p>${esc(test.message)}</p>` : ''}${test.actual !== undefined ? `<pre>${esc(test.actual)}</pre>` : ''}</div>`).join('')}</details>` : ''}${reviewCriteria(task.criteria)}</section>`; }).join('')}</div>
  </main>`;
}
export function result(s) {
  const a = s.session;
  return header('Экзамен завершён') + `<main class="result-page"><div class="result-mark">${icon('check')}</div><h1>Экзамен завершён</h1>${a.finishReason === 'timeout' ? '<p class="result-subtitle">Время истекло.</p>' : ''}
    <section class="result-card"><div class="result-top"><div><span class="muted small">${esc(a.title)}</span><h2>${esc(a.candidate.surname)} ${esc(a.candidate.name)}</h2><p>Бланк ${esc(a.candidate.registration)}</p></div><div class="result-score"><strong>${a.savedCount}<span> / 16</span></strong><span>сохранено ответов</span></div></div>
      <div class="result-tasks">${a.statuses.map(t => `<span class="${t.saved ? 'saved' : ''}" title="Задание ${t.id}: ${t.saved ? 'сохранено' : 'нет ответа'}">${pad(t.id)}${t.saved ? icon('check') : ''}</span>`).join('')}</div>
      ${a.dirtyCount ? `<p class="draft-warning">Черновиков: ${a.dirtyCount}. Они сохранены отдельно от сданных ответов.</p>` : ''}<hr>
      ${a.archiveReady ? `<h3>${icon('folder')} Результаты сохранены</h3><div class="button-row"><button class="primary" data-action="download-result">${icon('download')} Скачать ZIP</button><button class="secondary" data-action="open-folder">Открыть папку</button></div><details class="result-location"><summary>Расположение файлов</summary><p class="path-text">${esc(a.resultDir)}</p></details>` : `<h3>Ответы сохранены в локальном сеансе</h3><p class="form-error">${esc(a.exportError || 'Не удалось завершить экспорт. Проверьте свободное место.')}</p><button class="primary" data-action="retry-export">${icon('refresh')} Повторить экспорт</button>`}
      <p class="privacy-note">${icon('lock')} ZIP содержит регистрационные данные. Передайте его организатору.</p>
    </section><button class="text-button" data-action="dismiss">На главную ${icon('arrow')}</button>
  </main>`;
}
