'use strict';

/**
 * Локальные команды без сервера и без зависимостей:
 *
 *   node tools/cli.js status        — кто в какой команде
 *   node tools/cli.js export        — выгрузить список команд в exports/ (CSV + MD)
 *   node tools/cli.js reset         — очистить базу перед новой вечеринкой
 *
 * Все данные читаются/пишутся в data/db.json (или DATA_DIR из .env).
 * Сервер для этих команд останавливать не обязательно, но лучше — так
 * точно не будет одновременной записи.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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
loadEnv();

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const EXPORT_DIR = path.resolve(ROOT, process.env.EXPORT_DIR || 'exports');
const PORT = Number(process.env.PORT || 3000);

const TEAMS = [
  { id: 'zombie', name: 'Зомби', emoji: '🧟' },
  { id: 'vampire', name: 'Вампиры', emoji: '🧛' },
  { id: 'ghost', name: 'Привидения', emoji: '👻' },
  { id: 'werewolf', name: 'Оборотни', emoji: '🐺' },
];
const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return (
    `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function stamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}`
  );
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`База не найдена: ${DB_FILE}`);
    console.error('Запусти сервер хотя бы один раз — он создаст файл.');
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.participants || typeof db.participants !== 'object') db.participants = {};
  if (!Array.isArray(db.pool)) db.pool = [];
  return db;
}

function members(db) {
  return Object.values(db.participants).sort((a, b) => (a.n || 0) - (b.n || 0));
}

function byTeam(db) {
  const list = members(db);
  return TEAMS.map((team) => ({
    team,
    list: list.filter((p) => p.team === team.id),
  }));
}

function printStatus(db) {
  const list = members(db);
  console.log('');
  console.log(`  База: ${DB_FILE}`);
  console.log(`  Гостей: ${list.length} · раунд: ${db.round || 0}` +
    ` · в текущем пуле: ${db.pool.length}`);
  console.log('');

  let maxName = 0;
  for (const { team } of byTeam(db)) maxName = Math.max(maxName, team.name.length);

  for (const { team, list: teamList } of byTeam(db)) {
    console.log(
      `  ${team.emoji} ${team.name.padEnd(maxName + 2)} ${teamList.length}`
    );
    for (const p of teamList) {
      const handle = p.username ? ` (@${p.username})` : '';
      console.log(`       ${String(p.n).padStart(2)}. ${p.name}${handle} · ${fmtTime(p.at)}`);
    }
    if (teamList.length) console.log('');
  }

  if (!list.length) console.log('\n  Пока никто не приходил.\n');
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportFiles(db) {
  const list = members(db);
  if (!list.length) {
    console.error('Пока никто не приходил — выгружать нечего.');
    process.exit(1);
  }

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const base = `teams-${stamp()}`;
  const csvFile = path.join(EXPORT_DIR, `${base}.csv`);
  const mdFile = path.join(EXPORT_DIR, `${base}.md`);

  const rows = [['№', 'Команда', 'Имя', 'Username', 'Telegram ID', 'Время', 'Раунд']];
  for (const p of list) {
    const team = TEAM_BY_ID[p.team];
    rows.push([
      p.n,
      team ? team.name : p.team,
      p.name,
      p.username ? '@' + p.username : '',
      p.id,
      fmtTime(p.at),
      p.round,
    ]);
  }
  const csv = '\ufeff' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  fs.writeFileSync(csvFile, csv, 'utf8');

  const lines = [];
  lines.push(`# Команды — ${fmtTime(Date.now())}`);
  lines.push('');
  lines.push(`Всего гостей: **${list.length}** · раундов: ${Math.max(0, Math.ceil(list.length / TEAMS.length))}`);
  lines.push('');
  for (const { team, list: teamList } of byTeam(db)) {
    lines.push(`## ${team.emoji} ${team.name} (${teamList.length})`);
    lines.push('');
    teamList.forEach((p, i) => {
      const handle = p.username ? ` (@${p.username})` : '';
      lines.push(`${i + 1}. ${p.name}${handle}`);
    });
    if (!teamList.length) lines.push('_пока никого_');
    lines.push('');
  }
  fs.writeFileSync(mdFile, lines.join('\n'), 'utf8');

  console.log('');
  console.log('  Готово! Файлы для отправки:');
  console.log('   • ' + csvFile + '   (Excel / Google Таблицы)');
  console.log('   • ' + mdFile + '   (просто текст, удобно кинуть в чат)');
  console.log('');
}

function serverAlive() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/health', timeout: 1200 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function serverReset() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/admin/reset-all',
        method: 'POST',
        timeout: 2500,
        headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function resetDb(yes) {
  const db = readDb();
  const count = members(db).length;

  const run = async () => {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, `before-reset-${stamp()}.json`);
    fs.copyFileSync(DB_FILE, copy);

    // Если сервер запущен — сбрасываем через него, иначе он затрёт файл
    // своей копией состояния из памяти при следующем госте.
    if (await serverAlive()) {
      if (!process.env.ADMIN_TOKEN) {
        console.error(
          '\n  Сервер запущен, но ADMIN_TOKEN не задан в .env.' +
            '\n  Останови сервер (Ctrl+C) и повтори — или добавь ADMIN_TOKEN.\n'
        );
        process.exitCode = 1;
        return;
      }
      const status = await serverReset();
      if (status === 200) {
        console.log(`\n  База очищена через работающий сервер (было ${count} гостей).`);
        console.log(`  Копия старой базы: ${copy}\n`);
        return;
      }
      console.error(
        `\n  Сервер ответил ${status || 'ошибкой'} — сбрасывать файл вручную не стал.` +
          '\n  Проверь ADMIN_TOKEN в .env или останови сервер и повтори.\n'
      );
      process.exitCode = 1;
      return;
    }

    const fresh = {
      version: 1,
      createdAt: Date.now(),
      pool: [],
      round: 0,
      seq: 0,
      participants: {},
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    console.log(`\n  База очищена (было ${count} гостей).`);
    console.log(`  Копия старой базы: ${copy}\n`);
  };

  if (yes) {
    await run();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(
    `Очистить базу и удалить ${count} гостей? Это действие нельзя отменить. [y/N] `,
    async (answer) => {
      rl.close();
      if (/^y(es)?$/i.test(answer.trim())) await run();
      else console.log('Отменено, ничего не менял.');
    }
  );
}

const [command = 'status', ...args] = process.argv.slice(2);

switch (command) {
  case 'status':
    printStatus(readDb());
    break;
  case 'export':
    exportFiles(readDb());
    break;
  case 'reset':
    resetDb(args.includes('--yes'));
    break;
  case '-h':
  case '--help':
  case 'help':
    console.log(`
  node tools/cli.js status        — список гостей по командам
  node tools/cli.js export        — выгрузить CSV и Markdown в exports/
  node tools/cli.js reset [--yes] — очистить базу перед новой вечеринкой
`);
    break;
  default:
    console.error(`Неизвестная команда: ${command}`);
    console.error('Доступно: status, export, reset');
    process.exit(1);
}
