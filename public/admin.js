'use strict';

/* ============================================================
   Halloween Party — админка
   ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const TOKEN_KEY = 'hp_admin_token';

  const params = new URLSearchParams(location.search);
  let token = (params.get('token') || sessionStorage.getItem(TOKEN_KEY) || '').trim();

  if (params.get('token')) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch (err) {
      /* ignore */
    }
    // Убираем токен из адресной строки.
    params.delete('token');
    const query = params.toString();
    history.replaceState({}, '', location.pathname + (query ? '?' + query : ''));
  }

  let authorized = false;
  let timer = null;
  let loading = false;
  let lastData = null;
  let lastSignature = '';

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  function toast(message, ms = 2400) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('is-on'), ms);
  }

  async function request(path, options = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers['x-admin-token'] = token;

    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      cache: 'no-store',
    });

    if (res.status === 401 || res.status === 403) {
      const error = new Error('unauthorized');
      error.status = res.status;
      throw error;
    }
    if (!res.ok) {
      const error = new Error('http_' + res.status);
      error.status = res.status;
      throw error;
    }
    return res;
  }

  /* ------------------------- авторизация ------------------------- */

  function showGate(message) {
    authorized = false;
    stopTimer();
    $('#page').hidden = true;
    $('#gate').hidden = false;
    const err = $('#gateError');
    if (message) {
      err.textContent = message;
      err.hidden = false;
    } else {
      err.hidden = true;
    }
    const input = $('#tokenInput');
    if (input) setTimeout(() => input.focus(), 60);
  }

  function showPage() {
    authorized = true;
    $('#gate').hidden = true;
    $('#page').hidden = false;
    startTimer();
  }

  /* ------------------------- данные ------------------------- */

  async function load(options = {}) {
    if (loading) return;
    loading = true;
    try {
      const res = await request('/api/admin/stats');
      const data = await res.json();
      lastData = data;

      // Перерисовываем только при реальных изменениях: иначе автообновление
      // каждые 5 секунд сбрасывало бы прокрутку списков гостей.
      const signature = JSON.stringify({
        totals: data.totals,
        teams: (data.teams || []).map((t) => [t.id, t.count, t.members]),
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        render(data);
      } else {
        updateTimestamp(data.now);
      }
      if (!authorized) showPage();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        showGate(token ? 'Неверный токен. Попробуй ещё раз.' : '');
      } else if (!options.silent) {
        toast('Не удалось загрузить данные');
      }
    } finally {
      loading = false;
    }
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (document.hidden) return;
      load({ silent: true });
    }, 5000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /* ------------------------- рендер ------------------------- */

  function renderTeam(team) {
    const members = team.members || [];
    const list = members.length
      ? members
          .map(
            (m) => `
        <div class="member">
          <span class="member__n">#${m.n}</span>
          <span class="member__name">${escapeHtml(m.name)}</span>
          ${m.username ? `<span class="member__username">@${escapeHtml(m.username)}</span>` : ''}
          <span class="member__time">${new Date(m.at).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })}</span>
        </div>`
          )
          .join('')
      : '<div class="team__empty">пока никого</div>';

    return `
      <article class="team" style="--team:${escapeHtml(team.color)}">
        <div class="team__head">
          <div class="team__emoji">${team.emoji}</div>
          <div class="team__titles">
            <h2 class="team__name">${escapeHtml(team.name)}</h2>
            <p class="team__tagline">${escapeHtml(team.tagline || '')}</p>
          </div>
          <div class="team__count" title="Человек в команде">${team.count}</div>
        </div>
        <div class="team__list">${list}</div>
      </article>`;
  }

  function updateTimestamp(now) {
    $('#updatedAt').textContent =
      'обновлено ' +
      new Date(now || Date.now()).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
  }

  function render(data) {
    const totals = data.totals || {};
    $('#statTotal').textContent = totals.participants || 0;
    $('#statRound').textContent = totals.round || 0;
    $('#statRoundProgress').textContent =
      (totals.roundAssigned || 0) + '/' + (totals.roundSize || 4);
    $('#statPool').textContent = totals.poolRemaining || 0;

    const byId = new Map((data.teams || []).map((t) => [t.id, t]));
    const poolNames = (totals.pool || []).map((id) => (byId.get(id) || {}).name || id);
    $('#poolHint').textContent = poolNames.length
      ? 'Ещё не выпали: ' + poolNames.join(', ')
      : 'Пул пуст — следующий гость начнёт новый раунд';

    $('#teams').innerHTML = (data.teams || []).map(renderTeam).join('');
    updateTimestamp(data.now);
  }

  /* ------------------------- действия ------------------------- */

  async function reset(mode) {
    const isAll = mode === 'all';
    const question = isAll
      ? 'Удалить ВСЕХ участников и историю раундов? Это необратимо.'
      : 'Начать новый раунд? Следующие 4 гостя получат по одной команде.';
    if (!window.confirm(question)) return;

    try {
      const res = await request('/api/admin/reset-' + mode, { method: 'POST' });
      const data = await res.json();
      toast(isAll ? 'Всё сброшено' : 'Новый раунд №' + data.round);
      await load({ silent: true });
    } catch (err) {
      if (err.status === 401 || err.status === 403) showGate('Сессия истекла — введи токен снова.');
      else toast('Не получилось. Попробуй ещё раз.');
    }
  }

  async function downloadCsv() {
    try {
      const res = await request('/api/admin/export.csv');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'halloween-teams-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('CSV скачан');
    } catch (err) {
      if (err.status === 401 || err.status === 403) showGate('Сессия истекла — введи токен снова.');
      else toast('Не удалось скачать CSV');
    }
  }

  function bind() {
    $('#refreshBtn').addEventListener('click', () => load());

    $('#csvBtn').addEventListener('click', downloadCsv);

    $('#resetRoundBtn').addEventListener('click', () => reset('round'));

    $('#resetAllBtn').addEventListener('click', () => reset('all'));

    $('#gateForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const value = $('#tokenInput').value.trim();
      if (!value) return;
      token = value;
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch (err) {
        /* ignore */
      }
      load();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && authorized) load({ silent: true });
    });
  }

  /* ------------------------- старт ------------------------- */

  bind();
  // Пробуем загрузиться сразу: в dev-режиме админка может быть открыта без токена.
  load({ silent: true });
})();
