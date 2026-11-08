/* =========================================================
   Western Bullet Clash 3D — server Quick Play (Socket.io)
   Chạy:  npm install  &&  node server.js
   Render: Build Command = npm install · Start Command = node server.js

   Giao thức (khớp với index.html):
     client -> server : quickPlay (ack) · playerSync · playerShoot
     server -> client : roomCreated / roomJoined {roomCode, playerIndex}
                        matchStart · enemySync · enemyShoot · playerLeft
   Server chỉ ghép cặp và CHUYỂN TIẾP gói tin cho đúng đối thủ. Sát thương do
   máy bị bắn tự tính rồi gửi hp/khiên qua playerSync.
   ========================================================= */
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  // Endpoint kiểm tra sống (Render / UptimeRobot) + thống kê nhanh
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ok: true, waiting: waiting ? 1 : 0, rooms: rooms.size, online: io.engine.clientsCount }));
});

const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5            // gói đồng bộ rất nhỏ, chặn dữ liệu rác
});

let waiting = null;                 // người đang chờ ghép
const rooms = new Map();            // roomCode -> [socketA, socketB]

const newCode = () => {
  let c;
  do { c = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(c));
  return c;
};
const isObj = d => d && typeof d === 'object';

function leaveRoom(socket) {
  const code = socket.data.room;
  if (waiting === socket) waiting = null;
  if (!code) return;
  socket.data.room = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;
  const other = room.find(s => s !== socket);
  rooms.delete(code);
  if (other && other.connected) {
    other.emit('playerLeft');       // báo cho đối thủ; room đã xoá nên mọi gói sau đó bị bỏ qua
    other.data.room = null;
    other.leave(code);
  }
}

function pair(a, b) {
  const code = newCode();
  rooms.set(code, [a, b]);
  a.join(code); b.join(code);
  a.data.room = b.data.room = code;
  a.data.index = 0; b.data.index = 1;
  a.emit('roomCreated', { roomCode: code, playerIndex: 0 });
  b.emit('roomJoined', { roomCode: code, playerIndex: 1 });
  io.to(code).emit('matchStart', { roomCode: code });
  console.log(`[match] ${code}  ${a.id} vs ${b.id}`);
}

io.on('connection', socket => {
  socket.data.room = null;

  socket.on('quickPlay', ack => {
    if (typeof ack === 'function') ack(true);   // client dùng ack để biết server có hỗ trợ QUICK PLAY
    leaveRoom(socket);                          // đang ở phòng cũ / đang chờ thì rời trước
    if (waiting && waiting !== socket && waiting.connected) {
      const other = waiting; waiting = null;
      pair(other, socket);
    } else {
      waiting = socket;
    }
  });

  // Vị trí / tư thế / hp / khiên của người gửi -> đối thủ nhận dưới tên enemySync.
  // volatile: gói cũ bị rớt khi mạng nghẽn thay vì dồn lại gây trễ.
  socket.on('playerSync', d => {
    const code = socket.data.room;
    if (!code || !isObj(d)) return;
    socket.to(code).volatile.emit('enemySync', d);
  });

  // Phát bắn: phải đến nơi đầy đủ và đúng thứ tự -> gửi bình thường, không volatile.
  socket.on('playerShoot', d => {
    const code = socket.data.room;
    if (!code || !isObj(d)) return;
    socket.to(code).emit('enemyShoot', d);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

httpServer.listen(PORT, () => console.log(`Quick Play server đang chạy ở cổng ${PORT}`));

module.exports = { io, httpServer, rooms };
