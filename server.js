'use strict';

/**
 * Halloween Party Mini App — сервер без внешних зависимостей.
 * Node.js >= 16.
 *
 * Что делает:
 *  - проверяет подпись initData из Telegram WebApp;
 *  - распределяет гостей по 4 командам «равными порциями» (по одному каждой команде за раунд);
 *  - отдаёт статику (мини-апп + админку);
 *  - хранит состояние в data/db.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

/* ------------------------------------------------------------------ */
/* Конфигурация                                                        */
/* ------------------------------------------------------------------ */

// Мини-загрузчик .env (без зависимостей).
function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const BOT_USERNAME = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
const BOT_URL = (process.env.BOT_URL || (BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : ''))
  .trim()
  .replace(/\/+$/, '');
// Срок жизни initData в секундах (0 — не проверять). По умолчанию сутки.
const MAX_INIT_AGE = Number(
  process.env.MAX_INIT_AGE === undefined ? 86400 : process.env.MAX_INIT_AGE
);
// Локальный режим: без бота, авторизация по заголовку x-dev-user.
const DEV_MODE = process.env.DEV_MODE === '1' || !BOT_TOKEN;

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ------------------------------------------------------------------ */
/* Команды                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Хранилище                                                           */
/* ------------------------------------------------------------------ */

function defaultDb() {
  return {
    version: 1,
    createdAt: Date.now(),
    // Команды, которые ещё не выпали в текущем раунде.
    pool: [],
    // Номер текущего раунда (0 — ещё никто не приходил).
    round: 0,
    // Сквозной номер гостя.
    seq: 0,
    participants: {},
  };
}

function normalizeDb(raw) {
  const db = Object.assign(defaultDb(), raw || {});
  if (!Array.isArray(db.pool)) db.pool = [];
  db.pool = db.pool.filter((id) => TEAM_BY_ID[id]);
  if (!db.participants || typeof db.participants !== 'object') db.participants = {};
  db.round = Number(db.round) || 0;
  db.seq = Number(db.seq) || Object.keys(db.participants).length;
  return db;
}

let db = defaultDb();

// Копия базы на каждый запуск сервера — на случай неудачного сброса/правки.
function backupDb() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(DB_FILE, path.join(dir, `db-${stamp}.json`));
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^db-.*\.json$/.test(name))
      .sort();
    while (files.length > 12) {
      fs.unlinkSync(path.join(dir, files.shift()));
    }
  } catch (err) {
    console.warn('[db] Резервная копия не создана:', err.message);
  }
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
      backupDb();
      log(`Хранилище загружено: ${Object.keys(db.participants).length} участников, раунд ${db.round}`);
    } else {
      db = defaultDb();
      saveDb();
      log('Создано новое хранилище: ' + DB_FILE);
    }
  } catch (err) {
    console.error('[db] Не удалось прочитать хранилище, начинаю с чистого:', err.message);
    db = defaultDb();
  }
}

let lastSaveError = 0;
function saveDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    // Не спамим одинаковой ошибкой на каждого гостя.
    if (Date.now() - lastSaveError > 5000) {
      lastSaveError = Date.now();
      console.error('[db] Ошибка записи:', err.message);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Алгоритм распределения                                              */
/* ------------------------------------------------------------------ */

/**
 * «Равные порции»: в каждом раунде команды выпадают по одной — случайно,
 * но без повторов. Раунд = 4 человека, в нём ровно по одному зомби,
 * вампиру, привидению и оборотню. Затем пул сбрасывается.
 */
function drawTeam() {
  if (db.pool.length === 0) {
    db.pool = TEAM_IDS.slice();
    db.round += 1;
  }
  const idx = crypto.randomInt(db.pool.length);
  return db.pool.splice(idx, 1)[0];
}

function countByTeam() {
  const counts = Object.fromEntries(TEAM_IDS.map((id) => [id, 0]));
  for (const p of Object.values(db.participants)) {
    if (counts[p.team] !== undefined) counts[p.team] += 1;
  }
  return counts;
}

function roundAssigned() {
  if (db.round <= 0) return 0;
  let n = 0;
  for (const p of Object.values(db.participants)) {
    if (p.round === db.round) n += 1;
  }
  return n;
}

function publicParticipant(p) {
  const team = TEAM_BY_ID[p.team];
  const counts = countByTeam();
  return {
    team: p.team,
    teamName: team ? team.name : p.team,
    name: p.name,
    n: p.n,
    round: p.round,
    at: p.at,
    teamCount: counts[p.team] || 0,
    total: Object.keys(db.participants).length,
  };
}

/* ------------------------------------------------------------------ */
/* Telegram initData                                                   */
/* ------------------------------------------------------------------ */

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Проверка подписи initData по алгоритму Telegram:
 * secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 * hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 */
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return { error: 'empty' };
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
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculate = (dataCheckString) =>
    crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Telegram подписывает все полученные поля. В части версий SDK в initData
  // появилось поле `signature` (отдельная Ed25519-подпись) — на всякий случай
  // принимаем и вариант, где оно не входит в data-check-string.
  const candidates = [buildString(pairs)];
  if (params.has('signature')) {
    candidates.push(buildString(pairs.filter(([key]) => key !== 'signature')));
  }

  if (!candidates.some((dataCheckString) => safeEqualHex(calculate(dataCheckString), hash))) {
    return { error: 'bad_signature' };
  }

  if (MAX_INIT_AGE > 0) {
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate) return { error: 'no_auth_date' };
    if (Date.now() / 1000 - authDate > MAX_INIT_AGE) return { error: 'expired' };
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

function devUserFrom(value) {
  const safe = String(value || 'guest').replace(/[^\w-]/g, '').slice(0, 32) || 'guest';
  return {
    id: 'dev-' + safe,
    first_name: 'Гость ' + safe,
    username: 'dev_' + safe,
  };
}

function authUser(req, url) {
  let initData = req.headers['x-telegram-init-data'] || url.searchParams.get('initData') || '';

  if (initData) {
    if (!BOT_TOKEN) {
      if (!DEV_MODE) return { error: 'no_bot_token' };
      // В dev-режиме подпись проверить нечем — доверяем переданному user.
      try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user') || 'null');
        if (user && user.id) return { user };
      } catch (err) {
        /* fallthrough к dev-пользователю */
      }
      const dev = req.headers['x-dev-user'];
      if (dev) return { user: devUserFrom(dev) };
      return { error: 'bad_init_data' };
    }
    const result = verifyInitData(initData);
    if (result.error) return result;
    return { user: result.user };
  }

  if (DEV_MODE) {
    const dev = req.headers['x-dev-user'] || url.searchParams.get('dev');
    // Если бот настроен, «режим разработчика» пускаем только с этого же
    // компьютера. Гости через туннель приходят с реальным X-Forwarded-For.
    const localOnly = BOT_TOKEN && !isLoopback(clientIp(req));
    if (!localOnly) {
      if (dev) return { user: devUserFrom(dev) };
      if (!BOT_TOKEN) return { user: devUserFrom('guest') };
    }
  }
  return { error: 'unauthorized' };
}

/* ------------------------------------------------------------------ */
/* HTTP-утилиты                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function sendText(res, status, text, headers) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      },
      headers || {}
    )
  );
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath, req) {
  let rel = urlPath;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Красивый 404 для страниц, короткий — для остального.
      if ((req.headers.accept || '').includes('text/html')) {
        sendText(res, 404, '404 — здесь водятся привидения. <a href="/">На главную</a>', {
          'Content-Type': 'text/html; charset=utf-8',
        });
      } else {
        sendText(res, 404, 'Not found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = CSP;
    }
    if (type.startsWith('text/html') || ext === '.css' || ext === '.js' || ext === '.json') {
      // Telegram WebView агрессивно кэширует мини-апп. Отдаём без кэша,
      // иначе после обновления гости остаются на старой версии интерфейса.
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    } else {
      headers['Cache-Control'] = 'public, max-age=86400';
    }

    const compress =
      /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) &&
      (type.startsWith('text/') ||
        type.startsWith('application/json') ||
        type === 'application/manifest+json');

    if (compress) {
      // Сжимаем текстовые файлы: экономия трафика и меньший риск обрыва
      // медленных туннелей на больших app.js/styles.css.
      fs.readFile(filePath, (readErr, buf) => {
        if (readErr) {
          sendText(res, 500, 'Internal error');
          return;
        }
        zlib.gzip(buf, (zipErr, zipped) => {
          if (zipErr) {
            headers['Content-Length'] = stat.size;
            res.writeHead(200, headers);
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            fs.createReadStream(filePath).pipe(res);
            return;
          }
          headers['Content-Encoding'] = 'gzip';
          headers['Vary'] = 'Accept-Encoding';
          headers['Content-Length'] = zipped.length;
          res.writeHead(200, headers);
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          res.end(zipped);
        });
      });
      return;
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Простой rate limit                                                  */
/* ------------------------------------------------------------------ */

const rateBuckets = new Map();
const RATE_LIMIT = 240; // бросков жребия в минуту с одного IP
const RATE_WINDOW = 60 * 1000;
// За обратным прокси реальный IP приходит в X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function isLoopback(ip) {
  const value = String(ip || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || 'unknown').toString();
}

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

const rateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.start > RATE_WINDOW * 3) rateBuckets.delete(ip);
  }
}, RATE_WINDOW).unref();

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function countAll() {
  return Object.keys(db.participants).length;
}

function handleConfig(res) {
  sendJson(res, 200, {
    ok: true,
    teams: TEAMS,
    assigned: countAll(),
    devMode: DEV_MODE,
    publicUrl: PUBLIC_URL,
    botUsername: BOT_USERNAME,
    botUrl: BOT_URL,
    party: process.env.PARTY_TITLE || '',
  });
}

function handleMe(req, res, url) {
  const auth = authUser(req, url);
  if (auth.error) {
    sendJson(res, 401, { ok: false, error: auth.error });
    return;
  }
  const uid = String(auth.user.id);
  const p = db.participants[uid];
  if (!p) {
    sendJson(res, 200, { ok: true, participant: null });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    participant: publicParticipant(p),
  });
}

function handleJoin(req, res, url) {
  const auth = authUser(req, url);
  if (auth.error) {
    sendJson(res, 401, { ok: false, error: auth.error });
    return;
  }

  const user = auth.user;
  const uid = String(user.id);
  let participant = db.participants[uid];
  const isNew = !participant;

  if (isNew) {
    const team = drawTeam();
    const name = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(' ')
      .trim()
      .slice(0, 64) || 'Таинственный гость';

    db.seq += 1;
    participant = {
      id: uid,
      name,
      username: String(user.username || '').slice(0, 64),
      photo: String(user.photo_url || '').slice(0, 512),
      team,
      round: db.round,
      at: Date.now(),
      n: db.seq,
    };
    db.participants[uid] = participant;
    saveDb();
    log(
      `[draw] #${participant.n} ${participant.name} → ${team} ` +
        `(раунд ${participant.round}, в пуле ${db.pool.length})`
    );
  }

  sendJson(res, 200, {
    ok: true,
    isNew,
    participant: publicParticipant(participant),
    progress: {
      round: db.round,
      roundAssigned: roundAssigned(),
      roundSize: TEAM_IDS.length,
    },
  });
}

function adminAllowed(req, url) {
  if (!ADMIN_TOKEN) return DEV_MODE;
  const token = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
  return safeEqualHex(token, ADMIN_TOKEN);
}

function handleAdminStats(req, res, url) {
  if (!adminAllowed(req, url)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const list = Object.values(db.participants).sort((a, b) => a.n - b.n);
  const counts = countByTeam();
  sendJson(res, 200, {
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
      round: db.round,
      roundAssigned: roundAssigned(),
      roundSize: TEAM_IDS.length,
      poolRemaining: db.pool.length,
      pool: db.pool.slice(),
    },
    publicUrl: PUBLIC_URL,
    now: Date.now(),
  });
}

function handleAdminReset(req, res, url, mode) {
  if (!adminAllowed(req, url)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  if (mode === 'all') {
    db = defaultDb();
    saveDb();
    log('[admin] Полный сброс: все участники и раунды удалены');
  } else {
    // Новый раунд: пул снова полный, распределение начинается с чистого листа.
    db.pool = TEAM_IDS.slice();
    db.round += 1;
    saveDb();
    log(`[admin] Новый раунд №${db.round}, пул: ${db.pool.join(', ')}`);
  }
  sendJson(res, 200, { ok: true, round: db.round, pool: db.pool.slice() });
}

function handleAdminCsv(req, res, url) {
  if (!adminAllowed(req, url)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const list = Object.values(db.participants).sort((a, b) => a.n - b.n);
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
  // BOM, чтобы Excel не ломал кириллицу.
  const body = '\uFEFF' + rows.join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="halloween-teams-${new Date()
      .toISOString()
      .slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Список команд. Доступен любому гостю, прошедшему Telegram-авторизацию:
 * токен админки для просмотра не нужен.
 */
function handleTeams(req, res, url) {
  const auth = authUser(req, url);
  if (auth.error) {
    sendJson(res, 401, { ok: false, error: auth.error });
    return;
  }

  const list = Object.values(db.participants).sort((a, b) => a.n - b.n);
  const counts = countByTeam();
  sendJson(res, 200, {
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
      round: db.round,
      roundAssigned: roundAssigned(),
      roundSize: TEAM_IDS.length,
      poolRemaining: db.pool.length,
      pool: db.pool.slice(),
    },
    now: Date.now(),
  });
}

/* ------------------------------------------------------------------ */
/* Маршрутизация                                                       */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (err) {
    sendText(res, 400, 'Bad request');
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  if (pathname.startsWith('/api/')) {
    const ip = clientIp(req);
    if (pathname === '/api/join' && rateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: 'too_many_requests' });
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/config') return handleConfig(res);
      if (req.method === 'GET' && pathname === '/api/me') return handleMe(req, res, url);
      if (req.method === 'POST' && pathname === '/api/join') {
        req.resume(); // тело не нужно, но сокет надо дочитать
        return handleJoin(req, res, url);
      }
      if (req.method === 'GET' && (pathname === '/api/teams' || pathname === '/api/host/teams')) {
        return handleTeams(req, res, url);
      }
      if (pathname.startsWith('/api/admin/')) {
        if (req.method === 'GET' && pathname === '/api/admin/stats') return handleAdminStats(req, res, url);
        if (req.method === 'GET' && pathname === '/api/admin/export.csv') return handleAdminCsv(req, res, url);
        if (req.method === 'POST' && pathname === '/api/admin/reset-round') {
          req.resume();
          return handleAdminReset(req, res, url, 'round');
        }
        if (req.method === 'POST' && pathname === '/api/admin/reset-all') {
          req.resume();
          return handleAdminReset(req, res, url, 'all');
        }
      }
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    } catch (err) {
      console.error('[api]', pathname, err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
      return;
    } finally {
      if (process.env.LOG === '1') {
        console.log(`${req.method} ${pathname} — ${res.statusCode} (${Date.now() - started}ms)`);
      }
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }
  serveStatic(res, pathname, req);
});

/* ------------------------------------------------------------------ */
/* Старт                                                               */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.log(new Date().toLocaleTimeString('ru-RU'), ...args);
}

loadDb();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🎃  Halloween Party Mini App');
  console.log('  ---------------------------------------------');
  console.log(`  Мини-апп:  http://localhost:${PORT}/`);
  console.log(`  Админка:   http://localhost:${PORT}/admin`);
  console.log('  ---------------------------------------------');
  if (!BOT_TOKEN) {
    console.log('  ⚠  BOT_TOKEN не задан → DEV_MODE.');
    console.log('     Открой в браузере, авторизация поддельная (x-dev-user).');
    console.log('     Для продакшена заполни .env (см. .env.example).');
  } else {
    console.log('  ✔  BOT_TOKEN задан, подпись initData проверяется.');
  }
  if (!ADMIN_TOKEN) {
    console.log(DEV_MODE ? '  ⚠  ADMIN_TOKEN не задан → админка открыта (dev).' : '  ⚠  ADMIN_TOKEN не задан → админка выключена.');
  }
  console.log('');
});

process.on('SIGINT', () => {
  log('Остановка…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
});
