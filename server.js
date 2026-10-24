// Wuxeek: бот + сервер для Mini App. Node 18+, без зависимостей.
// Запуск: BOT_TOKEN=123:ABC WEBAPP_URL=https://твой-домен CHANNEL=https://t.me/твой_канал node server.js
// Положи этот файл рядом с wuxeek.html. WEBAPP_URL должен быть https.
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { BOT_TOKEN, PORT = 3000, CHANNEL = 'https://t.me/wexuuke' } = process.env;
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL; // на Render подставляется сам

const bot = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

// Проверка подписи initData. Без неё любой сможет подделать user.id и баланс.
const ONLINE = new Map(); // кто недавно заходил (счётчик «онлайн»)
function checkInitData(initData) {
  const p = new URLSearchParams(initData), hash = p.get('hash');
  p.delete('hash');
  const data = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', key).update(data).digest('hex');
  if (!hash || calc.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null; // старше суток
  const u = JSON.parse(p.get('user')); ONLINE.set(u.id, Date.now()); return u;
}

// Демо-хранилище в памяти. Для продакшена замени на PostgreSQL/Redis.
const DB = new Map();
const account = u => (DB.has(u.id) || DB.set(u.id, { gram: 0, stars: 0 }), DB.get(u.id));

// ===== Пополнение через TON =====
// Доп. переменные: TON_ADDRESS (твой кошелёк для приёма), TONCENTER_KEY (ключ toncenter.com),
// TON_API (для теста: https://testnet.toncenter.com/api/v2), RATE (GRAM за 1 TON, по умолчанию 1),
// MIN_DEPOSIT / MAX_DEPOSIT (в TON).
const { TON_ADDRESS, TON_API = 'https://toncenter.com/api/v2', TONCENTER_KEY, RATE = '1', MIN_DEPOSIT = '0.5', MAX_DEPOSIT = '1000' } = process.env;
const { ADMIN_ID, MIN_WITHDRAW = '1' } = process.env; // ADMIN_ID — твой Telegram id: сюда приходят заявки на вывод
const deposits = new Map(), seen = new Set(); // ВАЖНО: в продакшене храни в БД, иначе после перезапуска оплаты потеряются

// Комментарий к переводу в виде BOC (одна ячейка: 32 нулевых бита + текст, до 123 байт)
const commentBoc = text => {
  const t = Buffer.from(text), L = 4 + t.length;
  return Buffer.concat([Buffer.from([0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, 2 + L, 0, 0, 2 * L]), Buffer.alloc(4), t]).toString('base64');
};
const readBody = req => new Promise(ok => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const json = (res, code, o, h = {}) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); for (const k in h) res.setHeader(k, h[k]); res.end(JSON.stringify(o)); };

// Каждые 10 секунд смотрим входящие переводы на TON_ADDRESS и ищем комментарий wx-<id>
async function scanTon() {
  if (!TON_ADDRESS) return;
  try {
    const r = await fetch(`${TON_API}/getTransactions?address=${TON_ADDRESS}&limit=50`,
      { headers: TONCENTER_KEY ? { 'X-API-Key': TONCENTER_KEY } : {} }).then(r => r.json());
    for (const tx of r.result || []) {
      const m = tx.in_msg, hash = tx.transaction_id.hash;
      if (!m || !m.source || seen.has(hash)) continue; // только входящие от кошельков
      const txt = m.message || (m.msg_data && m.msg_data.text ? Buffer.from(m.msg_data.text, 'base64').toString() : '');
      const mm = /^wx-([0-9a-f]{12})$/.exec(txt), d = mm && deposits.get(mm[1]);
      if (!d || d.status === 'done' || BigInt(m.value) < BigInt(d.nano)) continue;
      seen.add(hash); d.status = 'done';
      d.credited = Math.round(Number(m.value) / 1e9 * Number(RATE) * 100) / 100;
      account({ id: d.userId }).gram += d.credited;
    }
  } catch (e) { console.error('scanTon:', e.message); }
}
setInterval(scanTon, 10000);

// ===== Crash: общий раунд для всех игроков =====
// Фазы: bet (8 с приём ставок) → fly (множитель растёт) → crash (4 с) → снова bet. Точку взрыва знает только сервер.
const CR = { id: 1, phase: 'bet', end: Date.now() + 8000, t0: 0, cp: 1, bets: [], hist: [] };
function crashPay(b, x) { // начислить выигрыш по ставке b при иксе x
  b.x = Math.floor(x * 100) / 100;
  const key = b.cur === 's' ? 'stars' : 'gram', win = b.cur === 's' ? Math.floor(b.amount * b.x) : Math.round(b.amount * b.x * 100) / 100, a = account({ id: b.uid });
  a[key] = Math.round((a[key] + win) * 100) / 100;
}
setInterval(() => {
  const now = Date.now();
  if (CR.phase === 'fly') { // авто-вывод: срабатывает раньше, чем проверка взрыва
    const m = Math.exp(0.1 * (now - CR.t0) / 1000);
    for (const b of CR.bets) if (b.auto && b.x == null && m >= b.auto && b.auto < CR.cp) crashPay(b, b.auto);
  }
  if (CR.phase === 'bet' && now >= CR.end) {
    CR.phase = 'fly'; CR.t0 = now;
    CR.cp = Math.min(200, Math.max(1, 0.96 / (1 - crypto.randomInt(0, 1e9) / 1e9))); // запас казино 4%
  } else if (CR.phase === 'fly' && Math.exp(0.1 * (now - CR.t0) / 1000) >= CR.cp) {
    CR.phase = 'crash'; CR.end = now + 4000; // кто не забрал — проиграл, ставка уже списана
    CR.hist.unshift(Math.floor(CR.cp * 100) / 100); CR.hist.length = Math.min(CR.hist.length, 12);
  } else if (CR.phase === 'crash' && now >= CR.end) {
    CR.phase = 'bet'; CR.end = now + 8000; CR.bets = []; CR.id++;
  }
}, 100);

// ===== Цены NFT (в GRAM) =====
// Источники (позже перекрывает раньше):
//  1) prices.json — {"Plush Pepe": 1234.5}, можно править вручную или обновлять своим скриптом;
//  2) Getgems (официальный публичный API, нужен ключ): GETGEMS_API_KEY, GETGEMS_URL (шаблон запроса флора с {address},
//     сверь путь с документацией Getgems) и collections.json — {"Plush Pepe": "адрес коллекции"}.
let PRICES = {};
const readJson = f => { try { return JSON.parse(fs.readFileSync(__dirname + '/' + f)); } catch { return {}; } };
async function refreshPrices() {
  const next = readJson('prices.json'), { GETGEMS_API_KEY, GETGEMS_URL } = process.env;
  if (GETGEMS_API_KEY && GETGEMS_URL) {
    for (const [name, address] of Object.entries(readJson('collections.json'))) {
      try {
        const r = await fetch(GETGEMS_URL.replace('{address}', address), { headers: { Authorization: GETGEMS_API_KEY } }).then(r => r.json());
        const f = Number((r.response || r.result || r).floorPrice); // нано-TON или TON — приводим к TON
        if (f > 0) next[name] = f > 1e6 ? f / 1e9 : f;
      } catch (e) { console.error('price', name, e.message); }
      await new Promise(r => setTimeout(r, 300)); // не превышаем лимиты API
    }
  }
  PRICES = next;
}
refreshPrices(); setInterval(refreshPrices, 600000);

// Цена предмета = флор коллекции × множитель редкости. Предмет в инвентаре — строка вида «Plush Pepe #777 mono».
// Множители: номер ≤10 ×5, ≤100 ×2.5, одинаковые цифры (777) ×3, круглый (1000) ×2, палиндром ×1.4; «mono» (монохром) ×2; максимум ×10.
// Админ зачисляет так: /addnft ID Plush Pepe #777 mono
function mult(e) {
  const m = /#(\d+)/.exec(e), x = m ? m[1] : '', n = +x; let k = 1;
  if (n) {
    if (n <= 10) k = 5; else if (n <= 100) k = 2.5;
    else if (x.length >= 3 && new Set(x).size === 1) k = 3;
    else if (/^[1-9]0{2,}$/.test(x)) k = 2;
    else if (x.length >= 3 && x === [...x].reverse().join('')) k = 1.4;
  }
  if (/\bmono\b/i.test(e)) k *= 2;
  return Math.min(k, 10);
}
const itemPrice = e => (PRICES[String(e).split(' #')[0]] || 0) * mult(e);

// ===== Telegram Stars =====
// Пополнение: счёт XTR → pre_checkout_query → successful_payment (см. onUpdate).
// Вывод: Bot API не умеет «переводить» Stars, поэтому — подарком (sendGift) или возвратом прошлого платежа (refundStarPayment).
const MAX_STARS = Number(process.env.MAX_STARS || 10000);
let giftCache = { t: 0, list: [] };
async function starGifts() {
  if (Date.now() - giftCache.t > 600000) {
    const r = await bot('getAvailableGifts', {});
    giftCache = { t: Date.now(), list: ((r.result && r.result.gifts) || []).filter(g => g.remaining_count !== 0).map(g => ({ id: g.id, stars: g.star_count, emoji: g.sticker && g.sticker.emoji })) };
  }
  return giftCache.list;
}

// ===== Лента побед, бесплатный кейс, PvP-колесо =====
const FEED = [];
const CASE = [[1, 70], [2, 12], [3, 6], [4, 4], [5, 3], [7, 2], [10, 1.8], [15, 1.2]]; // [звёзды, вес %]: чаще всего 1
const ROOMS = new Map(); // id → комната колеса
const r2s = n => Math.round(n * 100) / 100;
const roomNew = (type, pub, id) => { const r = { id: id || crypto.randomBytes(3).toString('hex'), type, pub, gid: 1, phase: 'wait', end: 0, players: [], winner: -1, off: 0, pay: 0, created: Date.now() }; ROOMS.set(r.id, r); return r; };
for (const t of ['g', 's', 'n']) roomNew(t, true, 'pub-' + t); // публичные комнаты «случайные игроки»
function pvpPay(r) { // победитель забирает банк (GRAM/Stars — минус 5%, NFT — всё)
  const w = r.players[r.winner], acc = account({ id: w.uid });
  if (r.type === 'n') { inv(acc).push(...r.players.flatMap(p => p.items)); r.pay = r.players.reduce((a, p) => a + p.items.length, 0); return; }
  const pot = r.players.reduce((a, p) => a + p.stake, 0), key = r.type === 's' ? 'stars' : 'gram';
  r.pay = r.type === 's' ? Math.floor(pot * 0.95) : r2s(pot * 0.95); acc[key] = r2s(acc[key] + r.pay);
}
function pvpRefund(r) {
  for (const p of r.players) { const a = account({ id: p.uid }); if (r.type === 'n') inv(a).push(...p.items); else { const k = r.type === 's' ? 'stars' : 'gram'; a[k] = r2s(a[k] + p.stake); } }
}
setInterval(() => { // wait → count (20 с) → spin (6 с, победитель выбран криптослучайно) → done (6 с) → новая игра
  const now = Date.now();
  for (const r of ROOMS.values()) {
    if (r.phase === 'wait' && r.players.length >= 2) { r.phase = 'count'; r.end = now + 20000; }
    else if (r.phase === 'count' && now >= r.end) {
      const tot = r.players.reduce((a, p) => a + p.val, 0); let x = crypto.randomInt(0, 1e9) / 1e9 * tot, i = 0;
      for (; i < r.players.length - 1; i++) { if ((x -= r.players[i].val) < 0) break; }
      r.winner = i; r.off = crypto.randomInt(8, 92) / 100; r.phase = 'spin'; r.end = now + 6000;
    } else if (r.phase === 'spin' && now >= r.end) { pvpPay(r); r.phase = 'done'; r.end = now + 6000; }
    else if (r.phase === 'done' && now >= r.end) {
      if (r.pub) Object.assign(r, { phase: 'wait', end: 0, players: [], winner: -1, off: 0, pay: 0, gid: r.gid + 1 }); else ROOMS.delete(r.id);
    } else if (!r.pub && r.phase === 'wait' && now - r.created > 600000) { pvpRefund(r); ROOMS.delete(r.id); } // друг не пришёл — возврат
  }
}, 200);

// ===== Розыгрыши (реальные, хранятся на сервере) =====
const GV = []; // { id, owner, nfts:[название], end, players:[userId], status:'active'|'done', winnerName }
const inv = a => a.nfts || (a.nfts = []);
setInterval(() => { // завершаем розыгрыши по таймеру, победитель выбирается криптослучайно
  for (const g of GV) if (g.status === 'active' && Date.now() >= g.end) {
    g.status = 'done';
    const w = g.players.length ? g.players[crypto.randomInt(g.players.length)] : g.owner; // без участников NFT возвращается владельцу
    inv(account({ id: w })).push(...g.nfts);
    g.winnerName = g.players.length ? (DB.get(w).name || '#' + w) : null;
  }
}, 5000);

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/tg-webhook/' + SECRET && req.headers['x-telegram-bot-api-secret-token'] === SECRET) {
    onUpdate(await readBody(req)); return res.end('ok');
  }
  if (req.method === 'POST' && req.url.startsWith('/api/giveaways')) {
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const b = await readBody(req), acc = account(user);
    acc.name = user.username ? '@' + user.username : user.first_name;
    if (req.url === '/api/giveaways') {
      const pub = g => ({ id: g.id, nfts: g.nfts, end: g.end, players: g.players.length, joined: g.players.includes(user.id), own: g.owner === user.id, winner: g.winnerName });
      return json(res, 200, { active: GV.filter(g => g.status === 'active').map(pub), history: GV.filter(g => g.status === 'done').slice(-30).reverse().map(pub) });
    }
    if (req.url === '/api/giveaways/create') {
      const mins = Number(b.minutes), want = Array.isArray(b.nfts) ? b.nfts.slice(0, 30).map(String) : [];
      if (!(mins >= 15 && mins <= 1440) || !want.length) return json(res, 400, { error: 'Неверные параметры' });
      const have = [...inv(acc)];
      for (const n of want) { const i = have.indexOf(n); if (i < 0) return json(res, 400, { error: 'Этого NFT нет в инвентаре' }); have.splice(i, 1); }
      acc.nfts = have;
      GV.push({ id: crypto.randomBytes(4).toString('hex').toUpperCase(), owner: user.id, nfts: want, end: Date.now() + mins * 60000, players: [], status: 'active' });
      return json(res, 200, { ok: true, nfts: acc.nfts });
    }
    if (req.url === '/api/giveaways/join') {
      const g = GV.find(x => x.id === b.id && x.status === 'active');
      if (!g || g.owner === user.id || g.players.includes(user.id) || Date.now() >= g.end) return json(res, 400, { error: 'Нельзя участвовать в этом розыгрыше' });
      g.players.push(user.id); return json(res, 200, { ok: true });
    }
  }
  if (req.url === '/tonconnect-manifest.json')
    return json(res, 200, { url: WEBAPP_URL, name: 'Wuxeek', iconUrl: WEBAPP_URL + '/icon.png' }, { 'Access-Control-Allow-Origin': '*' });
  if (req.url === '/icon.png' && fs.existsSync(__dirname + '/icon.png')) {
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(fs.readFileSync(__dirname + '/icon.png'));
  }
  if (req.method === 'POST' && req.url === '/api/feed') // живые победы и онлайн
    return json(res, 200, { online: [...ONLINE.values()].filter(t => Date.now() - t < 90000).length, feed: FEED });
  if (req.method === 'POST' && req.url === '/api/case/open') { // бесплатный кейс раз в 24 часа, 1–15 Stars
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const acc = account(user), left = (acc.caseAt || 0) + 86400000 - Date.now();
    if (left > 0) return json(res, 400, { error: 'Кейс будет доступен позже', left });
    // кейс только для подписчиков канала: бот должен быть админом канала, иначе Telegram не отдаёт список участников
    const ch = process.env.CASE_CHANNEL || '@wexuuke', mem = await bot('getChatMember', { chat_id: ch, user_id: user.id });
    if (!(mem.ok && ['member', 'administrator', 'creator'].includes(mem.result.status))) {
      if (!mem.ok) console.error('getChatMember:', mem.description);
      return json(res, 403, { sub: false, error: mem.ok ? `Сначала подпишитесь на канал ${ch}` : `Не удалось проверить подписку на ${ch}. Попробуйте позже` });
    }
    let x = crypto.randomInt(0, 1e6) / 1e4, win = 1;
    for (const [v, w] of CASE) { if ((x -= w) < 0) { win = v; break; } }
    acc.caseAt = Date.now(); acc.stars += win;
    return json(res, 200, { win, next: acc.caseAt + 86400000, balance: { gram: acc.gram, stars: acc.stars } });
  }
  if (req.method === 'POST' && req.url === '/api/upgrade-chance') { // Апгрейдер: ставка + шанс, множитель = 0.95 / шанс
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const acc = account(user), b = await readBody(req), cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram';
    const bet = cur === 's' ? Math.floor(Number(b.bet)) : r2s(Number(b.bet)), chance = Math.floor(Number(b.chance));
    if (!(bet >= (cur === 's' ? 1 : 0.1)) || bet > acc[key]) return json(res, 400, { error: 'Неверная ставка или не хватает баланса' });
    if (!(chance >= 2 && chance <= 70)) return json(res, 400, { error: 'Шанс от 2% до 70%' });
    acc[key] = r2s(acc[key] - bet);
    const mult = 0.95 / (chance / 100), win = crypto.randomInt(0, 1e6) / 1e4 < chance;
    const pay = win ? (cur === 's' ? Math.floor(bet * mult) : r2s(bet * mult)) : 0;
    if (win) { acc[key] = r2s(acc[key] + pay); FEED.unshift({ pay, c: cur, x: r2s(mult), ch: chance }); FEED.length = Math.min(FEED.length, 12); }
    return json(res, 200, { win, pay, mult: r2s(mult), balance: { gram: acc.gram, stars: acc.stars } });
  }
  if (req.method === 'POST' && req.url.startsWith('/api/pvp/')) {
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const acc = account(user), b = await readBody(req), UPR = Number(process.env.GRAM_STARS || 91);
    acc.name = user.username ? '@' + user.username : user.first_name;
    const bal = () => ({ gram: acc.gram, stars: acc.stars, nfts: acc.nfts || [] });
    if (req.url === '/api/pvp/create') return json(res, 200, { id: roomNew(['g', 's', 'n'].includes(b.type) ? b.type : 's', false).id });
    const r = ROOMS.get(String(b.id));
    if (!r) return json(res, 404, { error: 'Игра не найдена' });
    if (req.url === '/api/pvp/state')
      return json(res, 200, { now: Date.now(), id: r.id, gid: r.gid, type: r.type, phase: r.phase, end: r.end, winner: r.winner, off: r.off, pay: r.pay,
        players: r.players.map(p => ({ n: p.name, stake: p.stake, items: p.items, val: p.val, me: p.uid === user.id })) });
    if (req.url === '/api/pvp/leave') { // выйти можно, пока игра не набрала двух игроков
      const i = r.players.findIndex(x => x.uid === user.id);
      if (i < 0 || r.phase !== 'wait') return json(res, 400, { error: 'Выйти сейчас нельзя' });
      pvpRefund({ type: r.type, players: r.players.splice(i, 1) });
      return json(res, 200, { balance: bal() });
    }
    if (req.url === '/api/pvp/join') {
      const now = Date.now();
      if (!(r.phase === 'wait' || (r.phase === 'count' && r.end - now > 3000))) return json(res, 400, { error: 'Ставки в этой игре закрыты' });
      let p = r.players.find(x => x.uid === user.id);
      if (!p && r.players.length >= 8) return json(res, 400, { error: 'В игре уже 8 игроков' });
      let stake = 0, val = 0; const items = [];
      if (r.type === 'n') {
        const want = Array.isArray(b.nfts) ? b.nfts.slice(0, 5).map(String) : [], have = [...inv(acc)];
        if (!want.length) return json(res, 400, { error: 'Выберите NFT' });
        for (const n of want) {
          const i = have.indexOf(n);
          if (i < 0) return json(res, 400, { error: 'Этого NFT нет в инвентаре' });
          if (!(itemPrice(n) > 0)) return json(res, 400, { error: `Для «${n}» не задана цена` });
          have.splice(i, 1); items.push(n); val += itemPrice(n) * UPR;
        }
        acc.nfts = have;
      } else {
        const key = r.type === 's' ? 'stars' : 'gram';
        stake = r.type === 's' ? Math.floor(Number(b.amount)) : r2s(Number(b.amount));
        if (!(stake >= (r.type === 's' ? 1 : 0.1)) || stake > acc[key]) return json(res, 400, { error: 'Неверная ставка или не хватает баланса' });
        acc[key] = r2s(acc[key] - stake); val = stake;
      }
      if (!p) { p = { uid: user.id, name: acc.name, stake: 0, items: [], val: 0 }; r.players.push(p); }
      p.stake += stake; p.items.push(...items); p.val += val;
      return json(res, 200, { balance: bal() });
    }
  }
  if (req.method === 'POST' && req.url === '/api/prices')
    return json(res, 200, { prices: PRICES, rate: Number(process.env.GRAM_STARS || 91) });
  if (req.method === 'POST' && req.url === '/api/upgrade-nft') { // Апгрейдер: ставка NFT, цена — флор в GRAM × курс в Stars
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const acc = account(user), b = await readBody(req), UPR = Number(process.env.GRAM_STARS || 91);
    const want = Array.isArray(b.nfts) ? b.nfts.slice(0, 10).map(String) : [], target = Math.floor(Number(b.target)), have = [...inv(acc)];
    let betV = 0;
    for (const n of want) {
      const i = have.indexOf(n);
      if (i < 0) return json(res, 400, { error: 'Этого NFT нет в инвентаре' });
      if (!(itemPrice(n) > 0)) return json(res, 400, { error: `Для «${n}» не задана цена` });
      have.splice(i, 1); betV += itemPrice(n) * UPR;
    }
    const chance = betV / target * 95;
    if (!want.length || !(target > betV) || chance < 0.5 || chance > 90) return json(res, 400, { error: 'Шанс должен быть от 0.5% до 90%' });
    acc.nfts = have; // NFT списываются сразу
    const win = crypto.randomInt(0, 1e6) / 1e4 < chance;
    if (win) acc.stars += target;
    return json(res, 200, { win, chance, balance: { gram: acc.gram, stars: acc.stars, nfts: acc.nfts } });
  }
  if (req.method === 'POST' && req.url === '/api/upgrade') { // Апгрейдер: результат считает сервер
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const acc = account(user), b = await readBody(req), cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram';
    const UPR = Number(process.env.GRAM_STARS || 91), r2 = n => Math.round(n * 100) / 100; // курс: сколько Stars в 1 GRAM
    const bet = cur === 's' ? Math.floor(Number(b.bet)) : r2(Number(b.bet)), target = Math.floor(Number(b.target));
    const betV = cur === 's' ? bet : bet * UPR, chance = betV / target * 95; // запас казино 5%
    if (!(bet >= 1) || bet > acc[key]) return json(res, 400, { error: 'Неверная ставка или не хватает баланса' });
    if (!(target > betV) || chance < 0.5 || chance > 90) return json(res, 400, { error: 'Шанс должен быть от 0.5% до 90%' });
    acc[key] = r2(acc[key] - bet);
    const win = crypto.randomInt(0, 1e6) / 1e4 < chance;
    if (win) acc.stars += target;
    return json(res, 200, { win, chance, balance: { gram: acc.gram, stars: acc.stars } });
  }
  if (req.method === 'POST' && req.url.startsWith('/api/crash/')) {
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const acc = account(user), b = await readBody(req), me = CR.bets.find(x => x.uid === user.id);
    acc.name = user.username ? '@' + user.username : user.first_name;
    const pub = x => ({ n: x.name, a: x.amount, c: x.cur, x: x.x, me: x.uid === user.id, auto: x.uid === user.id ? x.auto : 0 });
    const bal = () => ({ gram: acc.gram, stars: acc.stars }), r2 = n => Math.round(n * 100) / 100;
    if (req.url === '/api/crash/state')
      return json(res, 200, { now: Date.now(), id: CR.id, phase: CR.phase, end: CR.end, t0: CR.t0, cp: CR.phase === 'crash' ? CR.cp : null, hist: CR.hist, bets: CR.bets.map(pub), mine: me ? pub(me) : null });
    if (req.url === '/api/crash/bet') {
      const cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram';
      const amount = cur === 's' ? Math.floor(Number(b.amount)) : r2(Number(b.amount));
      if (CR.phase !== 'bet') return json(res, 400, { error: 'Ставки сейчас закрыты' });
      if (me) return json(res, 400, { error: 'Вы уже поставили в этом раунде' });
      if (!(amount >= 1) || amount > acc[key]) return json(res, 400, { error: 'Неверная ставка или не хватает баланса' });
      acc[key] = r2(acc[key] - amount); // списываем сразу
      CR.bets.push({ uid: user.id, name: acc.name, amount, cur, x: null, auto: Number(b.auto) >= 1.01 ? Math.floor(Number(b.auto) * 100) / 100 : 0 });
      return json(res, 200, { balance: bal() });
    }
    if (req.url === '/api/crash/cashout') {
      if (!me || me.x != null || CR.phase !== 'fly') return json(res, 400, { error: 'Нечего забирать' });
      const m = Math.exp(0.1 * (Date.now() - CR.t0) / 1000);
      if (m >= CR.cp) return json(res, 400, { error: 'Ракета уже взорвалась' });
      me.x = Math.floor(m * 100) / 100;
      const key = me.cur === 's' ? 'stars' : 'gram', win = me.cur === 's' ? Math.floor(me.amount * me.x) : r2(me.amount * me.x);
      acc[key] = r2(acc[key] + win);
      return json(res, 200, { win, x: me.x, balance: bal() });
    }
  }
  if (req.method === 'POST' && req.url.startsWith('/api/stars/')) {
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const b = await readBody(req), acc = account(user), pays = acc.payments || (acc.payments = []);
    if (req.url === '/api/stars/create') {
      const amount = Math.floor(Number(b.amount));
      if (!(amount >= 1 && amount <= MAX_STARS)) return json(res, 400, { error: `Сумма от 1 до ${MAX_STARS} Stars` });
      const r = await bot('createInvoiceLink', { title: 'Пополнение Wuxeek', description: `${amount} Stars на баланс`, payload: 'st-' + crypto.randomBytes(6).toString('hex'), currency: 'XTR', prices: [{ label: 'Stars', amount }] });
      return r.ok ? json(res, 200, { link: r.result }) : json(res, 500, { error: 'Не удалось создать счёт' });
    }
    if (req.url === '/api/stars/options') {
      const list = await starGifts();
      return json(res, 200, { gifts: list.filter(g => g.stars <= acc.stars), refunds: pays.filter(p => !p.refunded && p.amount <= acc.stars).map(p => ({ charge: p.charge, amount: p.amount })) });
    }
    if (req.url === '/api/stars/gift') {
      const g = (await starGifts()).find(x => x.id === b.gift);
      if (!g || g.stars > acc.stars) return json(res, 400, { error: 'Недостаточно Stars или подарок недоступен' });
      acc.stars -= g.stars; // списываем до отправки, чтобы нельзя было потратить дважды
      const r = await bot('sendGift', { user_id: user.id, gift_id: g.id, text: 'Выигрыш в Wuxeek' });
      if (!r.ok) { acc.stars += g.stars; return json(res, 502, { error: 'Telegram не принял подарок: ' + (r.description || '') }); }
      return json(res, 200, { stars: acc.stars, price: g.stars });
    }
    if (req.url === '/api/stars/refund') {
      const p = pays.find(x => x.charge === b.charge && !x.refunded);
      if (!p || p.amount > acc.stars) return json(res, 400, { error: 'Платёж недоступен для возврата' });
      acc.stars -= p.amount; p.refunded = true;
      const r = await bot('refundStarPayment', { user_id: user.id, telegram_payment_charge_id: p.charge });
      if (!r.ok) { acc.stars += p.amount; p.refunded = false; return json(res, 502, { error: 'Возврат не прошёл: ' + (r.description || '') }); }
      return json(res, 200, { stars: acc.stars, amount: p.amount });
    }
  }
  if (req.method === 'POST' && req.url === '/api/withdraw/create') {
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const b = await readBody(req), amount = Number(b.amount), acc = account(user);
    if (!/^[\w:-]{20,70}$/.test(b.address || '')) return json(res, 400, { error: 'Неверный адрес кошелька' });
    if (!(amount >= Number(MIN_WITHDRAW))) return json(res, 400, { error: `Минимум ${MIN_WITHDRAW} GRAM` });
    if (amount > acc.gram) return json(res, 400, { error: 'Недостаточно GRAM' });
    acc.gram = Math.round((acc.gram - amount) * 100) / 100; // списываем сразу, чтобы нельзя было потратить дважды
    const id = crypto.randomBytes(4).toString('hex');
    if (ADMIN_ID) bot('sendMessage', { chat_id: ADMIN_ID, text: `Вывод #${id}\nПользователь: ${user.id} @${user.username || '-'}\nСумма: ${amount} GRAM ≈ ${amount / Number(RATE)} TON\nАдрес: ${b.address}` });
    return json(res, 200, { id, balance: acc });
  }
  if (req.method === 'POST' && req.url.startsWith('/api/deposit/')) {
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { error: 'bad initData' });
    const b = await readBody(req);
    if (req.url === '/api/deposit/create') {
      const amount = Number(b.amount);
      if (!TON_ADDRESS) return json(res, 500, { error: 'Приём платежей не настроен' });
      if (!(amount >= Number(MIN_DEPOSIT) && amount <= Number(MAX_DEPOSIT)))
        return json(res, 400, { error: `Сумма от ${MIN_DEPOSIT} до ${MAX_DEPOSIT} TON` });
      const id = crypto.randomBytes(6).toString('hex'), nano = String(Math.round(amount * 1e9));
      deposits.set(id, { id, userId: user.id, nano, status: 'pending' });
      return json(res, 200, { id, address: TON_ADDRESS, nano, payload: commentBoc('wx-' + id) });
    }
    if (req.url === '/api/deposit/status') {
      const d = deposits.get(b.id);
      if (!d || d.userId !== user.id) return json(res, 404, { error: 'not found' });
      return json(res, 200, { status: d.status, credited: d.credited, balance: account(user) });
    }
  }
  if (req.method === 'POST' && req.url === '/api/me') {
    res.setHeader('Content-Type', 'application/json');
    const user = checkInitData(req.headers['x-init-data'] || '');
    if (!user) { res.statusCode = 401; return res.end('{"error":"bad initData"}'); }
    return res.end(JSON.stringify({ user, balance: account(user) }));
  }
  // Сюда добавляй: /api/crash/start, /api/mines/open, /api/deposit и т.д.
  // Результат каждой игры должен считаться ЗДЕСЬ, а не в браузере.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(__dirname + '/wuxeek.html'));
}).listen(PORT, () => console.log('Сервер на порту', PORT));

// ===== Бот =====
const SECRET = crypto.createHash('sha256').update(String(BOT_TOKEN)).digest('hex').slice(0, 32);
function onUpdate(u) {
  if (u.pre_checkout_query) { // подтверждаем оплату Stars (ответить нужно за 10 секунд)
    const q = u.pre_checkout_query, ok = q.currency === 'XTR' && String(q.invoice_payload).startsWith('st-');
    return bot('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: 'Неверный платёж' });
  }
  const m = u.message;
  if (m && m.successful_payment) { // деньги пришли: зачисляем Stars один раз (защита от повторов по charge id)
    const sp = m.successful_payment, acc = account({ id: m.from.id }), pays = acc.payments || (acc.payments = []);
    if (sp.currency === 'XTR' && String(sp.invoice_payload).startsWith('st-') && !pays.some(p => p.charge === sp.telegram_payment_charge_id)) {
      acc.stars += sp.total_amount;
      pays.push({ charge: sp.telegram_payment_charge_id, amount: sp.total_amount, refunded: false });
    }
    return;
  }
  if (!m || !m.text) return;
  if (m.text.startsWith('/start')) {
    const arg = m.text.split(' ')[1] || '', gurl = /^pvp_[0-9a-f]{6}$/.test(arg) ? WEBAPP_URL + '/?g=' + arg.slice(4) : WEBAPP_URL; // ссылка-приглашение в PvP
    return bot('sendMessage', {
      chat_id: m.chat.id,
      text: 'Добро пожаловать в Wuxeek!\n\nПо вопросам обращайтесь в поддержку: @Wuxeek_support_bot\n\nНажми кнопку ниже, чтобы начать.',
      reply_markup: { inline_keyboard: [
        [{ text: '🎁 Открыть приложение', web_app: { url: gurl } }],
        [{ text: 'Канал', url: CHANNEL }],
      ] },
    });
  }
  // Админ: /addnft <user_id> <название коллекции> — зачислить игроку подарок, который он тебе отправил
  if (String(m.from.id) === String(ADMIN_ID) && m.text.startsWith('/addnft ')) {
    const [, id, ...name] = m.text.split(' ');
    inv(account({ id: Number(id) })).push(name.join(' '));
    bot('sendMessage', { chat_id: m.chat.id, text: `Зачислено: ${name.join(' ')} → ${id}` });
  }
}
bot('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: WEBAPP_URL } } });
if (process.env.WEBHOOK) { // для бесплатных хостов, которые засыпают: Telegram сам разбудит сервер
  bot('setWebhook', { url: `${WEBAPP_URL}/tg-webhook/${SECRET}`, secret_token: SECRET });
} else {
  bot('deleteWebhook', {});
  (async function poll(offset = 0) {
    try {
      const r = await bot('getUpdates', { offset, timeout: 30 });
      for (const u of r.result || []) { offset = u.update_id + 1; onUpdate(u); }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
    poll(offset);
  })();
}

// ===== Сохранение на диск =====
// На бесплатных хостах диск стирается при перезапуске/деплое: для реальных денег подключи БД (Neon, Supabase, Turso).
const FILE = __dirname + '/data.json';
try {
  const d = JSON.parse(fs.readFileSync(FILE));
  d.db.forEach(([k, v]) => DB.set(k, v)); d.dep.forEach(([k, v]) => deposits.set(k, v)); d.seen.forEach(x => seen.add(x)); GV.push(...d.gv);
} catch {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ db: [...DB], dep: [...deposits], seen: [...seen], gv: GV })); } catch (e) { console.error('save:', e.message); } };
setInterval(save, 5000);
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => { save(); process.exit(); }));
