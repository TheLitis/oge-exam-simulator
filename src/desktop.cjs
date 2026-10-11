'use strict';
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { fs, fsp, path, UserError, check } = require('./io.cjs');

async function findExecutable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { await fsp.access(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}

// File managers can keep their process alive while a window is open. Observe
// startup long enough to catch immediate failure; short-lived desktop helpers
// must instead confirm their exit status. Neither mode interprets a shell string.
async function launchProcess(command, args, { waitForExit = false, startupMs = 1200, timeoutMs = 5000 } = {}) {
  await new Promise((resolve, reject) => {
    let child, timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); child?.unref();
      if (error) reject(error); else resolve();
    };
    try { child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false }); }
    catch (error) { finish(error); return; }
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else {
        const error = new Error(signal ? `Desktop opener terminated (${signal}).` : `Desktop opener failed (${code}).`);
        error.code = signal ? 'DESKTOP_LAUNCH_SIGNAL' : 'DESKTOP_LAUNCH_EXIT';
        error.exitCode = code; error.signal = signal;
        finish(error);
      }
    });
    child.once('spawn', () => {
      timer = setTimeout(() => {
        if (!waitForExit) { finish(); return; }
        const error = new Error('Desktop opener did not finish.'); error.code = 'DESKTOP_LAUNCH_TIMEOUT';
        child.kill(); finish(error);
      }, waitForExit ? timeoutMs : startupMs);
    });
  });
}

async function openFolder(folder, { platform = process.platform, find = findExecutable, launch = launchProcess, stat = file => fsp.stat(file) } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  check(typeof folder === 'string' && paths.isAbsolute(folder) && !folder.includes('\0'), 'Некорректный путь к результатам.');
  let details;
  try { details = await stat(folder); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new UserError('Папка результатов не найдена. Проверьте, что она не была перемещена.', 404);
    throw new UserError('Не удалось прочитать папку результатов. Проверьте доступ к ней.', 503);
  }
  check(details.isDirectory(), 'Путь к результатам не является папкой.');

  let command, args, waitForExit = false;
  if (platform === 'linux') {
    // Prefer the file manager itself: a broken inode/directory association can
    // otherwise route xdg-open into Chromium, including its legacy URL splitter.
    for (const name of ['dolphin', 'nautilus', 'nemo', 'caja', 'thunar', 'pcmanfm-qt', 'pcmanfm']) {
      command = await find(name);
      if (command) { args = [folder]; break; }
    }
    if (!command) {
      const uri = pathToFileURL(folder, { windows: false }).href;
      command = await find('gio');
      if (command) { args = ['open', uri]; waitForExit = true; }
      else { command = await find('xdg-open'); if (command) args = [uri]; }
    }
  } else if (platform === 'darwin') { command = '/usr/bin/open'; args = [folder]; waitForExit = true; }
  else if (platform === 'win32') { command = 'explorer.exe'; args = [folder]; }
  check(command, 'Не найден файловый менеджер. Откройте папку по пути, указанному на экране.');
  try { await launch(command, args, { waitForExit }); }
  catch {
    throw new UserError('Не удалось открыть папку результатов. Откройте её по пути, указанному на экране.', 503);
  }
  return true;
}

module.exports = { openFolder, findExecutable, launchProcess };
