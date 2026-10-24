const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { BOT_TOKEN, PORT = 3000, CHANNEL = 'https://t.me/wuxeek' } = process.env;
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

const JSON_PATH = __dirname + '/prices.json';
let PRICES = {};
try { PRICES = JSON.parse(fs.readFileSync(JSON_PATH)); } catch(e) {}
const mult = e => { const m = /#(\d+)/.exec(e), x = m ? m[1] : '', n = +x; let k = 1; if (n) { if (n <= 10) k = 5; else if (n <= 100) k = 2.5; else if (x.length >= 3 && new Set(x).size === 1) k = 3; else if (/^[1-9]0{2,}$/.test(x)) k = 2; else if (x.length >= 3 && x === [...x].reverse().join('')) k = 1.4; } if (/\bmono\b/i.test(e)) k *= 2; return Math.min(k, 10); };
const itemPrice = e => (PRICES[String(e).split(' #')[0]] || 0) * mult(e);

const MINES = new Map();
const readBody = req => new Promise(ok => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
const json = (res, code, o) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/me') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    return json(res, 200, { user, balance: account(user) });
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
  if (req.method === 'POST' && req.url === '/api/mines/start') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), cur = b.cur === 's' ? 's' : 'g', key = cur === 's' ? 'stars' : 'gram';
    const amount = cur === 's' ? Math.floor(Number(b.amount)) : r2s(Number(b.amount)), mines = Number(b.mines);
    
    if (cur === 's' && amount < 15) return json(res, 400, { error: 'Минимум 15 Stars' });
    if (cur === 'g' && amount < 1) return json(res, 400, { error: 'Минимум 1 GRAM' });
    if (amount > acc[key]) return json(res, 400, { error: 'Неверная ставка' });
    if (mines < 1 || mines > 24) return json(res, 400, { error: 'Неверно мин' });
    
    acc[key] = r2s(acc[key] - amount);
    let mn = []; while (mn.length < mines) { const x = crypto.randomInt(0, 25); if (!mn.includes(x)) mn.push(x); }
    const id = crypto.randomBytes(4).toString('hex');
    MINES.set(id, { id, uid: user.id, amount, cur, key, mines, mn, op: [] });
    return json(res, 200, { gameId: id, balance: acc });
  }
  if (req.method === 'POST' && req.url === '/api/mines/open') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const b = await readBody(req), acc = account(user), idx = Number(b.mine);
    const game = [...MINES.values()].find(g => g.uid === user.id);
    if (!game) return json(res, 400, { error: 'Игра не найдена' });
    if (game.mn.includes(idx)) { MINES.delete(game.id); return json(res, 200, { lose: true, balance: acc }); }
    game.op.push(idx);
    const mul = (k) => { let x = k ? .97 : 1; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - game.mines - i); return x; };
    if (game.op.length === 25 - game.mines) {
      const win = game.cur === 's' ? Math.floor(game.amount * mul(game.op.length)) : r2s(game.amount * mul(game.op.length));
      acc[game.key] = r2s(acc[game.key] + win); MINES.delete(game.id);
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
    acc[game.key] = r2s(acc[game.key] + win); MINES.delete(game.id);
    return json(res, 200, { win, balance: acc });
  }
  if (req.method === 'POST' && req.url === '/api/upgrade-nft') {
    const user = checkInitData(req.headers['x-init-data'] || ''); if (!user) return json(res, 401, { error: 'Auth' });
    const acc = account(user), b = await readBody(req), UPR = 350, want = b.nfts, target = Number(b.target);
    let betV = 0;
    for (const n of want) { const i = acc.nfts.indexOf(n); if (i < 0) return json(res, 400, { error: 'NFT не найден' }); if (!(itemPrice(n) > 0)) return json(res, 400, { error: 'Нет цены' }); acc.nfts.splice(i, 1); betV += itemPrice(n) * UPR; }
    const chance = betV / target * 95;
    if (!want.length || !(target > betV) || chance < 0.5 || chance > 90) return json(res, 400, { error: 'Шанс 0.5%-90%' });
    const win = crypto.randomInt(0, 1e6) / 1e4 < chance;
    if (win) acc.nfts.push(want[0].split(' #')[0] + ' #' + Math.floor(Math.random() * 1000));
    return json(res, 200, { win, chance, balance: acc });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(__dirname + '/wuxeek.html'));
}).listen(PORT, () => console.log('Server on', PORT));

const SECRET = crypto.createHash('sha256').update(String(BOT_TOKEN)).digest('hex').slice(0, 32);
function onUpdate(u) {
  const m = u.message;
  if (m && m.text && m.text.startsWith('/start')) {
    bot('sendMessage', { chat_id: m.chat.id, text: 'Добро пожаловать в Wuxeek!\nНажми кнопку ниже.', reply_markup: { inline_keyboard: [[{ text: '🎁 Открыть', web_app: { url: WEBAPP_URL } }]] } });
  }
}
if (process.env.WEBHOOK) bot('setWebhook', { url: `${WEBAPP_URL}/tg-webhook/${SECRET}`, secret_token: SECRET });
else { bot('deleteWebhook', {}); (async function poll(offset = 0) { try { const r = await bot('getUpdates', { offset, timeout: 30 }); for (const u of r.result || []) { offset = u.update_id + 1; onUpdate(u); } } catch (e) {} poll(offset); })(); }
