// Не парсим тело автоматически — читаем сами
module.exports.config = { api: { bodyParser: false } };

/* ===== НАСТРОЙКИ ===== */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'ТОКЕН_ЕСЛИ_НЕ_ИСПОЛЬЗУЕШЬ_ENV';
const TZ = 'Europe/Moscow';

// ПУБЛИЧНЫЕ ссылки на CSV (должны открываться без авторизации)
// Лучше латиница в имени файла или url-encoding
const MONTH_URLS = {
  10: 'https://raw.githubusercontent.com/dani525kol-cloud/KHL-HL/refs/heads/main/%D0%9E%D0%BA%D1%82%D1%8F%D0%B1%D1%80%D1%8C.csv',
  // 11: 'https://raw.githubusercontent.com/.../November.csv',
  // 12: 'https://...'
};

// Индексы колонок (0-based) в CSV
const COL = {
  MATCH: 0,  // "МАТЧ"
  TIME:  1,  // "ВРЕМЯ"
  EDITOR:2   // "МОНТАЖЕР"
};

/* ===== ТГ API ===== */
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const menu = () => ({
  inline_keyboard: [[
    { text: 'Сегодня', callback_data: 'today' },
    { text: '3 дня',   callback_data: '3days' },
  ]]
});

/* ===== ДАТЫ ===== */
function dfmt(d) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day:'2-digit', month:'2-digit', year:'numeric' })
    .format(d).replace(/\//g,'.'); // dd.MM.yyyy
}
function todayPlus(days=0) {
  const d = new Date();
  d.setHours(12,0,0,0);
  d.setDate(d.getDate()+days);
  return d;
}

/* ===== CSV ===== */
async function fetchCsv(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    return text;
  } finally { clearTimeout(t); }
}

// простой авто-выбор разделителя: берём тот, которого больше в заголовке
function detectDelim(firstLine) {
  const commas = (firstLine.match(/,/g) || []).length;
  const semis  = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function csvParseSmart(text) {
  const lines = text.replace(/\r/g,'').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const delim = detectDelim(lines[0]);

  const rows = [];
  for (const line of lines) {
    const out = [];
    let cur = '', q = false;
    for (let i=0;i<line.length;i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i+1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === delim && !q) {
        out.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    rows.push(out);
  }
  return rows;
}

/* ===== ФИЛЬТР: ПРОПУСКАЕМ ЗАГОЛОВКИ ДАТ ===== */
function isDateHeaderRow(r) {
  const t  = (r[COL.TIME]   || '').trim();
  const ed = (r[COL.EDITOR] || '').trim();
  const m  = (r[COL.MATCH]  || '').toString().trim().toLowerCase();
  const looksLikeDate = /^(\d{1,2})\s+[а-яё]+/.test(m); // "13 октября ..."
  return looksLikeDate && !t && !ed;
}

/* ===== Разбор даты из первого столбца ===== */
function extractDateDDMMYYYY(s) {
  s = (s || '').toString().trim();

  // 1) dd.MM.yyyy
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) {
    const dd = m1[1].padStart(2,'0');
    const mm = m1[2].padStart(2,'0');
    const yy = m1[3];
    return `${dd}.${mm}.${yy}`;
  }

  // 2) «1 октября ...»
  const months = {
    'января':'01','февраля':'02','марта':'03','апреля':'04','мая':'05','июня':'06',
    'июля':'07','августа':'08','сентября':'09','октября':'10','ноября':'11','декабря':'12'
  };
  const m2 = s.toLowerCase().match(/^(\d{1,2})\s+([а-яё]+)/i);
  if (m2) {
    const dd = m2[1].padStart(2,'0');
    const mon = months[m2[2]];
    if (mon) {
      const yyyy = new Date().getFullYear();
      return `${dd}.${mon}.${yyyy}`;
    }
  }
  return null;
}

/* ===== ГРУППИРОВКА ПО ДАТАМ ===== */
function groupByDate(rows) {
  const map = new Map();
  let currentDate = null; // дата из последней шапки

  for (const r of rows) {
    // если это шапка даты — запоминаем и идём дальше
    if (isDateHeaderRow(r)) {
      currentDate = extractDateDDMMYYYY(r[COL.MATCH]) || currentDate;
      continue;
    }

    // пробуем достать дату прямо из ячейки (на случай, если она там есть)
    let ds = extractDateDDMMYYYY(r[COL.MATCH]);

    // если даты в строке нет — используем дату из последней шапки
    if (!ds) ds = currentDate;
    if (!ds) continue; // всё ещё нет даты — пропускаем

    if (!map.has(ds)) map.set(ds, []);
    map.get(ds).push(r);
  }
  return map;
}

/* ===== ФОРМАТ ОТВЕТА ===== */
function formatLine(r) {
  const time   = (r[COL.TIME]   || '').trim();
  const edRaw  = (r[COL.EDITOR] || '').trim();
  let   match  = (r[COL.MATCH]  || '').toString().trim();

  // если в поле "матч" почему-то лежит снова «13 октября ...», не показываем
  if (/^(\d{1,2})\s+[а-яё]+/i.test(match)) match = '';

  const editor = /колышев/i.test(edRaw) ? '✅Колышев✅' : edRaw;
  return `${time ? time+' ' : ''}${editor ? editor+' ' : ''}${match}`.trim();
}

function renderDayCaption(dateStr, isToday=false) {
  return isToday ? `График сегодня:` : `График ${dateStr}:`;
}

function renderDayBlock(dateStr, rows, isToday=false) {
  if (!rows || !rows.length) return `${renderDayCaption(dateStr, isToday)}\n—`;
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

/* ===== ЛОГИКА ОТВЕТОВ ===== */
function getCsvUrlForDate(d) {
  const month = Number(new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, month:'numeric' }).format(d));
  return MONTH_URLS[month] || null;
}

async function handleDays(chatId, days) {
  const targets = Array.from({length:days}, (_,i)=> todayPlus(i));

  // какие месяцы нужны
  const urls = [...new Set(targets.map(getCsvUrlForDate).filter(Boolean))];

  // грузим помесячно
  const dataByUrl = new Map();
  for (const url of urls) {
    try {
      const text = await fetchCsv(url);
      const rows = csvParseSmart(text).slice(1); // отбрасываем заголовок
      dataByUrl.set(url, rows);
    } catch (e) {
      dataByUrl.set(url, []); // не падаем
    }
  }

  // делаем карту дата->строки
  const blocks = [];
  for (let i=0;i<targets.length;i++) {
    const d  = targets[i];
    const ds = dfmt(d);
    const url = getCsvUrlForDate(d);
    const rows = dataByUrl.get(url) || [];
    const grouped = groupByDate(rows);
    const hit = grouped.get(ds) || [];
    blocks.push(renderDayBlock(ds, hit, i===0));
  }

  await sendMessage(chatId, blocks.join('\n\n'), menu());
}

/* ===== ВЕРСЕЛ-ХЕНДЛЕР ===== */
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
        if (data === 'today')   await handleDays(chatId, 1);
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
  } catch (_) {}
  res.status(200).send('ok');
};
