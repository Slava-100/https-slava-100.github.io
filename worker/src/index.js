'use strict';

/**
 * Halloween Mini App — Cloudflare Worker + D1.
 * Отдаёт статику из public/ и API /api/*. Авторизация — Telegram initData.
 */

const TEAMS = [
  {
    id: 'zombie',
    name: 'Зомби',
    singular: 'зомби',
    emoji: '🧟',
    color: '#8fe36a',
    accent: '#c8ff9e',
    tagline: 'Медленно, но неотвратимо',
    hint: 'Твоя сила — в количестве. Хватай всех, кто ещё не определился.',
  },
  {
    id: 'vampire',
    name: 'Вампиры',
    singular: 'вампир',
    emoji: '🧛',
    color: '#ff3d5e',
    accent: '#ff8fa3',
    tagline: 'Кровь, бархат и безупречный вкус',
    hint: 'Держись уважительно — и тебя запомнят на пару веков.',
  },
  {
    id: 'ghost',
    name: 'Привидения',
    singular: 'привидение',
    emoji: '👻',
    color: '#8fd7ff',
    accent: '#d3f3ff',
    tagline: 'Мы здесь, но нас не видно',
    hint: 'Тихо подкрадывайся и появляйся в самый неожиданный момент.',
  },
  {
    id: 'werewolf',
    name: 'Оборотни',
    singular: 'оборотень',
    emoji: '🐺',
    color: '#ffb14a',
    accent: '#ffe0a8',
    tagline: 'Луна растёт — и мы тоже',
    hint: 'Нюх, инстинкты и полная луна. Остальное — дело техники.',
  },
];

const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
const TEAM_IDS = TEAMS.map((t) => t.id);
const ROUND_SIZE = TEAM_IDS.length;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' https://telegram.org",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const ALLOWED_ORIGINS = new Set(['https://slava-100.github.io']);

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign({}, JSON_HEADERS, extraHeaders),
  });
}

function textResponse(status, text, headers) {
  return new Response(text, {
    status,
    headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers || {}),
  });
}

function botUsername(env) {
  return String(env.BOT_USERNAME || '').trim().replace(/^@/, '');
}

function botUrl(env) {
  const name = botUsername(env);
  if (env.BOT_URL) return String(env.BOT_URL).trim().replace(/\/+$/, '');
  return name ? `https://t.me/${name}` : '';
}

function maxInitAge(env) {
  return env.MAX_INIT_AGE === undefined || env.MAX_INIT_AGE === ''
    ? 86400
    : Number(env.MAX_INIT_AGE);
}

function safeEqual(a, b) {
  const left = String(a == null ? '' : a);
  const right = String(b == null ? '' : b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(key, message) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

async function verifyInitData(initData, env) {
  if (!initData || typeof initData !== 'string') return { error: 'empty' };

  const botToken = String(env.BOT_TOKEN || '').trim();
  if (!botToken) return { error: 'no_bot_token' };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (err) {
    return { error: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { error: 'no_hash' };
  params.delete('hash');

  const pairs = [...params.entries()];
  const buildString = (entries) =>
    entries
      .slice()
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

  const secret = await hmac('WebAppData', botToken);
  const candidates = [buildString(pairs)];
  if (params.has('signature')) {
    candidates.push(buildString(pairs.filter(([key]) => key !== 'signature')));
  }

  let valid = false;
  for (const dataCheckString of candidates) {
    const digest = toHex(await hmac(secret, dataCheckString));
    if (safeEqual(digest, hash)) {
      valid = true;
      break;
    }
  }
  if (!valid) return { error: 'bad_signature' };

  const maxAge = maxInitAge(env);
  if (maxAge > 0) {
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate) return { error: 'no_auth_date' };
    if (Date.now() / 1000 - authDate > maxAge) return { error: 'expired' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (err) {
    return { error: 'bad_user' };
  }
  if (!user || !user.id) return { error: 'no_user' };
  return { user };
}

async function authUser(request, url, env) {
  const initData =
    request.headers.get('x-telegram-init-data') || url.searchParams.get('initData') || '';
  if (!initData) return { error: 'unauthorized' };
  return verifyInitData(initData, env);
}

async function getParty(db) {
  let row = await db
    .prepare('SELECT id, pool, round, seq, version FROM party WHERE id = 1')
    .first();
  if (!row) {
    await db
      .prepare('INSERT OR IGNORE INTO party (id, pool, round, seq, version) VALUES (1, ?, 0, 0, 0)')
      .bind('[]')
      .run();
    row = await db
      .prepare('SELECT id, pool, round, seq, version FROM party WHERE id = 1')
      .first();
  }
  let pool = [];
  try {
    pool = JSON.parse(row.pool || '[]');
  } catch (err) {
    pool = [];
  }
  return {
    id: row.id,
    pool: pool.filter((id) => TEAM_BY_ID[id]),
    round: Number(row.round) || 0,
    seq: Number(row.seq) || 0,
    version: Number(row.version) || 0,
  };
}

async function countByTeam(db) {
  const { results } = await db
    .prepare('SELECT team, COUNT(*) AS count FROM participants GROUP BY team')
    .all();
  const counts = Object.fromEntries(TEAM_IDS.map((id) => [id, 0]));
  for (const row of results || []) {
    if (counts[row.team] !== undefined) counts[row.team] = Number(row.count);
  }
  return counts;
}

async function countAll(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM participants').first();
  return Number((row && row.n) || 0);
}

async function roundAssigned(db, round) {
  if (!round) return 0;
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM participants WHERE round = ?')
    .bind(round)
    .first();
  return Number((row && row.n) || 0);
}

async function getParticipant(db, uid) {
  return db.prepare('SELECT * FROM participants WHERE id = ?').bind(uid).first();
}

function publicParticipant(participant, counts, total) {
  const team = TEAM_BY_ID[participant.team];
  return {
    team: participant.team,
    teamName: team ? team.name : participant.team,
    name: participant.name,
    n: participant.n,
    round: participant.round,
    at: participant.at,
    teamCount: counts[participant.team] || 0,
    total,
  };
}

function randomInt(max) {
  if (max <= 1) return 0;
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % max;
}

async function handleConfig(env) {
  const total = await countAll(env.DB);
  return json({
    ok: true,
    teams: TEAMS,
    assigned: total,
    devMode: false,
    publicUrl: '',
    botUsername: botUsername(env),
    botUrl: botUrl(env),
    party: env.PARTY_TITLE || '',
  });
}

async function handleMe(request, url, env) {
  const auth = await authUser(request, url, env);
  if (auth.error) return json({ ok: false, error: auth.error }, 401);

  const uid = String(auth.user.id);
  const participant = await getParticipant(env.DB, uid);
  if (!participant) return json({ ok: true, participant: null });
  const counts = await countByTeam(env.DB);
  const total = await countAll(env.DB);
  return json({ ok: true, participant: publicParticipant(participant, counts, total) });
}

async function handleJoin(request, url, env) {
  const auth = await authUser(request, url, env);
  if (auth.error) return json({ ok: false, error: auth.error }, 401);

  const user = auth.user;
  const uid = String(user.id);
  let participant = await getParticipant(env.DB, uid);
  let isNew = false;

  if (!participant) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const party = await getParty(env.DB);
      const pool = party.pool.slice();
      let round = party.round;

      if (pool.length === 0) {
        pool.push(...TEAM_IDS);
        round += 1;
      }

      const index = randomInt(pool.length);
      const team = pool[index];
      pool.splice(index, 1);

      const seq = party.seq + 1;
      const at = Date.now();
      const name =
        [user.first_name, user.last_name].filter(Boolean).join(' ').trim().slice(0, 64) ||
        'Таинственный гость';
      const username = String(user.username || '').slice(0, 64);
      const photo = String(user.photo_url || '').slice(0, 512);

      const update = env.DB
        .prepare(
          'UPDATE party SET pool = ?, round = ?, seq = ?, version = version + 1 ' +
            'WHERE id = 1 AND version = ?'
        )
        .bind(JSON.stringify(pool), round, seq, party.version);

      const insert = env.DB
        .prepare(
          'INSERT OR IGNORE INTO participants (id, name, username, photo, team, round, at, n) ' +
            'SELECT ?, ?, ?, ?, ?, ?, ?, ? ' +
            'WHERE (SELECT version FROM party WHERE id = 1) = ?'
        )
        .bind(uid, name, username, photo, team, round, at, seq, party.version + 1);

      const results = await env.DB.batch([update, insert]);
      const inserted = results && results[1] && results[1].meta && results[1].meta.changes > 0;

      if (inserted) {
        participant = await getParticipant(env.DB, uid);
        isNew = true;
        break;
      }

      const existing = await getParticipant(env.DB, uid);
      if (existing) {
        participant = existing;
        break;
      }
    }

    if (!participant) return json({ ok: false, error: 'conflict' }, 409);
  }

  const counts = await countByTeam(env.DB);
  const total = await countAll(env.DB);
  const party = await getParty(env.DB);

  return json({
    ok: true,
    isNew,
    participant: publicParticipant(participant, counts, total),
    progress: {
      round: party.round,
      roundAssigned: await roundAssigned(env.DB, party.round),
      roundSize: ROUND_SIZE,
    },
  });
}

async function handleTeams(request, url, env) {
  const auth = await authUser(request, url, env);
  if (auth.error) return json({ ok: false, error: auth.error }, 401);

  const { results } = await env.DB
    .prepare('SELECT id, name, username, team, round, at, n FROM participants ORDER BY n ASC')
    .all();
  const list = results || [];
  const counts = await countByTeam(env.DB);
  const party = await getParty(env.DB);

  return json({
    ok: true,
    teams: TEAMS.map((team) => ({
      id: team.id,
      name: team.name,
      emoji: team.emoji,
      color: team.color,
      accent: team.accent,
      tagline: team.tagline,
      count: counts[team.id],
      members: list
        .filter((p) => p.team === team.id)
        .map((p) => ({
          n: p.n,
          name: p.name,
          username: p.username || '',
          round: p.round,
          at: p.at,
        })),
    })),
    totals: {
      participants: list.length,
      round: party.round,
      roundAssigned: await roundAssigned(env.DB, party.round),
      roundSize: ROUND_SIZE,
      poolRemaining: party.pool.length,
      pool: party.pool.slice(),
    },
    now: Date.now(),
  });
}

function adminAllowed(request, url, env) {
  const token = String(env.ADMIN_TOKEN || '').trim();
  if (!token) return false;
  const provided = request.headers.get('x-admin-token') || url.searchParams.get('token') || '';
  return safeEqual(provided, token);
}

async function handleAdminStats(request, url, env) {
  if (!adminAllowed(request, url, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const { results } = await env.DB
    .prepare('SELECT id, name, username, photo, team, round, at, n FROM participants ORDER BY n ASC')
    .all();
  const list = results || [];
  const counts = await countByTeam(env.DB);
  const party = await getParty(env.DB);

  return json({
    ok: true,
    teams: TEAMS.map((team) =>
      Object.assign({}, team, {
        count: counts[team.id],
        members: list
          .filter((p) => p.team === team.id)
          .map((p) => ({
            id: p.id,
            name: p.name,
            username: p.username || '',
            n: p.n,
            round: p.round,
            at: p.at,
            photo: p.photo || '',
          })),
      })
    ),
    totals: {
      participants: list.length,
      round: party.round,
      roundAssigned: await roundAssigned(env.DB, party.round),
      roundSize: ROUND_SIZE,
      poolRemaining: party.pool.length,
      pool: party.pool.slice(),
    },
    publicUrl: '',
    now: Date.now(),
  });
}

async function handleAdminReset(request, url, env, mode) {
  if (!adminAllowed(request, url, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (mode === 'all') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM participants'),
      env.DB.prepare(
        'UPDATE party SET pool = ?, round = 0, seq = 0, version = version + 1 WHERE id = 1'
      ).bind('[]'),
    ]);
    return json({ ok: true, round: 0, pool: [] });
  }

  const party = await getParty(env.DB);
  const round = party.round + 1;
  const pool = TEAM_IDS.slice();
  await env.DB
    .prepare('UPDATE party SET pool = ?, round = ?, version = version + 1 WHERE id = 1')
    .bind(JSON.stringify(pool), round)
    .run();
  return json({ ok: true, round, pool });
}

async function handleAdminCsv(request, url, env) {
  if (!adminAllowed(request, url, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const { results } = await env.DB
    .prepare('SELECT id, name, username, team, round, at, n FROM participants ORDER BY n ASC')
    .all();
  const list = results || [];
  const esc = (value) => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  const rows = [
    ['№', 'Имя', 'Username', 'Telegram ID', 'Команда', 'Раунд', 'Время'].map(esc).join(';'),
  ];
  for (const p of list) {
    const team = TEAM_BY_ID[p.team];
    rows.push(
      [
        p.n,
        p.name,
        p.username ? '@' + p.username : '',
        p.id,
        team ? team.name : p.team,
        p.round,
        new Date(p.at).toLocaleString('ru-RU'),
      ]
        .map(esc)
        .join(';')
    );
  }

  const body = '\uFEFF' + rows.join('\r\n');
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="halloween-teams-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function handleApi(request, url, env) {
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/api/config') {
    return handleConfig(env);
  }
  if (request.method === 'GET' && pathname === '/api/me') {
    return handleMe(request, url, env);
  }
  if (request.method === 'POST' && pathname === '/api/join') {
    return handleJoin(request, url, env);
  }
  if (
    request.method === 'GET' &&
    (pathname === '/api/teams' || pathname === '/api/host/teams')
  ) {
    return handleTeams(request, url, env);
  }

  if (pathname.startsWith('/api/admin/')) {
    if (request.method === 'GET' && pathname === '/api/admin/stats') {
      return handleAdminStats(request, url, env);
    }
    if (request.method === 'GET' && pathname === '/api/admin/export.csv') {
      return handleAdminCsv(request, url, env);
    }
    if (request.method === 'POST' && pathname === '/api/admin/reset-round') {
      return handleAdminReset(request, url, env, 'round');
    }
    if (request.method === 'POST' && pathname === '/api/admin/reset-all') {
      return handleAdminReset(request, url, env, 'all');
    }
  }

  return json({ ok: false, error: 'not_found' }, 404);
}

function withAssetHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  const type = headers.get('Content-Type') || '';
  const isHtml = type.includes('text/html');
  const isCode =
    isHtml ||
    type.includes('text/css') ||
    type.includes('javascript') ||
    type.includes('application/json') ||
    /\.(css|js|json)$/.test(pathname);

  if (isCode) {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  }
  if (isHtml) headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-telegram-init-data, x-admin-token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS' && cors) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (pathname === '/health') {
      return json({ ok: true, uptime: 0 }, 200, cors || {});
    }

    if (pathname.startsWith('/api/')) {
      const response = await handleApi(request, url, env);
      if (cors) {
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(cors)) headers.set(key, value);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
    }

    if (!env.ASSETS) {
      return textResponse(503, 'Static assets binding is not configured');
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      const adminUrl = new URL('/admin.html', url);
      const response = await env.ASSETS.fetch(
        new Request(adminUrl.toString(), { method: 'GET', headers: request.headers })
      );
      return withAssetHeaders(response, '/admin.html');
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404 && String(request.headers.get('Accept') || '').includes('text/html')) {
      return textResponse(
        404,
        '404 — здесь водятся привидения. <a href="/">На главную</a>',
        { 'Content-Type': 'text/html; charset=utf-8' }
      );
    }
    return withAssetHeaders(response, pathname);
  },
};
