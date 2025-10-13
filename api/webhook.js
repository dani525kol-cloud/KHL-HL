// api/webhook.js

// — отключаем автопарсинг тела, сами прочитаем сырое JSON —
module.exports.config = { api: { bodyParser: false } };

/* ========= НАСТРОЙКИ ========= */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'ВАШ_ТОКЕН_ТГ_БОТА'; // лучше через ENV!
const TZ = 'Europe/Moscow';

// CSV-urls по месяцам (подставь свои ссылки Яндекс-таблиц/CSV)
const MONTH_URLS = {
  10: 'https://.../october.csv',
  11: 'https://.../november.csv',
  // 12: 'https://.../december.csv',
};

// Индексы колонок (0-based) в твоём CSV
const COL = {
  MATCH:     0, // МАТЧ
  TIME:      1, // ВРЕМЯ
  EDITOR:    2, // МОНТАЖЕР
  LINK_DISK: 3, // Ссылка на готовый хайлайт (на диске) — не используется в ответе
  LINK_YT:   4, // YOUTUBE КХЛ — не используется в ответе
};

/* ========= TG API ========= */
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const menu = () => ({
  inline_keyboard: [[
    { text: 'Сегодня', callback_data: 'today' },
    { text: '3 дня',   callback_data: '3days' },
  ]]
});

/* ========= ДАТЫ ========= */
function dfmt(d) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day:'2-digit', month:'2-digit', year:'numeric' })
    .format(d).replace(/\//g,'.'); // dd.MM.yyyy
}
function todayPlus(days=0) {
  const d = new Date();
  d.setHours(12,0,0,0); // чтобы не скакало по TZ
  d.setDate(d.getDate()+days);
  return d;
}

/* ========= CSV ========= */
async function fetchCsv(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`CSV_FETCH_${r.status}`);
  return t;
}
function csvParse(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const out = []; let cur = "", inQ = false;
    for (let i=0; i<line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (ch === ',' && !inQ) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  });
}

/* ===== Получить ссылку CSV по дате (месяцу) ===== */
function getCsvUrlForDate(d) {
  const month = parseInt(new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, month:'numeric' }).format(d), 10);
  return MONTH_URLS[month] || null;
}

/* ===== Разбор даты из колонки "МАТЧ": поддержка "1 октября (...)" и "dd.MM.yyyy" ===== */
function extractDateDDMMYYYY(s) {
  s = (s||'').trim();

  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return `${m1[1].padStart(2,'0')}.${m1[2].padStart(2,'0')}.${m1[3]}`;

  const months = {
    'января':'01','февраля':'02','марта':'03','апреля':'04','мая':'05','июня':'06',
    'июля':'07','августа':'08','сентября':'09','октября':'10','ноября':'11','декабря':'12'
  };
  const m2 = s.toLowerCase().match(/^(\d{1,2})\s+([а-яё]+)/i);
  if (m2 && months[m2[2]]) {
    const yyyy = new Date().getFullYear();
    return `${m2[1].padStart(2,'0')}.${months[m2[2]]}.${yyyy}`;
  }
  return null;
}

/* ===== Группировка строк CSV по дате ===== */
function groupByDate(rows) {
  const map = new Map();
  for (const r of rows) {
    const ds = extractDateDDMMYYYY(r[COL.MATCH]);
    if (!ds) continue;
    if (!map.has(ds)) map.set(ds, []);
    map.get(ds).push(r);
  }
  return map;
}

/* ===== Формат ответа (подсветка Колышева) ===== */
function formatLine(r) {
  const time  = r[COL.TIME]   || '';
  const match = r[COL.MATCH]  || '';
  const edRaw = r[COL.EDITOR] || '';
  const editor = /колышев/i.test(edRaw) ? '✅Колышев✅' : edRaw;
  // «16:30 ✅Колышев✅ Авангард - Адмирал»
  return `${time ? `${time} ` : ''}${editor ? editor+' ' : ''}${match}`.trim();
}

function renderDayCaption(dateStr, isToday=false) {
  return isToday ? `График сегодня:` : `График ${dateStr}:`;
}

function renderDayBlock(dateStr, rows, isToday=false) {
  if (!rows || !rows.length) {
    return `${renderDayCaption(dateStr, isToday)}\n—`;
  }
  const lines = rows.map(formatLine);
  return `${renderDayCaption(dateStr, isToday)}\n${lines.join('\n')}`;
}

/* ===== Telegram I/O с логами ===== */
async function sendMessage(chatId, text, markup) {
  const payload = { chat_id: chatId, text: text || ' ', disable_web_page_preview: true };
  if (markup) payload.reply_markup = markup;

  try {
    const resp = await fetch(`${TG_API}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const body = await resp.text();
    console.log('sendMessage', resp.status, body);
  } catch (e) {
    console.error('sendMessage ERROR', e);
  }
}
async function answerCallbackQuery(id) {
  if (!id) return;
  try {
    const resp = await fetch(`${TG_API}/answerCallbackQuery`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ callback_query_id: id })
    });
    const body = await resp.text();
    console.log('answerCallbackQuery', resp.status, body);
  } catch (e) {
    console.error('answerCallbackQuery ERROR', e);
  }
}

/* ===== Основная логика: N дней вперёд ===== */
async function handleDays(chatId, days) {
  // 1) Целевые даты
  const targets = Array.from({length: days}, (_,i) => todayPlus(i));

  // 2) Список нужных месячных CSV (грузим каждую ссылку один раз)
  const byUrl = new Map();
  for (const d of targets) {
    const url = getCsvUrlForDate(d);
    if (url) byUrl.set(url, null);
  }

  for (const url of [...byUrl.keys()]) {
    try {
      const text = await fetchCsv(url);
      const rows = csvParse(text).slice(1); // срезаем заголовок
      byUrl.set(url, rows);
      console.log('csv loaded', url, rows.length);
    } catch (e) {
      console.error('csv load error', url, e?.message);
      byUrl.set(url, []);
    }
  }

  // 3) Собираем блоки по датам
  const parts = [];
  for (let i=0; i<targets.length; i++) {
    const d  = targets[i];
    const ds = dfmt(d);
    const url = getCsvUrlForDate(d);
    const rows = byUrl.get(url) || [];
    const grouped = groupByDate(rows);
    const hit = grouped.get(ds) || [];
    parts.push(renderDayBlock(ds, hit, i===0));
  }

  // 4) Отправляем
  await sendMessage(chatId, parts.join('\n\n'), menu());
}

/* ===== Вспомогательное чтение сырого тела ===== */
async function readRaw(req) {
  if (req.body) return req.body; // на всякий случай
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return {}; }
}

/* ===== Vercel handler ===== */
module.exports = async (req, res) => {
  try {
    // GET тесты из браузера:
    //   /api/webhook -> alive
    //   /api/webhook?test=<chat_id> -> шлёт тестовое сообщение
    if (req.method === 'GET') {
      const testChat = req.query?.test;
      if (testChat) {
        await sendMessage(testChat, '✅ Vercel → Telegram работает');
        return res.status(200).send('test sent');
      }
      return res.status(200).send('alive');
    }

    const body = await readRaw(req);
    console.log('update_type=',
      body?.callback_query ? 'callback_query' :
      body?.message ? 'message' : 'unknown'
    );

    if (body?.callback_query) {
      const cq = body.callback_query;
      const chatId = cq?.message?.chat?.id;
      const data   = cq?.data;
      await answerCallbackQuery(cq.id); // гасим «часики» у кнопки
      if (chatId && data) {
        if (data === 'today')     await handleDays(chatId, 1);
        else if (data === '3days') await handleDays(chatId, 3);
      }
    } else if (body?.message) {
      const msg    = body.message;
      const chatId = msg?.chat?.id;
      const text   = (msg?.text || '').trim().toLowerCase();

      if (!chatId) {
        console.log('no chatId in message');
      } else if (/^\/start/.test(text)) {
        await sendMessage(chatId, 'Выбери:', menu());
      } else if (text === '/today' || text === 'сегодня') {
        await handleDays(chatId, 1);
      } else if (text === '/3days' || text === '3 дня') {
        await handleDays(chatId, 3);
      } else {
        await sendMessage(chatId, 'Команды: /today, /3days', menu());
      }
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error('HANDLER ERROR', e);
    return res.status(200).send('ok'); // Telegram ждёт 200
  }
};
