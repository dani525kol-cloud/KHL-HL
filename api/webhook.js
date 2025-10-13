// Не парсим тело автоматически — читаем сами
module.exports.config = { api: { bodyParser: false } };

/* ===== НАСТРОЙКИ ===== */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'ТОКЕН_ТУТ_ЕСЛИ_НЕ_ИСПОЛЬЗУЕШЬ_ENV';
const TZ = 'Europe/Moscow';

// Поставь РЕАЛЬНЫЕ публичные CSV-ссылки (должны открываться в инкогнито)
const MONTH_URLS = {
  10: 'https://raw.githubusercontent.com/dani525kol-cloud/KHL-HL/refs/heads/main/Октябрь.csv',
  11: 'https://<твой-публичный-url-на-CSV-ноября>',
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
function csvParse(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const out = []; let cur=""; let q=false;
    for (let i=0; i<line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i+1] === '"'){cur+='"'; i++;} else q=!q; }
      else if (ch === ',' && !q) { out.push(cur); cur=""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  });
}

/* ===== выбор URL по месяцу ===== */
function getCsvUrlForDate(d) {
  const m = parseInt(new Intl.DateTimeFormat('ru-RU',{timeZone:TZ,month:'numeric'}).format(d),10);
  return MONTH_URLS[m] || null;
}

/* ===== дата из строки МАТЧ ===== */
function extractDateDDMMYYYY(s) {
  s = (s||'').trim();
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return `${m1[1].padStart(2,'0')}.${m1[2].padStart(2,'0')}.${m1[3]}`;

  const months = {'января':'01','февраля':'02','марта':'03','апреля':'04','мая':'05','июня':'06',
                  'июля':'07','августа':'08','сентября':'09','
