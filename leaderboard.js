// leaderboard.js — Bảng xếp hạng (TIỀN TRUY NÃ + HEADSHOT) cho Western Bullet Clash
//
// CÁCH GẮN: trong server.js, ngay sau khi tạo `io` (socket.io Server):
//     require('./leaderboard')(io);
// Khuyên dùng:  npm i jsonwebtoken   (để xác minh token đăng nhập CrazyGames — không có thì
// tài khoản CrazyGames bị từ chối, trừ khi bật LB_DEV=1 để test local).
// Cần Node 18+ (dùng fetch có sẵn).
//
// Biến môi trường (tuỳ chọn):
//   LB_FILE  đường dẫn file lưu dữ liệu (mặc định ./leaderboard-data.json)
//   LB_DEV=1 chỉ khi test local: cho phép tài khoản CrazyGames "giả" (không token)
//
// LƯU Ý QUAN TRỌNG: ổ đĩa của gói free trên Render là TẠM THỜI (mất khi server khởi động lại
// hoặc deploy lại). Muốn BXH sống lâu, thay 2 hàm loadDb()/saveDb() bên dưới bằng DB ngoài
// (Postgres/Redis/Mongo/Supabase...). Toàn bộ phần còn lại không cần đổi.

const fs = require('fs'), path = require('path'), crypto = require('crypto');
let jwt = null; try { jwt = require('jsonwebtoken'); } catch (e) {}

const FILE = process.env.LB_FILE || path.join(__dirname, 'leaderboard-data.json');
const DEV = process.env.LB_DEV === '1';
const TOP = 50, MAX_BOUNTY = 50000000, MAX_HS = 1000000, MAX_PLAYERS = 20000;
const NAME_RE = /^[\p{L}\p{N} _.\-]{3,16}$/u;

/* ---------- lưu trữ (thay 2 hàm này nếu dùng DB ngoài) ---------- */
let db = { players: {} };
function loadDb() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (d && d.players) db = d; } catch (e) {}
}
let dirty = false;
function saveDb() {
  fs.writeFile(FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(FILE + '.tmp', FILE, () => {}); });
}
loadDb();
setInterval(() => { if (dirty) { dirty = false; saveDb(); } }, 15000).unref();

/* ---------- tiện ích ---------- */
const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const lower = s => String(s).toLowerCase();
const fn = f => (typeof f === 'function' ? f : () => {});
const nameTaken = (name, selfId) => Object.values(db.players).some(p => p.id !== selfId && lower(p.name) === lower(name));
const ipOf = s => String((s.handshake.headers['x-forwarded-for'] || s.handshake.address || '')).split(',')[0].trim();

const lastCall = new WeakMap();
function rate(socket, ms, tag) {
  const m = lastCall.get(socket) || {}, now = Date.now();
  if (m[tag] && now - m[tag] < ms) return false;
  m[tag] = now; lastCall.set(socket, m); return true;
}
const newByIp = new Map();   // ip -> [thời điểm tạo mục mới]
function newOk(ip) {
  const now = Date.now(), a = (newByIp.get(ip) || []).filter(t => now - t < 3600e3);
  if (a.length >= 8) { newByIp.set(ip, a); return false; }
  a.push(now); newByIp.set(ip, a); return true;
}

/* ---------- xác thực ---------- */
let keyCache = { k: '', t: 0 };
async function cgKey(force) {
  if (!force && keyCache.k && Date.now() - keyCache.t < 3600e3) return keyCache.k;
  const j = await (await fetch('https://sdk.crazygames.com/publicKey.json')).json();
  const k = (j && (j.publicKey || j.key)) || (typeof j === 'string' ? j : '');
  if (k) keyCache = { k, t: Date.now() };
  return k;
}
async function cgUser(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4000) return null;
  const pick = p => (p && (p.userId || p.sub)) ? String(p.userId || p.sub) : null;
  if (jwt) {
    for (const force of [false, true]) {
      try { return pick(jwt.verify(token, await cgKey(force), { algorithms: ['RS256'] })); } catch (e) {}
    }
    return null;
  }
  if (DEV) { try { return pick(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())); } catch (e) {} }
  return null;
}
async function who(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'guest') {
    if (typeof d.id !== 'string' || !/^[0-9a-f]{20}$/.test(d.id)) return null;
    return { id: 'g:' + d.id, type: 'guest', key: (typeof d.key === 'string' && /^[0-9a-f]{32}$/.test(d.key)) ? d.key : '' };
  }
  if (d.type === 'cg') {
    if (d.token) { const u = await cgUser(d.token); return u ? { id: 'cg:' + u, type: 'cg' } : null; }
    if (DEV && typeof d.dev === 'string' && /^[\w\-]{3,40}$/.test(d.dev)) return { id: 'dev:' + d.dev, type: 'cg' };
  }
  return null;
}
const authed = (p, w) => (p.type === 'guest' ? (!!w.key && p.keyHash === hash(w.key)) : true);

/* ---------- bảng xếp hạng ---------- */
let memo = { t: 0, bounty: [], headshots: [] };
function tops() {
  if (Date.now() - memo.t < 5000) return memo;
  const all = Object.values(db.players);
  const top = key => all.filter(p => p[key] > 0).sort((a, b) => b[key] - a[key] || a.t - b.t).slice(0, TOP)
    .map(p => ({ id: p.id, n: p.name, v: p[key], t: p.type === 'guest' ? 'guest' : 'cg' }));
  memo = { t: Date.now(), bounty: top('bounty'), headshots: top('headshots') };
  return memo;
}
function prune() {
  const all = Object.values(db.players);
  if (all.length <= MAX_PLAYERS) return;
  all.sort((a, b) => (a.bounty + a.headshots) - (b.bounty + b.headshots));
  for (const p of all.slice(0, all.length - MAX_PLAYERS)) delete db.players[p.id];
}

module.exports = function (io) {
  io.on('connection', socket => {

    // Tạo / cập nhật mục của người chơi: tên + tiền truy nã + headshot
    socket.on('lbSync', async (d, ack) => {
      ack = fn(ack);
      try {
        if (!rate(socket, 1000, 's')) return ack({ ok: false, error: 'rate' });
        const w = await who(d); if (!w) return ack({ ok: false, error: 'auth' });
        if (w.type === 'guest' && !w.key) return ack({ ok: false, error: 'auth' });
        const name = typeof d.name === 'string' ? d.name.replace(/\s+/g, ' ').trim() : '';
        if (!NAME_RE.test(name)) return ack({ ok: false, error: 'bad_name' });
        let p = db.players[w.id];
        if (p && !authed(p, w)) return ack({ ok: false, error: 'auth' });
        if (nameTaken(name, w.id)) return ack({ ok: false, error: 'name_taken' });

        let bounty = Math.floor(Number(d.bounty)), hs = Math.floor(Number(d.headshots));
        if (!(bounty >= 0 && bounty <= MAX_BOUNTY) || !(hs >= 0 && hs <= MAX_HS)) return ack({ ok: false, error: 'bad_stats' });

        const now = Date.now();
        if (!p) {
          if (!newOk(ipOf(socket))) return ack({ ok: false, error: 'rate' });
          p = db.players[w.id] = { id: w.id, type: w.type, name, bounty: 0, headshots: 0, keyHash: w.type === 'guest' ? hash(w.key) : '', t: now, upd: now };
          bounty = Math.min(bounty, 5000000); hs = Math.min(hs, 2000);
          prune();
        } else {
          // chống nhảy số vô lý (client có thể bị sửa): giới hạn tốc độ tăng
          const dt = Math.max(1, (now - p.upd) / 1000);
          bounty = Math.min(bounty, p.bounty + 100000 + dt * 3000);
          hs = Math.max(p.headshots, Math.min(hs, p.headshots + 30 + Math.floor(dt * 12)));
        }
        p.name = name; p.bounty = Math.floor(bounty); p.headshots = hs; p.upd = now;
        dirty = true; memo.t = 0;
        ack({ ok: true, name });
      } catch (e) { ack({ ok: false, error: 'server' }); }
    });

    // Lấy top 50 của cả hai bảng (kèm hạng của người hỏi nếu gửi danh tính)
    socket.on('lbGet', async (d, ack) => {
      ack = fn(ack);
      try {
        if (!rate(socket, 800, 'g')) return ack({ ok: false, error: 'rate' });
        const w = (d && d.type) ? await who(d) : null, t = tops(), all = Object.values(db.players);
        const mark = list => list.map(r => ({ n: r.n, v: r.v, t: r.t, you: !!w && r.id === w.id }));
        const me = w && db.players[w.id];
        const rank = key => (me && me[key] > 0) ? 1 + all.filter(p => p[key] > me[key]).length : 0;
        ack({ ok: true, bounty: mark(t.bounty), headshots: mark(t.headshots), me: { bounty: rank('bounty'), headshots: rank('headshots') }, total: all.length });
      } catch (e) { ack({ ok: false, error: 'server' }); }
    });

    // Xóa mục của chính mình (xóa tài khoản / liên kết sang CrazyGames)
    socket.on('lbDelete', async (d, ack) => {
      ack = fn(ack);
      try {
        if (!rate(socket, 1500, 'd')) return ack({ ok: false, error: 'rate' });
        const w = await who(d); if (!w) return ack({ ok: false, error: 'auth' });
        const p = db.players[w.id]; if (!p) return ack({ ok: true, gone: true });
        if (!authed(p, w)) return ack({ ok: false, error: 'auth' });
        delete db.players[w.id]; dirty = true; memo.t = 0;
        ack({ ok: true });
      } catch (e) { ack({ ok: false, error: 'server' }); }
    });
  });
};
