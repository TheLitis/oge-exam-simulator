#!/bin/sh
# Explicitly invoked by the owner. Creates a PRIVATE repo, never force-pushes.
set -eu
cd "$(dirname "$0")/.."
command -v gh >/dev/null 2>&1 || { echo 'Установите GitHub CLI и выполните gh auth login. Не вставляйте токен в исходники.' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo 'Нужен Git.' >&2; exit 1; }
[ -d .git ] || { echo 'Сначала восстановите историю: git clone repository.bundle dev-copy; затем запустите скрипт из dev-copy.' >&2; exit 1; }
login=$(gh api user --jq .login)
[ "$login" = "TheLitis" ] || { echo "Вы вошли как $login, нужен TheLitis. Публикация отменена." >&2; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo 'Ожидалась ветка main. Публикация отменена.' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Есть незакоммиченные изменения. Сначала проверьте и сохраните их в Git.' >&2; exit 1; }
repo=TheLitis/oge-exam-simulator
remote=$(git remote get-url origin 2>/dev/null || true)
case "$remote" in ''|https://github.com/TheLitis/oge-exam-simulator.git|git@github.com:TheLitis/oge-exam-simulator.git) ;; *) echo 'origin указывает на другой проект. Ничего не изменено.' >&2; exit 1;; esac
if gh repo view "$repo" >/dev/null 2>&1; then
  [ -n "$remote" ] || git remote add origin "https://github.com/$repo.git"
  git push -u origin main
else
  [ -z "$remote" ] || { echo 'origin уже задан, но репозиторий недоступен. Проверьте доступ.' >&2; exit 1; }
  gh repo create "$repo" --private --source . --remote origin --push
fi
printf '%s\n' 'Исходники опубликованы. Ответы учеников и персональные данные не включены.'
