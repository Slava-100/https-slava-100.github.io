'use strict';

/* ============================================================
   Halloween Party Mini App — логика гостевого экрана
   ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const getTg = () => (window.Telegram && window.Telegram.WebApp) || null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function refreshTg() {
    const current = getTg();
    if (current) tg = current;
    return tg;
  }

  /**
   * SDK Telegram подключается асинхронно: если telegram.org недоступен или
   * отвечает медленно, приложение всё равно должно открыться, а не зависнуть.
   */
  function waitForTelegram(maxMs = 2500) {
    return new Promise((resolve) => {
      const ready = getTg();
      if (ready) {
        resolve(ready);
        return;
      }

      const sdk = document.getElementById('tgSdk');
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve(getTg());
      };

      const timer = setTimeout(finish, maxMs);
      const poll = setInterval(() => {
        if (getTg()) finish();
      }, 60);

      if (sdk) {
        sdk.addEventListener('load', finish, { once: true });
        sdk.addEventListener('error', finish, { once: true });
      }
    });
  }

  const state = {
    config: null,
    current: null,
    busy: false,
    // Звук включён по умолчанию; выключить можно кнопкой (запомним в localStorage).
    sound: localStorage.getItem('hp_sound') !== '0',
    devId: getDevId(),
    canViewTeams: false,
  };

  let hostTimer = 0;

  /* ------------------------- утилиты ------------------------- */

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function plural(n, forms) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
    return forms[2];
  }

  function teamById(id) {
    return (state.config && state.config.teams.find((t) => t.id === id)) || {
      id,
      name: id,
      singular: id,
      emoji: '🎃',
      color: '#ff7a1a',
      accent: '#ffc078',
      tagline: '',
      hint: '',
    };
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  function shortTime(ts) {
    return new Date(Number(ts) || 0).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getDevId() {
    const params = new URLSearchParams(location.search);
    const as = (params.get('as') || '').trim();
    if (as) {
      const clean = as.replace(/[^\w-]/g, '').slice(0, 32) || 'guest';
      sessionStorage.setItem('hp_dev_uid', clean);
      return clean;
    }
    let id = sessionStorage.getItem('hp_dev_uid');
    if (!id) {
      id = 'guest' + Math.random().toString(36).slice(2, 7);
      sessionStorage.setItem('hp_dev_uid', id);
    }
    return id;
  }

  function haptic(type) {
    try {
      refreshTg();
      if (!tg || !tg.HapticFeedback) return;
      if (type === 'success' || type === 'error' || type === 'warning') {
        tg.HapticFeedback.notificationOccurred(type);
      } else {
        tg.HapticFeedback.impactOccurred(type || 'medium');
      }
    } catch (err) {
      /* не критично */
    }
  }

  function toast(message, ms = 2200) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('is-on'), ms);
  }

  /* ------------------------- API ------------------------- */

  async function api(path, options = {}) {
    refreshTg();
    const headers = { Accept: 'application/json' };
    if (tg && tg.initData) {
      headers['x-telegram-init-data'] = tg.initData;
    } else if (state.devId) {
      headers['x-dev-user'] = state.devId;
    }

    let res;
    try {
      res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (err) {
      const error = new Error('network');
      error.status = 0;
      throw error;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }

    if (!res.ok) {
      const error = new Error((data && data.error) || 'http_' + res.status);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  /* ------------------------- звук ------------------------- */

  const Sfx = (() => {
    let ctx = null;
    let enabled = false;

    function ensure() {
      if (!enabled) return null;
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          ctx = new AC();
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch (err) {
        return null;
      }
    }

    function noiseBuffer(c, seconds) {
      const len = Math.max(1, Math.floor(c.sampleRate * seconds));
      const buffer = c.createBuffer(1, len, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) {
        const fade = 1 - i / len;
        data[i] = (Math.random() * 2 - 1) * fade * fade;
      }
      return buffer;
    }

    function tick(progress) {
      const c = ensure();
      if (!c) return;
      const now = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'square';
      osc.frequency.value = 760 + Math.random() * 120;
      const peak = 0.035 * (1 - Math.min(1, progress) * 0.7);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      osc.connect(gain).connect(c.destination);
      osc.start(now);
      osc.stop(now + 0.06);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }

    function spin() {
      const c = ensure();
      if (!c) return;
      const now = c.currentTime;

      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c, 2.8);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(300, now);
      bp.frequency.exponentialRampToValueAtTime(2400, now + 2.5);
      const ng = c.createGain();
      ng.gain.setValueAtTime(0.0001, now);
      ng.gain.exponentialRampToValueAtTime(0.085, now + 0.3);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + 2.7);
      src.connect(bp).connect(ng).connect(c.destination);
      src.start(now);
      src.stop(now + 2.8);

      const drone = c.createOscillator();
      const dg = c.createGain();
      drone.type = 'sine';
      drone.frequency.setValueAtTime(72, now);
      drone.frequency.exponentialRampToValueAtTime(46, now + 2.2);
      dg.gain.setValueAtTime(0.0001, now);
      dg.gain.exponentialRampToValueAtTime(0.11, now + 0.7);
      dg.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
      drone.connect(dg).connect(c.destination);
      drone.start(now);
      drone.stop(now + 2.6);
    }

    // Характерный звук команды в момент выпадения.
    function teamVoice(teamId, c, start) {
      if (teamId === 'werewolf') {
        const osc = c.createOscillator();
        const gain = c.createGain();
        const filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 5;
        filter.frequency.setValueAtTime(1400, start);
        filter.frequency.linearRampToValueAtTime(2400, start + 0.5);
        filter.frequency.linearRampToValueAtTime(900, start + 1.7);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, start);
        osc.frequency.exponentialRampToValueAtTime(430, start + 0.45);
        osc.frequency.setValueAtTime(430, start + 0.85);
        osc.frequency.exponentialRampToValueAtTime(245, start + 1.65);
        const vib = c.createOscillator();
        const depth = c.createGain();
        vib.frequency.value = 5.4;
        depth.gain.value = 17;
        vib.connect(depth).connect(osc.frequency);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.15, start + 0.12);
        gain.gain.setValueAtTime(0.15, start + 1.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.75);
        osc.connect(filter).connect(gain).connect(c.destination);
        osc.start(start);
        vib.start(start);
        osc.stop(start + 1.8);
        vib.stop(start + 1.8);
        return;
      }

      if (teamId === 'ghost') {
        const osc = c.createOscillator();
        const gain = c.createGain();
        const filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 760;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(320, start);
        osc.frequency.exponentialRampToValueAtTime(165, start + 1.35);
        const vib = c.createOscillator();
        const depth = c.createGain();
        vib.frequency.value = 6.5;
        depth.gain.value = 13;
        vib.connect(depth).connect(osc.frequency);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.095, start + 0.32);
        gain.gain.setValueAtTime(0.095, start + 0.95);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.5);
        osc.connect(filter).connect(gain).connect(c.destination);
        osc.start(start);
        vib.start(start);
        osc.stop(start + 1.6);
        vib.stop(start + 1.6);

        const whisper = c.createBufferSource();
        whisper.buffer = noiseBuffer(c, 1.4);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 950;
        bp.Q.value = 0.9;
        const wg = c.createGain();
        wg.gain.setValueAtTime(0.0001, start);
        wg.gain.exponentialRampToValueAtTime(0.035, start + 0.4);
        wg.gain.exponentialRampToValueAtTime(0.0001, start + 1.35);
        whisper.connect(bp).connect(wg).connect(c.destination);
        whisper.start(start);
        whisper.stop(start + 1.4);
        return;
      }

      if (teamId === 'zombie') {
        const osc = c.createOscillator();
        const gain = c.createGain();
        const filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 340;
        filter.Q.value = 7;
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(102, start);
        osc.frequency.linearRampToValueAtTime(70, start + 1.15);
        const vib = c.createOscillator();
        const depth = c.createGain();
        vib.frequency.value = 3.1;
        depth.gain.value = 6;
        vib.connect(depth).connect(osc.frequency);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.1, start + 0.22);
        gain.gain.setValueAtTime(0.1, start + 0.85);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.25);
        osc.connect(filter).connect(gain).connect(c.destination);
        osc.start(start);
        vib.start(start);
        osc.stop(start + 1.35);
        vib.stop(start + 1.35);

        const rumble = c.createBufferSource();
        rumble.buffer = noiseBuffer(c, 1.2);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 240;
        const rg = c.createGain();
        rg.gain.value = 0.05;
        rumble.connect(lp).connect(rg).connect(c.destination);
        rumble.start(start);
        rumble.stop(start + 1.2);
        return;
      }

      // Вампиры: драматичный минорный стинг + «укус».
      [440, 523.25, 659.25].forEach((freq, i) => {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const at = start + i * 0.02;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
        osc.connect(gain).connect(c.destination);
        osc.start(at);
        osc.stop(at + 0.65);
      });

      const thud = c.createOscillator();
      const tg = c.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(110, start);
      thud.frequency.exponentialRampToValueAtTime(42, start + 0.35);
      tg.gain.setValueAtTime(0.0001, start);
      tg.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
      tg.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      thud.connect(tg).connect(c.destination);
      thud.start(start);
      thud.stop(start + 0.55);

      const bite = c.createBufferSource();
      bite.buffer = noiseBuffer(c, 0.16);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const bg = c.createGain();
      const bt = start + 0.22;
      bg.gain.setValueAtTime(0.0001, bt);
      bg.gain.exponentialRampToValueAtTime(0.13, bt + 0.01);
      bg.gain.exponentialRampToValueAtTime(0.0001, bt + 0.16);
      bite.connect(hp).connect(bg).connect(c.destination);
      bite.start(bt);
      bite.stop(bt + 0.17);
    }

    function reveal(teamId) {
      const c = ensure();
      if (!c) return;
      const now = c.currentTime;

      const boom = c.createOscillator();
      const bg = c.createGain();
      boom.type = 'sine';
      boom.frequency.setValueAtTime(120, now);
      boom.frequency.exponentialRampToValueAtTime(36, now + 0.6);
      bg.gain.setValueAtTime(0.0001, now);
      bg.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
      bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
      boom.connect(bg).connect(c.destination);
      boom.start(now);
      boom.stop(now + 0.9);

      [659.25, 987.77, 1318.5].forEach((freq, i) => {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const start = now + 0.04 + i * 0.035;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.85);
        osc.connect(gain).connect(c.destination);
        osc.start(start);
        osc.stop(start + 0.9);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
      });

      teamVoice(teamId, c, now + 0.12);
    }

    function setEnabled(value) {
      enabled = !!value;
      if (!enabled && ctx && ctx.state === 'running') {
        try {
          ctx.suspend();
        } catch (err) {
          /* ignore */
        }
      }
    }

    return { setEnabled, tick, spin, reveal };
  })();

  /* ------------------------- Telegram ------------------------- */

  function initTelegram() {
    refreshTg();
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#08040f');
      if (tg.setBackgroundColor) tg.setBackgroundColor('#08040f');
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      if (tg.setBottomBarColor) tg.setBottomBarColor('#08040f');
    } catch (err) {
      /* ignore */
    }
  }

  /* ------------------------- фоновые угли ------------------------- */

  function initEmbers() {
    const canvas = $('#embers');
    if (!canvas || reducedMotion) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let particles = [];
    let rafId = 0;
    let paused = false;

    function spawn(randomY) {
      return {
        x: Math.random() * width,
        y: randomY ? Math.random() * height : height + 10,
        r: 0.6 + Math.random() * 1.9,
        vy: 0.15 + Math.random() * 0.5,
        vx: (Math.random() - 0.5) * 0.22,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.16 + Math.random() * 0.5,
      };
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth || window.innerWidth;
      height = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(64, Math.round((width * height) / 14000));
      particles = Array.from({ length: count }, () => spawn(true));
    }

    function frame(time) {
      if (paused) return;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of particles) {
        p.y -= p.vy;
        p.x += p.vx + Math.sin(time / 1600 + p.phase) * 0.14;
        if (p.y < -12) {
          Object.assign(p, spawn(false));
        }
        if (p.x < -12) p.x = width + 10;
        if (p.x > width + 12) p.x = -10;
        const flicker = 0.75 + Math.sin(time / 320 + p.phase) * 0.25;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255, ${140 + Math.round(p.r * 20)}, 60, ${p.alpha * flicker})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      rafId = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      paused = document.hidden;
      if (!paused) rafId = requestAnimationFrame(frame);
      else cancelAnimationFrame(rafId);
    });
    rafId = requestAnimationFrame(frame);
  }

  /* ------------------------- зрачок ------------------------- */

  function initPupil() {
    const iris = $('#eyeIris');
    const svg = document.querySelector('.eye__svg');
    if (!iris || !svg) return;

    function move(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = Math.max(-1, Math.min(1, (clientX - cx) / (rect.width * 0.45)));
      const dy = Math.max(-1, Math.min(1, (clientY - cy) / (rect.height * 0.45)));
      iris.style.transform = `translate(${(dx * 9).toFixed(2)}px, ${(dy * 7).toFixed(2)}px)`;
    }

    window.addEventListener('pointermove', (event) => move(event.clientX, event.clientY), {
      passive: true,
    });
    window.addEventListener(
      'pointerdown',
      (event) => move(event.clientX, event.clientY),
      { passive: true }
    );
    document.addEventListener('pointerleave', () => {
      iris.style.transform = 'translate(0, 0)';
    });
  }

  /* ------------------------- экраны ------------------------- */

  function showView(name) {
    $$('.screen').forEach((section) => {
      const active = section.dataset.view === name;
      section.hidden = !active;
      section.classList.toggle('is-active', active);
      if (active) {
        // перезапуск CSS-анимации появления
        const clone = section;
        clone.style.animation = 'none';
        void clone.offsetWidth;
        clone.style.animation = '';
      }
    });
    window.scrollTo(0, 0);
  }

  function showError(err) {
    const text = $('#errorText');
    let message = 'Что-то пошло не так. Попробуй ещё раз.';
    if (!err || err.status === 0) {
      message = 'Нет связи с сервером. Проверь интернет и попробуй снова.';
    } else if (err.status === 401) {
      message =
        'Не удалось подтвердить аккаунт Telegram. Открой приложение через бота — просто по ссылке в браузере оно не работает.';
    } else if (err.status === 429) {
      message = 'Слишком много попыток. Подожди минутку и попробуй снова.';
    } else if (err.status === 403) {
      message = 'Доступ закрыт. Попроси у ведущего новую ссылку.';
    }
    if (text) text.textContent = message;
    showView('error');
    state.busy = false;
    const eye = $('#eyeBtn');
    if (eye) eye.disabled = false;
  }

  /* ------------------------- рендер ------------------------- */

  function renderTeamsStrip() {
    const wrap = $('#teamsStrip');
    if (!wrap || !state.config) return;
    wrap.innerHTML = '';
    for (const team of state.config.teams) {
      const chip = document.createElement('span');
      chip.className = 'team-chip';
      chip.innerHTML =
        `<span class="team-chip__emoji">${team.emoji}</span>` +
        `<span>${team.name}</span>`;
      wrap.appendChild(chip);
    }
  }

  function updateFootnote() {
    const el = $('#introFootnote');
    if (!el || !state.config) return;
    const n = state.config.assigned || 0;
    let text = n
      ? `Уже распределено: ${n} ${plural(n, ['гость', 'гостя', 'гостей'])}`
      : 'Жребий ещё не бросали — можешь стать первым';
    if (state.config.devMode) text += ' · демо-режим';
    el.textContent = text;
  }

  function buildRoulette() {
    const ring = $('#rouletteRing');
    if (!ring || !state.config) return;
    ring.innerHTML = '';
    state.config.teams.forEach((team, i) => {
      const slot = document.createElement('div');
      slot.className = 'roulette__slot';
      slot.style.setProperty('--i', String(i));
      slot.style.setProperty('--slot-color', team.color);
      slot.dataset.team = team.id;
      slot.dataset.index = String(i);
      slot.innerHTML = `<span class="roulette__slot-emoji">${team.emoji}</span>`;
      ring.appendChild(slot);
    });
  }

  function markWinner(index) {
    $$('#rouletteRing .roulette__slot').forEach((slot, i) => {
      slot.classList.toggle('is-winner', i === index);
      slot.classList.toggle('is-dim', i !== index);
    });
  }

  function clearWinner() {
    $$('#rouletteRing .roulette__slot').forEach((slot) => {
      slot.classList.remove('is-winner', 'is-dim');
    });
  }

  function renderResult(participant, options = {}) {
    const team = teamById(participant.team);
    const card = $('#card');
    state.current = participant;

    card.style.setProperty('--team', team.color);
    card.style.setProperty('--team-accent', team.accent);

    $('#cardSigil').textContent = team.emoji;
    $('#cardName').textContent = team.name;
    $('#cardTagline').textContent = team.tagline ? '«' + team.tagline + '»' : '';
    $('#cardHint').textContent = team.hint || '';
    $('#cardTeamCount').textContent = 'в команде: ' + participant.teamCount;
    $('#cardGuestNo').textContent = 'гость #' + participant.n;

    const badge = $('#cardBadge');
    badge.hidden = !!options.isNew;
    badge.textContent = 'Команда уже закреплена за тобой';

    const hint = $('#resultHint');
    if (hint) {
      hint.textContent = options.isNew
        ? 'Жребий брошен. Найди своих — они уже собираются.'
        : 'Твой жребий уже брошен. Команда не меняется.';
    }

    showView('result');
    if (!options.instant) {
      requestAnimationFrame(() => {
        flashScreen();
        if (!reducedMotion) burstAt(team);
      });
    }
  }

  /* ------------------------- эффекты ------------------------- */

  function flashScreen() {
    const flash = $('#flash');
    if (!flash || reducedMotion) return;
    flash.classList.remove('is-on');
    void flash.offsetWidth;
    flash.classList.add('is-on');
  }

  function burstAt(team) {
    const layer = $('#burst');
    if (!layer) return;
    const palette = [team.color, team.accent, '#ffffff', '#ff7a1a', '#e01b3c'];
    const emojis = ['✨', '💀', '🕸️', '🦇', '🕯️'];
    const count = 38;

    for (let i = 0; i < count; i += 1) {
      const el = document.createElement('span');
      const isEmoji = i % 6 === 0;
      el.className = 'particle' + (isEmoji ? '' : ' particle--dot');
      if (isEmoji) el.textContent = emojis[(i / 6) % emojis.length | 0];

      const angle = Math.random() * Math.PI * 2;
      const distance = 80 + Math.random() * 240;
      el.style.setProperty('--dx', Math.cos(angle) * distance + 'px');
      el.style.setProperty('--dy', Math.sin(angle) * distance * 0.9 + 'px');
      el.style.setProperty('--rot', Math.random() * 720 - 360 + 'deg');
      el.style.setProperty('--color', palette[i % palette.length]);
      el.style.setProperty('--size', 13 + Math.random() * 12 + 'px');
      el.style.setProperty('--dur', 0.9 + Math.random() * 0.6 + 's');
      el.style.setProperty('--delay', Math.random() * 0.1 + 's');
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1800);
    }
  }

  function animateSpin(ring, winnerIndex, duration) {
    // Доворачиваем кольцо так, чтобы слот победителя встал под указатель.
    const target = 1440 + ((360 - (winnerIndex * 90) % 360) % 360);
    ring.style.setProperty('--spin', '0deg');

    return new Promise((resolve) => {
      let finished = false;
      let rafId = 0;
      let watchdog = 0;

      const finish = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(rafId);
        clearTimeout(watchdog);
        document.removeEventListener('visibilitychange', onVisibility);
        ring.style.setProperty('--spin', target + 'deg');
        resolve();
      };

      // Если гость свернул мини-апп, не держим его на экране «жребия».
      const onVisibility = () => {
        if (document.hidden) finish();
      };
      document.addEventListener('visibilitychange', onVisibility);

      if (document.hidden || reducedMotion) {
        setTimeout(finish, reducedMotion ? 200 : 700);
        return;
      }

      const start = performance.now();
      let lastBucket = 0;

      function frame(now) {
        if (finished) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 4);
        const deg = target * eased;
        ring.style.setProperty('--spin', deg.toFixed(2) + 'deg');

        const bucket = Math.floor(deg / 90);
        if (bucket !== lastBucket) {
          lastBucket = bucket;
          Sfx.tick(t);
        }

        if (t < 1) {
          rafId = requestAnimationFrame(frame);
        } else {
          finish();
        }
      }

      rafId = requestAnimationFrame(frame);
      // Страховка на случай, если браузер вообще не присылает кадры
      // (фоновая вкладка, энергосбережение): результат всё равно покажем.
      watchdog = setTimeout(finish, duration + 1000);
    });
  }

  /* ------------------------- сценарий ------------------------- */

  async function runDraw() {
    if (state.busy) return;
    if (!state.config) {
      toast('Ещё секунду…');
      return;
    }
    state.busy = true;

    const eye = $('#eyeBtn');
    if (eye) eye.disabled = true;

    Sfx.spin();
    haptic('medium');

    const ring = $('#rouletteRing');
    clearWinner();
    showView('spin');
    document.body.classList.add('is-conjuring');
    const startedAt = Date.now();

    let result;
    try {
      result = await api('/api/join', { method: 'POST' });
    } catch (err) {
      document.body.classList.remove('is-conjuring');
      showError(err);
      return;
    }

    state.canViewTeams = true;
    updateTeamsButton();

    // Даём «нагнетанию» доиграть минимум 800 мс.
    await wait(Math.max(0, 800 - (Date.now() - startedAt)));
    document.body.classList.remove('is-conjuring');

    const index = state.config.teams.findIndex((t) => t.id === result.participant.team);
    await animateSpin(ring, index < 0 ? 0 : index, reducedMotion ? 500 : 2500);
    markWinner(index < 0 ? 0 : index);

    Sfx.reveal(result.participant.team);
    haptic('success');
    await wait(reducedMotion ? 120 : 560);

    if (eye) eye.disabled = false;
    state.busy = false;
    renderResult(result.participant, { isNew: result.isNew });
  }

  async function replay() {
    if (state.busy || !state.current || !state.config) return;
    state.busy = true;

    const index = state.config.teams.findIndex((t) => t.id === state.current.team);
    const ring = $('#rouletteRing');

    clearWinner();
    showView('spin');
    document.body.classList.add('is-conjuring');
    Sfx.spin();
    haptic('medium');
    await wait(650);
    document.body.classList.remove('is-conjuring');
    await animateSpin(ring, index < 0 ? 0 : index, reducedMotion ? 500 : 2100);
    markWinner(index < 0 ? 0 : index);
    Sfx.reveal(state.current.team);
    haptic('success');
    await wait(reducedMotion ? 120 : 560);

    showView('result');
    flashScreen();
    if (!reducedMotion) burstAt(teamById(state.current.team));
    state.busy = false;
  }

  function share() {
    if (!state.current) return;
    refreshTg();
    const team = teamById(state.current.team);
    const botUrl = (state.config && state.config.botUrl) || '';
    const botUsername = (state.config && state.config.botUsername) || '';
    const url =
      botUrl ||
      (state.config && state.config.publicUrl) ||
      location.origin + location.pathname.replace(/\/index\.html$/, '/');

    const text = botUrl
      ? `Я — ${team.singular} на Хэллоуин-вечеринке ${team.emoji} ` +
        `А ты кто? Открой ${botUsername ? '@' + botUsername : 'бота'} и нажми «Открыть» — узнаешь свою команду.`
      : `Я — ${team.singular} на Хэллоуин-вечеринке ${team.emoji} ` +
        `А ты кто? Жми «Вырви глаз» и узнаешь свою команду.`;

    haptic('light');

    if (tg && typeof tg.openTelegramLink === 'function') {
      tg.openTelegramLink(
        'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text)
      );
      return;
    }

    if (navigator.share) {
      navigator
        .share({ title: 'Хэллоуин · моя команда', text, url })
        .catch(() => copyShare(text + ' ' + url));
      return;
    }

    copyShare(text + ' ' + url);
  }

  function copyShare(value) {
    const done = () => toast('Ссылка скопирована — отправь друзьям');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(() => toast('Не удалось скопировать'));
    } else {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done();
      } catch (err) {
        toast('Не удалось скопировать');
      }
      area.remove();
    }
  }

  /* ------------------------- звук: кнопка ------------------------- */

  function updateSoundButton() {
    const btn = $('#soundBtn');
    const icon = $('#soundIcon');
    if (!btn || !icon) return;
    btn.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
    btn.setAttribute('aria-label', state.sound ? 'Выключить звук' : 'Включить звук');
    icon.textContent = state.sound ? '🔊' : '🔇';
    Sfx.setEnabled(state.sound);
  }

  function toggleSound() {
    state.sound = !state.sound;
    localStorage.setItem('hp_sound', state.sound ? '1' : '0');
    updateSoundButton();
    if (state.sound) {
      Sfx.tick(0);
      haptic('light');
    }
  }

  /* ------------------------- панель ведущего ------------------------- */

  function updateTeamsButton() {
    ['#hostBtn', '#hostActionBtn'].forEach((selector) => {
      const btn = $(selector);
      if (btn) btn.hidden = !state.canViewTeams;
    });
  }

  function stopHostTimer() {
    if (hostTimer) clearInterval(hostTimer);
    hostTimer = 0;
  }

  function openHostPanel() {
    const panel = $('#hostPanel');
    if (!panel || !state.canViewTeams) return;
    panel.hidden = false;
    document.body.classList.add('is-host-open');
    haptic('light');
    loadHostTeams();
    stopHostTimer();
    hostTimer = setInterval(() => {
      if (!document.hidden) loadHostTeams();
    }, 10000);
  }

  function closeHostPanel() {
    const panel = $('#hostPanel');
    if (panel) panel.hidden = true;
    document.body.classList.remove('is-host-open');
    stopHostTimer();
  }

  async function loadHostTeams() {
    try {
      const data = await api('/api/teams');
      renderHost(data);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        state.canViewTeams = false;
        updateTeamsButton();
        closeHostPanel();
        toast('Список команд доступен внутри Telegram');
      } else {
        toast('Не удалось загрузить список');
      }
    }
  }

  function renderHost(data) {
    const totals = data.totals || {};
    const stats = [
      [totals.participants || 0, 'гостей'],
      [totals.round || 0, 'раунд'],
      [(totals.roundAssigned || 0) + '/' + (totals.roundSize || 4), 'в раунде'],
      [totals.poolRemaining || 0, 'в пуле'],
    ];
    const statsWrap = $('#hostStats');
    if (statsWrap) {
      statsWrap.innerHTML = stats
        .map(
          ([value, label]) =>
            `<div class="host-stat"><span class="host-stat__value">${value}</span>` +
            `<span class="host-stat__label">${label}</span></div>`
        )
        .join('');
    }

    const byId = new Map((data.teams || []).map((team) => [team.id, team]));
    const poolNames = (totals.pool || []).map((id) => (byId.get(id) || {}).name || id);
    const pool = $('#hostPool');
    if (pool) {
      pool.textContent = poolNames.length
        ? 'Ещё не выпали: ' + poolNames.join(', ')
        : 'Пул пуст — следующий гость начнёт новый раунд';
    }

    const wrap = $('#hostTeams');
    if (wrap) {
      wrap.innerHTML = (data.teams || [])
        .map((team) => {
          const members = (team.members || []).length
            ? team.members
                .map(
                  (m) =>
                    `<li class="host-member"><span class="host-member__n">#${m.n}</span>` +
                    `<span class="host-member__name">${escapeHtml(m.name)}</span>` +
                    (m.username
                      ? `<span class="host-member__user">@${escapeHtml(m.username)}</span>`
                      : '') +
                    `<span class="host-member__time">${shortTime(m.at)}</span></li>`
                )
                .join('')
            : '<li class="host-member host-member--empty">пока никого</li>';

          return (
            `<article class="host-team" style="--team:${escapeHtml(team.color)};--team-accent:${escapeHtml(team.accent)}">` +
            `<div class="host-team__head"><span class="host-team__emoji">${team.emoji}</span>` +
            `<span class="host-team__name">${escapeHtml(team.name)}</span>` +
            `<span class="host-team__count">${team.count || 0}</span></div>` +
            `<ul class="host-team__list">${members}</ul></article>`
          );
        })
        .join('');
    }

    const updated = $('#hostUpdated');
    if (updated) {
      updated.textContent = 'обновлено ' + shortTime(data.now || Date.now());
    }
  }

  /* ------------------------- события ------------------------- */

  function bindEvents() {
    const eye = $('#eyeBtn');
    if (eye) eye.addEventListener('click', runDraw);

    const shareBtn = $('#shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', share);

    const replayBtn = $('#replayBtn');
    if (replayBtn) replayBtn.addEventListener('click', replay);

    const retry = $('#retryBtn');
    if (retry) {
      retry.addEventListener('click', () => {
        if (state.current) {
          renderResult(state.current, { isNew: false, instant: true });
        } else {
          showView('intro');
        }
      });
    }

    const soundBtn = $('#soundBtn');
    if (soundBtn) soundBtn.addEventListener('click', toggleSound);

    const hostBtn = $('#hostBtn');
    if (hostBtn) hostBtn.addEventListener('click', openHostPanel);

    const hostActionBtn = $('#hostActionBtn');
    if (hostActionBtn) hostActionBtn.addEventListener('click', openHostPanel);

    const hostClose = $('#hostClose');
    if (hostClose) hostClose.addEventListener('click', closeHostPanel);

    const hostBackdrop = $('#hostBackdrop');
    if (hostBackdrop) hostBackdrop.addEventListener('click', closeHostPanel);

    const hostRefresh = $('#hostRefresh');
    if (hostRefresh) hostRefresh.addEventListener('click', loadHostTeams);

    document.addEventListener('keydown', (event) => {
      const panel = $('#hostPanel');
      if (panel && !panel.hidden) {
        if (event.key === 'Escape') closeHostPanel();
        return;
      }
      if (event.key === 'Enter' && !$('[data-view="intro"]').hidden) {
        event.preventDefault();
        runDraw();
      }
    });
  }

  /* ------------------------- старт ------------------------- */

  async function main() {
    bindEvents();
    updateSoundButton();
    initPupil();
    initEmbers();

    // Конфиг не требует авторизации — грузим его параллельно с SDK Telegram.
    const configPromise = api('/api/config').then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );

    const inTelegram = /tgWebAppData|tgWebAppPlatform/.test(location.hash);
    if (inTelegram) {
      tg = (await waitForTelegram(2500)) || tg;
    } else {
      tg = getTg() || tg;
    }
    initTelegram();

    const configResult = await configPromise;
    if (!configResult.ok) {
      showError(configResult.error);
      return;
    }
    state.config = configResult.value;

    renderTeamsStrip();
    buildRoulette();
    updateFootnote();

    if (state.config.party) {
      const kicker = document.querySelector('.kicker');
      if (kicker) kicker.textContent = state.config.party;
    }

    try {
      const me = await api('/api/me');
      state.canViewTeams = true;
      updateTeamsButton();
      if (me && me.participant) {
        renderResult(me.participant, { isNew: false, instant: true });
      }
    } catch (err) {
      state.canViewTeams = false;
      updateTeamsButton();
      if (err.status === 401) showError(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
