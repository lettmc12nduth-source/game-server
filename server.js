/* server.js — Socket.io cho game cao bồi: quickPlay + createRoom + joinRoom
   Client -> server: quickPlay | createRoom | joinRoom(code) | playerSync | playerShoot
   Server -> client: roomCreated | roomJoined {roomCode, playerIndex} | roomError(msg)
                     matchStart | enemySync | enemyShoot | playerLeft                    */
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end('cowboy game server ok');
});
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5,
  pingInterval: 10000,
  pingTimeout: 20000,
});

const rooms = new Map();            // code -> { code, players: [socketHost, socketGuest|null] }
let queue = [];                     // socket đang chờ ghép nhanh
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // bỏ 0/O/1/I cho dễ đọc mã

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
const ackOf = args => args.find(a => typeof a === 'function');
const opponent = s => {
  const r = rooms.get(s.data.room);
  return r ? r.players.find(p => p && p.id !== s.id) || null : null;
};

/* Rời phòng / rời hàng chờ. Có đối thủ thì báo playerLeft rồi đóng phòng. */
function leave(s) {
  queue = queue.filter(q => q !== s);
  const code = s.data.room;
  if (!code) return;
  s.data.room = null;
  const r = rooms.get(code);
  if (!r) return;
  rooms.delete(code);
  for (const p of r.players) if (p && p !== s) { p.data.room = null; p.emit('playerLeft'); }
}
const startMatch = r => r.players.forEach(p => p.emit('matchStart', { roomCode: r.code }));

/* PVP ghép nhanh: có người chờ thì ghép ngay, không thì vào hàng chờ */
function quickPlay(s) {
  leave(s);
  queue = queue.filter(q => q.connected);
  const mate = queue.shift();
  if (!mate) { queue.push(s); return; }
  const r = { code: newCode(), players: [mate, s] };
  rooms.set(r.code, r); mate.data.room = s.data.room = r.code;
  mate.emit('roomCreated', { roomCode: r.code, playerIndex: 0 });
  s.emit('roomJoined', { roomCode: r.code, playerIndex: 1 });
  startMatch(r);
}

/* TẠO PHÒNG: chủ phòng chờ, bạn nhập mã là vào */
function createRoom(s) {
  leave(s);
  const r = { code: newCode(), players: [s, null] };
  rooms.set(r.code, r); s.data.room = r.code;
  s.emit('roomCreated', { roomCode: r.code, playerIndex: 0 });
}

/* VÀO PHÒNG: nhập mã. Đủ 2 người thì bắt đầu luôn */
function joinRoom(s, raw) {
  const code = String(raw || '').trim().toUpperCase().slice(0, 12);
  leave(s);
  const r = rooms.get(code);
  if (!r) return s.emit('roomError', 'Không tìm thấy phòng ' + code + '.');
  if (r.players[1] || !r.players[0] || !r.players[0].connected) return s.emit('roomError', 'Phòng đã đầy hoặc đã đóng.');
  r.players[1] = s; s.data.room = code;
  s.emit('roomJoined', { roomCode: code, playerIndex: 1 });
  startMatch(r);
}

/* Chuyển dữ liệu sang đối thủ. volatile chỉ dùng khi đối thủ đang ở websocket (polling sẽ rớt gói) */
function relay(s, ev, d, vol) {
  const o = opponent(s);
  if (!o || !d || typeof d !== 'object') return;
  const ws = !!(o.conn && o.conn.transport && o.conn.transport.name === 'websocket');
  (vol && ws ? o.volatile : o).emit(ev, d);
}

io.on('connection', socket => {
  socket.data.room = null;
  let n = 0, t0 = Date.now();
  const ok = () => { const now = Date.now(); if (now - t0 > 1000) { t0 = now; n = 0; } return ++n <= 200; };   // chống spam

  socket.on('quickPlay', (...a) => { const ack = ackOf(a); if (ack) ack(); if (ok()) quickPlay(socket); });
  socket.on('createRoom', (...a) => { const ack = ackOf(a); if (ack) ack(); if (ok()) createRoom(socket); });
  socket.on('joinRoom', (...a) => { const ack = ackOf(a); if (ack) ack(); if (ok()) joinRoom(socket, a.find(x => typeof x === 'string')); });
  socket.on('playerSync', d => { if (ok()) relay(socket, 'enemySync', d, true); });
  socket.on('playerShoot', d => { if (ok()) relay(socket, 'enemyShoot', d, false); });
  socket.on('disconnect', () => leave(socket));
});

server.listen(PORT, () => console.log('Game server chạy ở cổng ' + PORT));
