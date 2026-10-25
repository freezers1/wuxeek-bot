const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { BOT_TOKEN, PORT = 3000, CHANNEL = 'https://t.me/wuxeek', TON_ADDRESS } = process.env;
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL;
const ADMINS = [5416686436, 6639931676];

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
const account = u => {
  if (!DB.has(u.id)) {
    DB.set(u.id, { gram: 0, stars: 0, nfts: [], ref: null, refs: 0, name: u.username ? '@'+u.username : u.first_name, username: u.username || null, caseAt: 0, tx: [] });
  } else {
    if (u.username && DB.get(u.id).username !== u.username) {
      DB.get(u.id).username = u.username;
      DB.get(u.id).name = '@' + u.username;
    }
  }
  return DB.get(u.id);
};

const addTx = (acc, title, amount, cur) => {
    acc.tx.unshift({ title, amount, cur, time: Date.now() });
    if (acc.tx.length > 50) acc.tx.pop(); // Храним последние 50
};

const findAccountByUsername = (uname) => {
  const cleanUname = uname.replace('@', '').toLowerCase();
  for (const [id, acc] of DB.entries()) {
    if (acc.username && acc.username.toLowerCase() === cleanUname) return { id, acc };
  }
  return null;
};

const r2s = n => Math.round(n * 100) / 100;
let PRICES = {};
try { PRICES = JSON.parse(fs.readFileSync(__dirname + '/prices.json')); } catch(e) {}
const mult = e => { const m = /#(\d+)/.exec(e), x = m ? m[1] : '', n = +x; let k = 1; if (n) { if (n <= 10) k = 5; else if (n <= 100) k = 2.5; else if (x.length >= 3 && new Set(x).size === 1) k = 3; else if (/^[1-9]0{2,}$/.test(x)) k = 2; else if (x.length >= 3 && x === [...x].reverse().join('')) k = 1.4; } if (/\bmono\b/i.test(e)) k *= 2; return Math.min(k, 10); };
const itemPrice = e => (PRICES[String(e).split(' #')[0]] || 0) * mult(e);

function payRef(acc, amount, cur) {
  if (!acc.ref || !DB.has(acc.ref)) return;
  const inviter = account({ id: acc.ref });
  const refWin = cur === 's' ? Math.floor(amount * 0.1) : r2s(amount * 0.1);
  if (refWin > 0) {
    inviter[cur === 's' ? 'stars' : 'gram'] += refWin;
    addTx(inviter, 'Реферальный бонус', refWin, cur);
  }
}

const MINES = new Map();
const CR = { id: 1, phase: 'bet', end: Date.now() + 8000, t0: 0, cp: 1, bets: [], hist: [] };

setInterval(() => {
  const now = Date.now();
  if (CR.phase === 'fly') {
    const m = Math.exp(0.1 * (now - CR.t0) / 1000);
    for (const b of CR.bets) if (b.auto && b.x == null && m >= b.auto && b.auto < CR.cp) {
       b.x = b.auto; 
       const win = b.cur === 's' ? Math.floor(b.amount * b.x) : r2s(b.amount * b.x); 
       const acc = account({id: b.uid});
       acc[b.cur === 's' ? 'stars' : 'gram'] += win;
       addTx(acc, 'Автовывод Crash x' + b.x, win, b.cur);
       payRef(acc, win, b.cur);
    }
  }
  if (CR.phase === 'bet' && now >= CR.end) {
    CR.phase = 'fly'; CR.t0 = now; 
    const r = Math.random();
    if (r < 0.8) CR.cp = 1.1 + Math.random() * 1.9;
    else if (r < 0.95) CR.cp = 3 + Math.random() * 4;
    else CR.cp = 7 + Math.random() * 8;
    CR.cp = Math.floor(CR.cp * 100) / 100;
  } else if (CR.phase === 'fly' && Math.exp(0.1 * (now - CR.t0) / 1000) >= CR.cp) {
    CR.phase = 'crash'; CR.end = now + 4000; CR.hist.unshift(CR.cp); CR.hist.length = Math.min(CR.hist.length, 12);
  } else if (CR.phase === 'crash' && now >= CR.end) {
    CR.phase = 'bet'; CR.end = now + 8000; CR.bets = []; CR.id++;
  }
}, 100);

// [ОСТАЛЬНЫЕ ИГРЫ И ЛОГИКА ПВП ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ, ДОБАВЛЕНЫ ТОЛЬКО addTx]
// ...
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
      else { const pot = r.players.reduce((a, p) => a + p.stake, 0), k = r.type === 's' ? 'stars' : 'gram'; r.pay = r.type === 's' ? Math.floor(pot * 0.95) : r2s(pot * 0.95); acc[k] += r.pay; addTx(acc, 'Победа в PvP', r.pay, r.type); payRef(acc, r.pay, r.type); }
      r.phase = 'done'; r.end = now + 6000; 
    } else if (r.phase === 'done' && now >= r.end) {
      if (r.pub) Object.assign(r, { phase: 'wait', end: 0, players: [], winner: -1, off: 0, pay: 0, gid: r.gid + 1 }); else ROOMS.delete(r.id);
    }
  }
}, 200);

// [КЕЙС, РОЗЫГРЫШИ И API ЭНДПОИНТЫ]
const starInvoices = new Map();
const CASE_CHANNEL = '@wuxeek';
const CASE = [ [1, 90], [2, 2.5], [3, 1.5], [4, 1], [5, 1], [7, 1], [10, 2], [15, 1] ];

const readBody = req => new Promise(ok => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const json = (res, code, o) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/me') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user);
    return json(res, 200, { user, balance: { ...acc, caseAt: acc.caseAt || 0 }, prices: PRICES, rate: 350, refs: acc.refs || 0 });
  }
  
  if (req.method === 'POST' && req.url === '/api/shop/buy') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), name = b.name, UPR = 350;
    const base = Number(PRICES[name] || 0); if (!base) return json(res, 400, { error: 'Нет в продаже' });
    const cur = b.cur === 's' ? 's' : 'g', price = cur === 's' ? Math.floor(base * UPR) : base, key = cur === 's' ? 'stars' : 'gram';
    if (acc[key] < price) return json(res, 400, { error: 'Мало средств' });
    acc[key] = r2s(acc[key] - price);
    const gift = name + ' #' + Math.floor(Math.random() * 1000); acc.nfts.push(gift);
    addTx(acc, 'Покупка ' + name, price, cur);
    return json(res, 200, { ok: true, gift, balance: acc });
  }
  
  if (req.method === 'POST' && req.url === '/api/deposit/address') {
    return json(res, 200, { address: TON_ADDRESS || 'UQAHA5gygHbXRByuFUn3jxzyjFL0Tb0D3wnoFFMuvWNRPFbB' });
  }
  
  if (req.method === 'POST' && req.url === '/api/case/open') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), left = (acc.caseAt || 0) + 86400000 - Date.now();
    if (left > 0) return json(res, 400, { error: 'Кейс будет доступен позже', left });
    const mem = await bot('getChatMember', { chat_id: CASE_CHANNEL, user_id: user.id });
    if (!(mem.ok && ['member', 'administrator', 'creator'].includes(mem.result.status))) {
      return json(res, 403, { error: mem.ok ? `Сначала подпишитесь на ${CASE_CHANNEL}` : `Ошибка проверки подписки. Добавьте бота в админы канала!` });
    }
    let x = crypto.randomInt(0, 1e6) / 1e4, win = 1;
    for (const [v, w] of CASE) { if ((x -= w) < 0) { win = v; break; } }
    acc.caseAt = Date.now(); acc.stars += win;
    addTx(acc, 'Бесплатный кейс', win, 's');
    payRef(acc, win, 's');
    return json(res, 200, { win, next: acc.caseAt + 86400000, balance: acc });
  }
  
  if (req.method === 'POST' && req.url === '/api/stars/create') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), amount = Math.floor(Number(b.amount));
    if (!(amount >= 1 && amount <= 10000)) return json(res, 400, { error: 'Сумма от 1 до 10000' });
    const payload = 'st_' + user.id + '_' + Date.now();
    const r = await bot('createInvoiceLink', { title: 'Пополнение Wuxeek', description: `Зачисление ${amount} Stars`, payload: payload, currency: 'XTR', prices: [{ label: 'Stars', amount: amount }] });
    if (r.ok) { starInvoices.set(payload, { uid: user.id, amount }); return json(res, 200, { link: r.result }); }
    return json(res, 500, { error: 'Ошибка создания счета' });
  }

  if (req.method === 'POST' && req.url === '/api/giveaways') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const active = GV.filter(g => g.status === 'active').map(g => ({ id: g.id, nfts: g.nfts, end: g.end, players: g.players.length, joined: g.players.includes(user.id), own: g.owner === user.id }));
    return json(res, 200, { active });
  }
  
  if (req.method === 'POST' && req.url === '/api/giveaways/create') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), mins = Number(b.minutes), want = b.nfts;
    if (!(mins >= 1 && mins <= 1440) || !want || !want.length) return json(res, 400, { error: 'Неверные параметры' });
    for (const n of want) { const i = acc.nfts.indexOf(n); if (i < 0) return json(res, 400, { error: 'Нет NFT' }); acc.nfts.splice(i, 1); }
    const id = crypto.randomBytes(4).toString('hex').toUpperCase();
    GV.push({ id, owner: user.id, nfts: want, end: Date.now() + mins * 60000, players: [], status: 'active' });
    return json(res, 200, { ok: true, nfts: acc.nfts });
  }
  
  if (req.method === 'POST' && req.url === '/api/giveaways/join') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), g = GV.find(x => x.id === b.id && x.status === 'active');
    if (!g || g.owner === user.id || g.players.includes(user.id)) return json(res, 400, { error: 'Нельзя участвовать' });
    g.players.push(user.id); return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/api/crash/state') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const me = CR.bets.find(x => x.uid === user.id);
    const pub = x => ({ n: account({id:x.uid}).name || 'Игрок', a: x.amount, c: x.cur, x: x.x, me: x.uid === user.id, auto: x.uid === user.id ? x.auto : 0 });
    return json(res, 200, { now: Date.now(), id: CR.id, phase: CR.phase, end: CR.end, t0: CR.t0, cp: CR.phase === 'crash' ? CR.cp : null, hist: CR.hist, bets: CR.bets.map(pub), mine: me ? pub(me) : null });
  }
  
  if (req.method === 'POST' && req.url === '/api/crash/bet') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), me = CR.bets.find(x => x.uid === user.id);
    const cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram';
    const amount = cur === 's' ? Math.floor(Number(b.amount)) : r2s(Number(b.amount));
    
    if (CR.phase !== 'bet') return json(res, 400, { error: 'Ставки закрыты' });
    if (me) return json(res, 400, { error: 'Вы уже поставили' });
    if (!isFinite(amount) || amount < 1 || amount > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
    
    acc[key] = r2s(acc[key] - amount);
    addTx(acc, 'Ставка Crash', amount, cur);
    const autoRaw = Number(b.auto);
    const auto = isFinite(autoRaw) && autoRaw >= 1.01 ? Math.min(autoRaw, 100) : 0;
    
    CR.bets.push({ uid: user.id, amount, cur, x: null, auto: Math.floor(auto * 100) / 100 });
    return json(res, 200, { balance: acc });
  }
  
  if (req.method === 'POST' && req.url === '/api/crash/cashout') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), me = CR.bets.find(x => x.uid === user.id);
    if (!me || me.x != null || CR.phase !== 'fly') return json(res, 400, { error: 'Нечего забирать' });
    const m = Math.exp(0.1 * (Date.now() - CR.t0) / 1000);
    if (m >= CR.cp) return json(res, 400, { error: 'Взрыв' });
    me.x = Math.floor(m * 100) / 100; 
    const key = me.cur === 's' ? 'stars' : 'gram', win = me.cur === 's' ? Math.floor(me.amount * me.x) : r2s(me.amount * me.x);
    acc[key] = r2s(acc[key] + win);
    addTx(acc, 'Выигрыш Crash x' + me.x, win, me.cur);
    payRef(acc, win, me.cur);
    return json(res, 200, { win, x: me.x, balance: acc });
  }

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
        if (!isFinite(stake) || !(stake >= 1) || stake > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
        acc[key] = r2s(acc[key] - stake); val = stake;
        addTx(acc, 'Ставка PvP', stake, r.type);
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
    if (!isFinite(amount) || !isFinite(mines)) return json(res, 400, {error: 'Ошибка ввода'});
    if (cur === 's' && amount < 15) return json(res, 400, { error: 'Минимум 15 Stars' });
    if (cur === 'g' && amount < 1) return json(res, 400, { error: 'Минимум 1 GRAM' });
    if (amount > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
    acc[key] = r2s(acc[key] - amount);
    addTx(acc, 'Ставка в Минах', amount, cur);
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
      acc[game.key] = r2s(acc[game.key] + win); 
      addTx(acc, 'Выигрыш в Минах', win, game.cur);
      payRef(acc, win, game.cur);
      MINES.delete(game.id); 
      return json(res, 200, { win, balance: acc });
    }
    return json(res, 200, { ok: true });
  }
  
  if (req.method === 'POST' && req.url === '/api/mines/cashout') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), game = [...MINES.values()].find(g => g.uid === user.id);
    if (!game) return json(res, 400, { error: 'Игра не найдена' });
    const mul = (k) => { let x = k ? .97 : 1; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - game.mines - i); return x; };
    const win = game.cur === 's' ? Math.floor(game.amount * mul(game.op.length)) : r2s(game.amount * mul(game.op.length));
    acc[game.key] = r2s(acc[game.key] + win); 
    addTx(acc, 'Забрал из Минов', win, game.cur);
    payRef(acc, win, game.cur);
    MINES.delete(game.id); 
    return json(res, 200, { win, balance: acc });
  }
  
  if (req.method === 'POST' && req.url === '/api/upgrade-nft') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), b = await readBody(req), want = b.nfts, targetName = b.targetName, UPR = 350;
    
    if (!Array.isArray(want) || !want.length || !targetName) return json(res, 400, { error: 'Неверные данные' });
    const targetPrice = PRICES[targetName] || 0;
    if (!targetPrice) return json(res, 400, { error: 'Приз не найден' });

    let betV = 0;
    for (const n of want) {
       const i = acc.nfts.indexOf(n);
       if (i < 0) return json(res, 400, { error: 'NFT не найден в инвентаре' }); 
       betV += itemPrice(n) * UPR;
    }

    const chance = (betV / (targetPrice * UPR)) * 95;
    if (!(targetPrice * UPR > betV) || chance < 0.5 || chance > 90) {
       return json(res, 400, { error: 'Шанс должен быть от 0.5% до 90%' });
    }

    for (const n of want) { const i = acc.nfts.indexOf(n); acc.nfts.splice(i, 1); }
    const win = crypto.randomInt(0, 1e6) / 1e4 < chance;
    if (win) acc.nfts.push(targetName + ' #' + Math.floor(Math.random() * 1000));
    
    return json(res, 200, { win, chance, balance: acc });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(__dirname + '/wuxeek.html'));
}).listen(PORT, () => console.log('Server on', PORT));

const SECRET = crypto.createHash('sha256').update(String(BOT_TOKEN)).digest('hex').slice(0, 32);
function onUpdate(u) {
  if (u.pre_checkout_query) return bot('answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
  if (u.message && u.message.successful_payment) {
    const sp = u.message.successful_payment, inv = starInvoices.get(sp.invoice_payload);
    if (inv && sp.currency === 'XTR') {
       const acc = account({ id: inv.uid });
       acc.stars += sp.total_amount;
       addTx(acc, 'Пополнение Stars', sp.total_amount, 's');
    }
    return;
  }
  
  const m = u.message;
  if (!m || !m.text) return;

  if (m.text.startsWith('/give')) {
    if (!ADMINS.includes(m.from.id)) return bot('sendMessage', { chat_id: m.chat.id, text: '❌ У вас нет прав для этой команды.' });
    const args = m.text.split(' ');
    const targetUser = args[1];
    const amount = Number(args[2]);
    
    if (!targetUser || !amount || isNaN(amount) || amount <= 0) {
      return bot('sendMessage', { chat_id: m.chat.id, text: '❌ Использование: /give @username СУММА\nПример: /give @durov 10' });
    }
    
    const found = findAccountByUsername(targetUser);
    if (!found) {
      return bot('sendMessage', { chat_id: m.chat.id, text: `❌ Игрок ${targetUser} не найден. Возможно, он еще не заходил в игру.` });
    }
    
    found.acc.gram += amount;
    addTx(found.acc, 'Начисление от админа', amount, 'g');
    return bot('sendMessage', { chat_id: m.chat.id, text: `✅ Успешно зачислено ${amount} GRAM игроку ${targetUser}.\nЕго баланс: ${found.acc.gram} GRAM.` });
  }

  if (m.text.startsWith('/start')) {
    // ... логика старта без изменений
  }
}
if (process.env.WEBHOOK) bot('setWebhook', { url: `${WEBAPP_URL}/tg-webhook/${SECRET}`, secret_token: SECRET });
else { bot('deleteWebhook', {}); (async function poll(offset = 0) { try { const r = await bot('getUpdates', { offset, timeout: 30 }); for (const u of r.result || []) { offset = u.update_id + 1; onUpdate(u); } } catch (e) {} poll(offset); })(); }
