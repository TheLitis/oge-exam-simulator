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
      <div class="home-grid">
        <button class="start-panel choice-card" data-action="open-exam">
          <span class="section-icon">${icon('folder')}</span><span class="choice-title">Открыть экзамен</span>
          <span class="choice-meta">.oge · .zip</span>${icon('arrow', 'choice-arrow')}
        </button>
        <button class="create-panel choice-card" data-action="editor">
          <span class="section-icon">${icon('edit')}</span><span class="choice-title">Редактор экзамена</span>
          <span class="choice-meta">Создать или изменить вариант</span>${icon('arrow', 'choice-arrow')}
        </button>
      </div>
      <button class="text-button demo-button" data-action="demo">Демонстрационный вариант ${icon('arrow')}</button>
      ${s.exam ? `<div class="loaded-exam"><strong>${esc(s.exam.title)}</strong><button class="primary" data-action="registration">Продолжить ${icon('arrow')}</button></div>` : ''}
    </div>
    <footer class="home-footer"><button class="text-button small" data-action="open-results" title="Открыть папку результатов">${icon('folder')} Результаты</button><span>${esc(s.version)}</span></footer>
  </main>`;
}
export function registration(s) {
  return header('Регистрация участника', `<button class="text-button" data-action="home">${icon('back')} На главную</button>`) + `<main class="registration">
    <div class="page-heading"><h1>Регистрация</h1><p>Таймер начнётся после активации.</p></div>
    <div class="registration-grid">
      <form id="registration-form" class="registration-form">
        <h2>Данные участника</h2>
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
        <h2>${esc(s.exam?.title || 'Экзамен')}</h2><div class="large-time">02:30:00</div><p>16 заданий · без паузы</p>
        <hr><div class="summary-row"><strong>01–12</strong><span>Краткий ответ</span></div><div class="summary-row"><strong>13–16</strong><span>Ответ файлом</span></div>
        <hr><p>Нажимайте <strong>«Сохранить ответ»</strong> после каждого задания.</p>
      </aside>
    </div>
  </main>`;
}
export function nav(s, current) {
  const a = s.session;
  return `<div class="nav-heading"><h2>Задания</h2><span id="saved-count">${a.savedCount} / 16</span></div>
    <nav class="task-grid" aria-label="Переход к заданию">${a.statuses.map(t => `<button class="task-number ${t.id === current ? 'current' : ''} ${t.saved ? 'saved' : ''} ${t.dirty ? 'dirty' : ''}" data-action="task" data-id="${t.id}" aria-current="${t.id === current ? 'step' : 'false'}" aria-label="Задание ${t.id}. ${t.saved ? 'Ответ сохранён' : 'Нет ответа'}${t.dirty ? '. Есть несохранённые изменения' : ''}">${pad(t.id)}${t.saved ? `<span class="mini-check">${icon('check')}</span>` : ''}${t.dirty ? '<span class="draft-dot"></span>' : ''}</button>`).join('')}</nav>
    <div class="legend"><span><i class="legend-saved"></i>Сохранено</span><span><i class="legend-draft"></i>Черновик</span><span><i></i>Нет ответа</span></div>`;
}
export function imageStack(images, removable = false) {
  if (!images.length) return `<div class="empty-media">${icon('file')}<strong>Добавьте условие задания</strong><span>Изображение до 16 МБ</span></div>`;
  return `<div class="image-stack">${images.map((a, i) => `<figure class="task-image"><figcaption><span>${esc(a.name)}</span><span>${i+1} / ${images.length}${removable ? `<button class="icon-button danger-text" data-action="remove-asset" data-id="${esc(a.id)}" title="Удалить изображение" aria-label="Удалить ${esc(a.name)}">${icon('close')}</button>` : ''}</span></figcaption><div class="image-holder"><img data-image-id="${esc(a.id)}" alt="Условие: ${esc(a.name)}"></div></figure>`).join('')}</div>`;
}
export function resourceList(resources, editable = false) {
  if (!resources.length) return '<p class="muted small">Файлы не добавлены.</p>';
  return `<div class="resource-list">${resources.map(a => `<div class="resource-row"><span class="file-symbol">${icon('file')}</span><div><strong>${esc(a.name)}</strong><span>${fmtSize(a.size)}</span></div><button class="secondary compact" data-action="download-asset" data-id="${esc(a.id)}" data-name="${esc(a.name)}">${icon('download')} Скачать</button>${editable ? `<button class="icon-button danger-text" data-action="remove-asset" data-id="${esc(a.id)}" aria-label="Удалить ${esc(a.name)}">${icon('close')}</button>` : ''}</div>`).join('')}</div>`;
}
export function exam(s, task) {
  const a = s.session, file = task.draftFile || task.savedFile;
  const saved = task.savedAt ? `Сохранено в ${new Date(task.savedAt).toLocaleTimeString('ru-RU')}` : 'Не сохранено';
  return header('Идёт экзамен', `<button class="text-button" data-action="fullscreen">${icon('screen')} Полный экран</button><button class="finish-button" data-action="finish">Завершить экзамен</button>`) + `<div id="connection-banner" class="connection-banner" hidden></div>
    <main class="exam-layout">
      <aside class="exam-sidebar">
        <div class="timer-box"><span>${icon('clock')} Осталось времени</span><strong id="timer">${time(a.remainingMs)}</strong><span class="timer-note">из 02:30:00</span></div>
        <div id="task-nav">${nav(s, task.id)}</div>
        <div class="candidate-mini"><strong>${esc(a.candidate.surname)} ${esc(a.candidate.name)}</strong><span>Бланк ${esc(a.candidate.registration)}</span></div>
      </aside>
      <section class="exam-main">
        <div class="task-heading"><div><span class="muted small">${esc(a.title)}</span><h1>Задание ${pad(task.id)}<span class="task-type">${task.kind === 'short' ? 'Краткий ответ' : 'Ответ файлом'}</span></h1></div>
          <div class="zoom-controls" aria-label="Масштаб условия"><button data-action="zoom-out" title="Уменьшить" aria-label="Уменьшить условие">−</button><span id="zoom-label">По ширине</span><button data-action="zoom-in" title="Увеличить" aria-label="Увеличить условие">+</button></div>
        </div>
        <div class="task-content" id="task-content">${task.hasResources ? `<section class="resources-panel"><h2>Файлы для работы</h2>${resourceList(task.resources)}</section>` : ''}${imageStack(task.images)}</div>
        <div class="answer-panel">
          <div class="answer-label"><label for="answer-text">${task.kind === 'short' ? 'Ваш ответ' : 'Файл ответа'}</label><span id="answer-status" class="small ${task.dirty ? 'amber-text' : 'muted'}">${task.dirty ? 'Черновик' : saved}</span></div>
          ${task.kind === 'short' ? `<div class="answer-row"><input id="answer-text" value="${esc(task.text)}" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Введите ответ"><button class="primary" data-action="save">${icon('check')} Сохранить ответ</button></div>` : `<div class="answer-row file-answer"><div class="chosen-file">${icon('file')}<div><strong>${file ? esc(file.name) : 'Файл не выбран'}</strong><span>${file ? fmtSize(file.size) : 'Выберите готовую работу'}</span></div></div><button class="secondary" data-action="attach">${icon('upload')} ${file ? 'Заменить файл' : 'Прикрепить файл'}</button><button class="primary" data-action="save">${icon('check')} Сохранить ответ</button></div><p class="small muted file-hint">После изменения файла прикрепите его заново.</p>`}
          <div class="answer-meta"><span>Ctrl + Enter — сохранить</span>${task.savedAt || file ? '<button class="text-button small danger-text" data-action="clear-answer">Очистить ответ</button>' : ''}</div>
        </div>
        <footer class="task-footer"><button class="secondary" data-action="previous" ${task.id === 1 ? 'disabled' : ''}>${icon('back')} Предыдущее</button><span>${task.id} из 16</span><button class="secondary" data-action="next" ${task.id === 16 ? 'disabled' : ''}>Следующее ${icon('arrow')}</button></footer>
      </section>
    </main>`;
}
export function editor(s, selected, currentCode = '') {
  const e = s.editor, t = e.tasks[selected - 1];
  const complete = e.tasks.filter(x => x.images.length && (!x.hasResources || x.resources.length)).length;
  return header('Редактор экзамена', `<button class="text-button" data-action="home">${icon('back')} На главную</button>`) + `<main class="editor-page">
    <div class="editor-top"><h1>Редактор экзамена</h1><div class="button-row"><button class="secondary" data-action="export-project">Сохранить проект</button><button class="primary" data-action="export-exam">${icon('download')} Экспортировать экзамен</button></div></div>
    <div class="editor-settings"><label>Название<input id="exam-title" maxlength="160" value="${esc(e.title)}"></label>
      <div class="code-settings"><label>Код активации<input id="editor-code" value="${esc(currentCode)}" maxlength="128" placeholder="${e.hasActivation ? 'Код установлен' : 'Введите код'}" autocomplete="off"></label><button class="secondary compact" data-action="generate-code" title="Сгенерировать новый код" aria-label="Сгенерировать код">${icon('refresh')}</button><button class="secondary compact" data-action="set-code">Применить</button></div>
    </div>
    <div class="editor-toolbar"><div class="button-row"><button class="secondary" data-action="import-images">${icon('folder')} Импорт из папки</button><button class="text-button" data-action="import-images-files">Выбрать изображения</button></div><div class="button-row"><button class="text-button" data-action="open-project">Открыть проект</button><button class="text-button danger-text" data-action="new-project">Новый проект</button></div></div>
    <p class="import-note">Готово <strong>${complete} / 16</strong> заданий</p>
    <div class="editor-layout">
      <nav class="editor-nav" aria-label="Задания редактора">${e.tasks.map(x => `<button data-action="editor-task" data-id="${x.id}" class="${x.id === selected ? 'selected' : ''}" aria-current="${x.id === selected ? 'step' : 'false'}" aria-label="Задание ${x.id}: ${x.images.length} изображений${x.hasResources ? `, ${x.resources.length} файлов` : ''}"><span class="editor-task-id">${pad(x.id)}</span><span><strong>Задание ${x.id}</strong><small>${x.images.length} изобр.${x.hasResources ? ` · ${x.resources.length} файл.` : ''}</small></span>${x.images.length && (!x.hasResources || x.resources.length) ? icon('check','ready-check') : '<span class="empty-dot"></span>'}</button>`).join('')}</nav>
      <section class="editor-canvas">
        <div class="editor-task-heading"><div><h2>Задание ${pad(selected)}</h2><p>${t.kind === 'short' ? 'Краткий ответ' : 'Ответ файлом'}</p></div><button class="secondary" data-action="add-image">${icon('plus')} Добавить изображение</button></div>
        ${t.hasResources ? `<section class="resources-panel"><div class="split"><h3>Исходные файлы</h3><button class="text-button" data-action="add-resource">${icon('plus')} Добавить файлы</button></div>${resourceList(t.resources, true)}</section>` : ''}
        <div class="drop-area" id="drop-area">${imageStack(t.images, true)}</div>
        <div class="canvas-footnote">Проект сохраняется автоматически.</div>
      </section>
    </div>
  </main>`;
}
export function result(s) {
  const a = s.session;
  return header('Экзамен завершён') + `<main class="result-page"><div class="result-mark">${icon('check')}</div><h1>Экзамен завершён</h1><p class="result-subtitle">${a.finishReason === 'timeout' ? 'Время истекло.' : 'Ответы приняты.'}</p>
    <section class="result-card"><div class="result-top"><div><span class="muted small">${esc(a.title)}</span><h2>${esc(a.candidate.surname)} ${esc(a.candidate.name)}</h2><p>Бланк ${esc(a.candidate.registration)}</p></div><div class="result-score"><strong>${a.savedCount}<span> / 16</span></strong><span>сохранено ответов</span></div></div>
      <div class="result-tasks">${a.statuses.map(t => `<span class="${t.saved ? 'saved' : ''}" title="Задание ${t.id}: ${t.saved ? 'сохранено' : 'нет ответа'}">${pad(t.id)}${t.saved ? icon('check') : ''}</span>`).join('')}</div>
      ${a.dirtyCount ? `<p class="draft-warning">Черновиков: ${a.dirtyCount}. Они сохранены отдельно от сданных ответов.</p>` : ''}<hr>
      ${a.archiveReady ? `<h3>${icon('folder')} Результаты сохранены</h3><p class="path-text">${esc(a.resultDir)}</p><div class="button-row"><button class="primary" data-action="download-result">${icon('download')} Скачать ZIP</button><button class="secondary" data-action="open-folder">Открыть папку</button></div>` : `<h3>Ответы сохранены в локальном сеансе</h3><p class="form-error">${esc(a.exportError || 'Не удалось завершить экспорт. Проверьте свободное место.')}</p><button class="primary" data-action="retry-export">${icon('refresh')} Повторить экспорт</button>`}
      <p class="privacy-note">${icon('lock')} ZIP содержит регистрационные данные. Передайте его организатору.</p>
    </section><button class="text-button" data-action="dismiss">На главную ${icon('arrow')}</button>
  </main>`;
}
