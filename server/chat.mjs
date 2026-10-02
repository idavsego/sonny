/*
 * Бэкенд для чата Сонни.
 *
 * Зачем: ключ Anthropic нельзя держать в sonny-v9.html — его увидит любой,
 * кто откроет исходник страницы. Страница стучится сюда, этот сервер
 * добавляет ключ и пересылает запрос модели.
 *
 * Запуск:  ANTHROPIC_API_KEY=sk-ant-... node chat.mjs
 * Подробнее: README.md
 */
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

// Читаем .env, если он есть рядом (Node 20.12+). Без этого ключ из .env
// не подхватится и сервер не стартует.
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch { /* .env может отсутствовать — это нормально */ }
}

const PORT = Number(process.env.PORT || 8787);

// Откуда разрешено обращаться. Через запятую, например:
// ALLOWED_ORIGINS="https://sonny.ru,https://www.sonny.ru"
// Звёздочка — любой источник: удобно при отладке, на проде лучше перечислить.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

// Модели, которые разрешено запрашивать. Клиент не может попросить ничего
// другого — иначе чужой скрипт сможет гонять через твой ключ что угодно.
const ALLOWED_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);

// Доверять заголовку X-Forwarded-For можно ТОЛЬКО если перед сервером стоит
// твой nginx: иначе любой клиент подставит чужой адрес и обойдёт лимит.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const MAX_BODY_BYTES = 128 * 1024;   // защита от гигантских запросов
const MAX_OUTPUT_TOKENS = 4000;
const RATE_LIMIT = { windowMs: 60_000, max: 20 };  // запросов с одного IP в минуту

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Не задан ANTHROPIC_API_KEY — сервер не сможет обращаться к модели.');
  process.exit(1);
}

const client = new Anthropic();
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_LIMIT.windowMs) {
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  rec.n += 1;
  return rec.n > RATE_LIMIT.max;
}

// Раз в 5 минут выкидываем старые записи, чтобы Map не рос бесконечно.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > RATE_LIMIT.windowMs) hits.delete(ip);
}, 5 * 60_000).unref();

/* Разрешён ли источник. Пока ALLOWED_ORIGINS='*' — пускаем всех (отладка).
   Как только перечислены домены, запрос с чужого или вовсе без Origin
   отклоняется ДО обращения к модели: иначе чужой скрипт тратит твой ключ. */
function originAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : '');
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function send(res, status, body, origin) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Перестаём копить, но соединение не рвём: иначе клиент получит
        // обрыв связи вместо внятной ошибки.
        done = true; chunks.length = 0;
        req.resume();
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', e => { if (!done) reject(e); });
  });
}

/* Пропускаем дальше только то, что нужно приложению: роль + текст.
   Всё остальное из запроса игнорируется. */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-24)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string' || !m.content.trim()) return null;
    out.push({ role: m.role, content: m.content.slice(0, 8000) });
  }
  return out.length ? out : null;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(origin)); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') { send(res, 200, { ok: true }, origin); return; }
  if (req.method !== 'POST') { send(res, 405, { error: 'Только POST' }, origin); return; }

  if (!originAllowed(origin)) {
    console.warn('Отклонён запрос с источника:', origin || '(без Origin)');
    send(res, 403, { error: 'Источник не разрешён' }, origin);
    return;
  }

  const ip = (TRUST_PROXY
    ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : '') || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) { send(res, 429, { error: 'Слишком много запросов, подождите минуту' }, origin); return; }

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) {
    if (e?.tooLarge) { send(res, 413, { error: 'Запрос слишком большой' }, origin); return; }
    send(res, 400, { error: 'Некорректный запрос' }, origin); return;
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages) { send(res, 400, { error: 'Нет сообщений' }, origin); return; }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : 'claude-opus-5-5';
  const requested = Number(body.max_tokens);
  const max_tokens = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(Math.trunc(requested), 256), MAX_OUTPUT_TOKENS)
    : 2000;
  const system = typeof body.system === 'string' ? body.system.slice(0, 20000) : undefined;

  try {
    const response = await client.messages.create({ model, max_tokens, system, messages });
    // Отдаём ответ модели как есть: приложение уже умеет его читать.
    send(res, 200, {
      content: response.content,
      stop_reason: response.stop_reason,
      stop_details: response.stop_details ?? null,
    }, origin);
  } catch (e) {
    const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    console.error('Ошибка запроса к модели:', status, e?.message || e);
    // Клиенту не отдаём подробности ошибки провайдера.
    send(res, status, { error: 'Модель недоступна' }, origin);
  }
});

server.listen(PORT, () => console.log(`Бэкенд чата Сонни слушает порт ${PORT}`));
