// Не парсим тело автоматически — читаем сами
module.exports.config = { api: { bodyParser: false } };

/* ===== НАСТРОЙКИ ===== */
const TELEGRAM_TOKEN = 'ВАШ_ТОКЕН_ТГ_БОТА';
const TZ = 'Europe/Moscow';

// CSV по месяцам (потом просто добавляй новые)
const MONTH_URLS = {
  10: 'https://.../october.csv', // Октябрь
  11: 'https://.../november.csv', // Ноябрь
  // 12: '...'
};

// Индексы колонок (0-based) в CSV: см. скрин
const COL = {
  MATCH: 0,        // "МАТЧ"
  TIME: 1,         // "ВРЕМЯ"
  EDITOR: 2,       // "МОНТАЖЕР"
  LINK_READY: 3,   // "Ссылка на готовый хайлайт (на диске)"
  LINK_YT: 4       // "YOUTUBE КХЛ"
};

/* ====== ТГ API ====== */
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const menu = () => ({
  inline_keyboard: [[
    { text: 'Сегодня', callback_data: 'today' },
    { text: '3 дня',   callback_data: '3days' },
  ]]
});

/* ====== ДАТЫ ====== */
function dfmt(d) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day:'2-digit', month:'2-digit', year:'numeric' })
    .format(d).replace(/\//g,'.'); // dd.MM.yyyy
}
function todayPlus(days=0) {
  const d = new Date();
  d.setHours(12,0,0,0); // чтобы не прыгало
  d.setDate(d.getDate()+days);
  return d;
}
function withTZDateOnly(ds) {
  // строка dd.MM.yyyy -> Date по TZ
  const [dd, mm, yyyy] = ds.split('.');
  return new Date(Date.UTC(+yyyy, +mm-1, +dd, 12, 0, 0)); // «полдень» UTC — нормально сравнивать по календарю
}

/* ===== CSV ===== */
async function fetchCsv(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error('CSV_FETCH');
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

/* ===== ССЫЛКА ДЛЯ ДАТЫ ===== */
function getCsvUrlForDate(d) {
  const month = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, month:'numeric' }).format(d);
  const m = parseInt(month,10);
  return MONTH_URLS[m] || null;
}

/* ===== ПАРСИНГ ДАТЫ ИЗ ПЕРВОГО СТОЛБЦА =====
   Поддержка «1 октября (среда)», «01.10.2025», «1 октября» и т.п.   */
function extractDateDDMMYYYY(s) {
  s = (s||'').trim();

  // dd.MM.yyyy
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return `${m1[1].padStart(2,'0')}.${m1[2].padStart(2,'0')}.${m1[3]}`;

  // «1 октября ...»
  const months = {
    'января':'01','февраля':'02','марта':'03','апреля':'04','мая':'05','июня':'06',
    'июля':'07','августа':'08','сентября':'09','октября':'10','ноября':'11','декабря':'12'
  };
  const m2 = s.toLowerCase().match(/^(\d{1,2})\s+([а-яё]+)/i);
  if (m2 && months[m2[2]]) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const dd = m2[1].padStart(2,'0');
    const mm = months[m2[2]];
    return `${dd}.${mm}.${yyyy}`;
  }
  return null;
}

/* ===== ГРУППИРОВКА ПО ДАТАМ ===== */
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

/* ===== ФОРМАТ ОТВЕТА ===== */
function formatLine(r) {
  const time  = r[COL.TIME]   || '';
  const match = r[COL.MATCH]  || '';
  const edRaw = r[COL.EDITOR] || '';
  const editor = /колышев/i.test(edRaw) ? '✅Колышев✅' : edRaw;
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

/* ===== ТЕЛЕГРАМ I/O ===== */
async function sendMessage(chatId, text, markup) {
  const payload = { chat_id: chatId, text: text || ' ', disable_web_page_preview: true };
  if (markup) payload.reply_markup = markup;
  await fetch(`${TG_API}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
  });
}

async function handleDays(chatId, days) {
  // собираем даты, учитывая переход месяца
  const targets = [];
  for (let i=0; i<days; i++) targets.push(todayPlus(i));
  // нужна коллекция URL по месяцам, которые задействованы
  const byMonth = new Map(); // month -> rows[]
  for (const d of targets) {
    const url = getCsvUrlForDate(d);
    if (!url) continue;
    byMonth.set(url, null);
  }
  // грузим CSV по каждому месяцу ровно 1 раз
  for (const url of [...byMonth.keys()]) {
    try {
      const text = await fetchCsv(url);
      const rows = csvParse(text).slice(1); // срезаем хедер
      byMonth.set(url, rows);
    } catch {
      byMonth.set(url, []); // чтобы не падать
    }
  }
  // строим карту дата->строки
  const allMap = new Map(); // dd.MM.yyyy -> rows[]
  for (const d of targets) {
    const ds = dfmt(d);
    allMap.set(ds, []);
    const url = getCsvUrlForDate(d);
    const rows = byMonth.get(url) || [];
    const grouped = groupByDate(rows);
    const hit = grouped.get(ds) || [];
    allMap.set(ds, hit);
  }
  // рендер
  const parts = targets.map((d, idx) => {
    const ds = dfmt(d);
    const rows = allMap.get(ds);
    return renderDayBlock(ds, rows, idx===0); // первый блок = «сегодня»
  });
  await sendMessage(chatId, parts.join('\n\n'), menu());
}

/* ====== ВЕРСЕЛ-ХЕНДЛЕР ====== */
async function readRaw(req) {
  if (req.body) return req.body;
  const chunks = []; for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}

module.exports = async (req, res) => {
  const body = await readRaw(req);
  try {
    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = cq?.message?.chat?.id;
      const data = cq?.data;
      if (chatId && data) {
        if (data === 'today')  await handleDays(chatId, 1);
        else if (data === '3days') await handleDays(chatId, 3);
      }
    } else if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim().toLowerCase();
      if (/^\/start/.test(text)) {
        await sendMessage(chatId, 'Выбери:', menu());
      } else if (text === '/today' || text === 'сегодня') {
        await handleDays(chatId, 1);
      } else if (text === '/3days' || text === '3 дня') {
        await handleDays(chatId, 3);
      } else {
        await sendMessage(chatId, 'Команды: /today, /3days', menu());
      }
    }
  } catch {}
  res.status(200).send('ok');
};
