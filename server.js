const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { BOT_TOKEN, PORT = 3000, CHANNEL = 'https://t.me/wuxeek', TON_ADDRESS } = process.env;
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL;

const bot = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

function checkInitData(initData) {
  const p = new URLSearchParams(initData), hash = p.get('hash');
  p.delete('hash');
  const data = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', key).update(data).digest('hex');
  if (!hash || calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const u = JSON.parse(p.get('user')); return u;
}

const DB = new Map();
const account = u => (DB.has(u.id) || DB.set(u.id, { gram: 0, stars: 0, nfts: [] }), DB.get(u.id));
const r2s = n => Math.round(n * 100) / 100;
let PRICES = {};
try { PRICES = JSON.parse(fs.readFileSync(__dirname + '/prices.json')); } catch(e) {}
const mult = e => { const m = /#(\d+)/.exec(e), x = m ? m[1] : '', n = +x; let k = 1; if (n) { if (n <= 10) k = 5; else if (n <= 100) k = 2.5; else if (x.length >= 3 && new Set(x).size === 1) k = 3; else if (/^[1-9]0{2,}$/.test(x)) k = 2; else if (x.length >= 3 && x === [...x].reverse().join('')) k = 1.4; } if (/\bmono\b/i.test(e)) k *= 2; return Math.min(k, 10); };
const itemPrice = e => (PRICES[String(e).split(' #')[0]] || 0) * mult(e);

// --- CRASH ---
const CR = { id: 1, phase: 'bet', end: Date.now() + 8000, t0: 0, cp: 1, bets: [], hist: [] };
setInterval(() => {
  const now = Date.now();
  if (CR.phase === 'fly') {
    const m = Math.exp(0.1 * (now - CR.t0) / 1000);
    for (const b of CR.bets) if (b.auto && b.x == null && m >= b.auto && b.auto < CR.cp) {
       b.x = b.auto; const win = b.cur === 's' ? Math.floor(b.amount * b.x) : r2s(b.amount * b.x); account({id: b.uid})[b.cur === 's' ? 'stars' : 'gram'] += win;
    }
  }
  if (CR.phase === 'bet' && now >= CR.end) {
    CR.phase = 'fly'; CR.t0 = now; CR.cp = Math.min(200, Math.max(1, 0.96 / (1 - crypto.randomInt(0, 1e9) / 1e9)));
  } else if (CR.phase === 'fly' && Math.exp(0.1 * (now - CR.t0) / 1000) >= CR.cp) {
    CR.phase = 'crash'; CR.end = now + 4000; CR.hist.unshift(Math.floor(CR.cp * 100) / 100); CR.hist.length = Math.min(CR.hist.length, 12);
  } else if (CR.phase === 'crash' && now >= CR.end) {
    CR.phase = 'bet'; CR.end = now + 8000; CR.bets = []; CR.id++;
  }
}, 100);

// --- PVP ---
const ROOMS = new Map();
const roomNew = (type, pub, id) => { const r = { id: id || crypto.randomBytes(3).toString('hex'), type, pub, gid: 1, phase: 'wait', end: 0, players: [], winner: -1, off: 0, pay: 0, created: Date.now() }; ROOMS.set(r.id, r); return r; };
for (const t of ['g', 's', 'n']) roomNew(t, true, 'pub-' + t);
setInterval(() => {
  const now = Date.now();
  for (const r of ROOMS.values()) {
    if (r.phase === 'wait' && r.players.length >= 2) { r.phase = 'count'; r.end = now + 20000; }
    else if (r.phase === 'count' && now >= r.end) {
      const tot = r.players.reduce((a, p) => a + p.val, 0); let x = crypto.randomInt(0, 1e9) / 1e9 * tot, i = 0;
      for (; i < r.players.length - 1; i++) { if ((x -= r.players[i].val) < 0) break; }
      r.winner = i; r.off = crypto.randomInt(8, 92) / 100; r.phase = 'spin'; r.end = now + 6000;
    } else if (r.phase === 'spin' && now >= r.end) { 
      const w = r.players[r.winner], acc = account({ id: w.uid });
      if (r.type === 'n') { acc.nfts.push(...r.players.flatMap(p => p.items)); r.pay = r.players.reduce((a, p) => a + p.items.length, 0); }
      else { const pot = r.players.reduce((a, p) => a + p.stake, 0), k = r.type === 's' ? 'stars' : 'gram'; r.pay = r.type === 's' ? Math.floor(pot * 0.95) : r2s(pot * 0.95); acc[k] += r.pay; }
      r.phase = 'done'; r.end = now + 6000; 
    } else if (r.phase === 'done' && now >= r.end) {
      if (r.pub) Object.assign(r, { phase: 'wait', end: 0, players: [], winner: -1, off: 0, pay: 0, gid: r.gid + 1 }); else ROOMS.delete(r.id);
    }
  }
}, 200);

// --- ХРАНИЛИЩЕ ДЛЯ ОПЛАТЫ ЗВЕЗДАМИ ---
const starInvoices = new Map();

const readBody = req => new Promise(ok => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const json = (res, code, o) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/me') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    return json(res, 200, { user, balance: account(user), prices: PRICES, rate: 350 });
  }
  if (req.method === 'POST' && req.url === '/api/shop/buy') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), name = b.name, UPR = 350;
    const base = Number(PRICES[name] || 0); if (!base) return json(res, 400, { error: 'Нет в продаже' });
    const cur = b.cur === 's' ? 's' : 'g', price = cur === 's' ? Math.floor(base * UPR) : base, key = cur === 's' ? 'stars' : 'gram';
    if (acc[key] < price) return json(res, 400, { error: 'Мало средств' });
    acc[key] = r2s(acc[key] - price);
    const gift = name + ' #' + Math.floor(Math.random() * 1000); acc.nfts.push(gift);
    return json(res, 200, { ok: true, gift, balance: acc });
  }
  if (req.method === 'POST' && req.url === '/api/deposit/address') {
    return json(res, 200, { address: TON_ADDRESS || 'UQAHA5gygHbXRByuFUn3jxzyjFL0Tb0D3wnoFFMuvWNRPFbB' });
  }
  
  // --- ОПЛАТА ЗВЕЗДАМИ ---
  if (req.method === 'POST' && req.url === '/api/stars/create') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), amount = Math.floor(Number(b.amount));
    if (!(amount >= 1 && amount <= 10000)) return json(res, 400, { error: 'Сумма от 1 до 10000' });
    
    const payload = 'st_' + user.id + '_' + Date.now();
    const r = await bot('createInvoiceLink', { 
      title: 'Пополнение Wuxeek', 
      description: `Зачисление ${amount} Stars`, 
      payload: payload, 
      currency: 'XTR', 
      prices: [{ label: 'Stars', amount: amount }] 
    });
    
    if (r.ok) {
       starInvoices.set(payload, { uid: user.id, amount });
       return json(res, 200, { link: r.result });
    } else {
       return json(res, 500, { error: 'Ошибка создания счета' });
    }
  }

  // --- CRASH API ---
  if (req.method === 'POST' && req.url === '/api/crash/state') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const me = CR.bets.find(x => x.uid === user.id);
    const pub = x => ({ n: account({id:x.uid}).name || 'Игрок', a: x.amount, c: x.cur, x: x.x, me: x.uid === user.id, auto: x.uid === user.id ? x.auto : 0 });
    return json(res, 200, { now: Date.now(), id: CR.id, phase: CR.phase, end: CR.end, t0: CR.t0, cp: CR.phase === 'crash' ? CR.cp : null, hist: CR.hist, bets: CR.bets.map(pub), mine: me ? pub(me) : null });
  }
  if (req.method === 'POST' && req.url === '/api/crash/bet') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), me = CR.bets.find(x => x.uid === user.id);
    const cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram', amount = cur === 's' ? Math.floor(Number(b.amount)) : r2s(Number(b.amount));
    if (CR.phase !== 'bet') return json(res, 400, { error: 'Ставки закрыты' });
    if (me) return json(res, 400, { error: 'Вы уже поставили' });
    if (!(amount >= 1) || amount > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
    acc[key] = r2s(acc[key] - amount);
    CR.bets.push({ uid: user.id, amount, cur, x: null, auto: Number(b.auto) >= 1.01 ? Math.floor(Number(b.auto) * 100) / 100 : 0 });
    return json(res, 200, { balance: acc });
  }
  if (req.method === 'POST' && req.url === '/api/crash/cashout') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), me = CR.bets.find(x => x.uid === user.id);
    if (!me || me.x != null || CR.phase !== 'fly') return json(res, 400, { error: 'Нечего забирать' });
    const m = Math.exp(0.1 * (Date.now() - CR.t0) / 1000);
    if (m >= CR.cp) return json(res, 400, { error: 'Взрыв' });
    me.x = Math.floor(m * 100) / 100; const key = me.cur === 's' ? 'stars' : 'gram', win = me.cur === 's' ? Math.floor(me.amount * me.x) : r2s(me.amount * me.x);
    acc[key] = r2s(acc[key] + win);
    return json(res, 200, { win, x: me.x, balance: acc });
  }

  // --- PVP API ---
  if (req.method === 'POST' && req.url.startsWith('/api/pvp/')) {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), b = await readBody(req), UPR = 350;
    acc.name = user.username ? '@' + user.username : user.first_name;
    if (req.url === '/api/pvp/create') return json(res, 200, { id: roomNew(['g', 's', 'n'].includes(b.type) ? b.type : 's', false).id });
    const r = ROOMS.get(String(b.id));
    if (!r) return json(res, 404, { error: 'Игра не найдена' });
    if (req.url === '/api/pvp/state') {
      return json(res, 200, { now: Date.now(), id: r.id, gid: r.gid, type: r.type, phase: r.phase, end: r.end, winner: r.winner, off: r.off, pay: r.pay, players: r.players.map(p => ({ n: p.name, stake: p.stake, items: p.items, val: p.val, me: p.uid === user.id })) });
    }
    if (req.url === '/api/pvp/join') {
      if (r.phase !== 'wait' && (r.phase !== 'count' || r.end - Date.now() < 3000)) return json(res, 400, { error: 'Ставки закрыты' });
      let p = r.players.find(x => x.uid === user.id);
      if (!p && r.players.length >= 8) return json(res, 400, { error: 'Максимум 8 игроков' });
      let stake = 0, val = 0; const items = [];
      if (r.type === 'n') {
        const want = Array.isArray(b.nfts) ? b.nfts.slice(0, 5) : [], have = [...acc.nfts];
        if (!want.length) return json(res, 400, { error: 'Выберите NFT' });
        for (const n of want) { const i = have.indexOf(n); if (i < 0) return json(res, 400, { error: 'Нет NFT' }); have.splice(i, 1); items.push(n); val += itemPrice(n) * UPR; }
        acc.nfts = have;
      } else {
        const key = r.type === 's' ? 'stars' : 'gram'; stake = r.type === 's' ? Math.floor(Number(b.amount)) : r2s(Number(b.amount));
        if (!(stake >= 1) || stake > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
        acc[key] = r2s(acc[key] - stake); val = stake;
      }
      if (!p) { p = { uid: user.id, name: acc.name, stake: 0, items: [], val: 0 }; r.players.push(p); }
      p.stake += stake; p.items.push(...items); p.val += val;
      return json(res, 200, { balance: acc });
    }
  }

  if (req.method === 'POST' && req.url === '/api/mines/start') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram';
    const amount = cur === 's' ? Math.floor(Number(b.amount)) : r2s(Number(b.amount)), mines = Number(b.mines);
    if (cur === 's' && amount < 15) return json(res, 400, { error: 'Минимум 15 Stars' });
    if (cur === 'g' && amount < 1) return json(res, 400, { error: 'Минимум 1 GRAM' });
    if (amount > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
    acc[key] = r2s(acc[key] - amount);
    let mn = []; while (mn.length < mines) { const x = crypto.randomInt(0, 25); if (!mn.includes(x)) mn.push(x); }
    const id = crypto.randomBytes(4).toString('hex');
    MINES.set(id, { id, uid: user.id, amount, cur, key, mines, mn, op: [] });
    return json(res, 200, { gameId: id, balance: acc });
  }
  if (req.method === 'POST' && req.url === '/api/mines/open') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), idx = Number(b.mine), game = [...MINES.values()].find(g => g.uid === user.id);
    if (!game) return json(res, 400, { error: 'Игра не найдена' });
    if (game.mn.includes(idx)) { MINES.delete(game.id); return json(res, 200, { lose: true, balance: acc }); }
    game.op.push(idx);
    const mul = (k) => { let x = k ? .97 : 1; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - game.mines - i); return x; };
    if (game.op.length === 25 - game.mines) {
      const win = game.cur === 's' ? Math.floor(game.amount * mul(game.op.length)) : r2s(game.amount * mul(game.op.length));
      acc[game.key] = r2s(acc[game.key] + win); MINES.delete(game.id); return json(res, 200, { win, balance: acc });
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/mines/cashout') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), game = [...MINES.values()].find(g => g.uid === user.id);
    if (!game) return json(res, 400, { error: 'Игра не найдена' });
    const mul = (k) => { let x = k ? .97 : 1; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - game.mines - i); return x; };
    const win = game.cur === 's' ? Math.floor(game.amount * mul(game.op.length)) : r2s(game.amount * mul(game.op.length));
    acc[game.key] = r2s(acc[game.key] + win); MINES.delete(game.id); return json(res, 200, { win, balance: acc });
  }
  if (req.method === 'POST' && req.url === '/api/upgrade-nft') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), b = await readBody(req), UPR = 350, want = b.nfts, target = Number(b.target);
    let betV = 0;
    for (const n of want) { const i = acc.nfts.indexOf(n); if (i < 0) return json(res, 400, { error: 'NFT не найден' }); acc.nfts.splice(i, 1); betV += itemPrice(n) * UPR; }
    const chance = betV / target * 95;
    if (!want.length || !(target > betV) || chance < 0.5 || chance > 90) return json(res, 400, { error: 'Шанс 0.5%-90%' });
    const win = crypto.randomInt(0, 1e6) / 1e4 < chance;
    if (win) acc.nfts.push(want[0].split(' #')[0] + ' #' + Math.floor(Math.random() * 1000));
    return json(res, 200, { win, chance, balance: acc });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(__dirname + '/wuxeek.html'));
}).listen(PORT, () => console.log('Server on', PORT));

// --- ОБРАБОТКА TELEGRAM ---
const SECRET = crypto.createHash('sha256').update(String(BOT_TOKEN)).digest('hex').slice(0, 32);
function onUpdate(u) {
  // Оплата Stars
  if (u.pre_checkout_query) {
    return bot('answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
  }
  if (u.message && u.message.successful_payment) {
    const sp = u.message.successful_payment;
    const inv = starInvoices.get(sp.invoice_payload);
    if (inv && sp.currency === 'XTR') {
       const acc = account({ id: inv.uid });
       acc.stars += sp.total_amount;
       console.log(`Оплачено ${sp.total_amount} Stars для ${inv.uid}`);
    }
    return;
  }
  // Команда /start
  const m = u.message;
  if (m && m.text && m.text.startsWith('/start')) {
    bot('sendMessage', { chat_id: m.chat.id, text: 'Добро пожаловать в Wuxeek!\nНажми кнопку ниже.', reply_markup: { inline_keyboard: [[{ text: '🎁 Открыть', web_app: { url: WEBAPP_URL } }]] } });
  }
}

if (process.env.WEBHOOK) bot('setWebhook', { url: `${WEBAPP_URL}/tg-webhook/${SECRET}`, secret_token: SECRET });
else { bot('deleteWebhook', {}); (async function poll(offset = 0) { try { const r = await bot('getUpdates', { offset, timeout: 30 }); for (const u of r.result || []) { offset = u.update_id + 1; onUpdate(u); } } catch (e) {} poll(offset); })(); }
