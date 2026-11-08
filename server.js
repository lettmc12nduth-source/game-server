const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};
let waiting = null; // mã phòng Quick Play đang chờ người thứ 2

function generateRoomCode() {
    let c;
    do { c = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[c]);
    return c;
}

function createRoom(socket) {
    const roomCode = generateRoomCode();
    rooms[roomCode] = { players: [socket.id] };
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('roomCreated', { roomCode, playerIndex: 0 });
    return roomCode;
}

function leaveRoom(socket) {
    const code = socket.roomCode;
    if (!code) return;
    socket.roomCode = null;
    socket.leave(code);
    if (waiting === code) waiting = null;
    if (rooms[code]) {
        socket.to(code).emit('playerLeft', 'Đối thủ đã thoát!');
        delete rooms[code];
    }
}

io.on('connection', (socket) => {
    console.log('Có người chơi kết nối:', socket.id);

    // QUICK PLAY: có người đang chờ thì vào luôn, không thì tạo phòng và chờ
    socket.on('quickPlay', (ack) => {
        if (typeof ack === 'function') ack(true);
        leaveRoom(socket);
        const room = waiting && rooms[waiting];
        if (room && room.players.length === 1) {
            const roomCode = waiting;
            waiting = null;
            room.players.push(socket.id);
            socket.join(roomCode);
            socket.roomCode = roomCode;
            socket.emit('roomJoined', { roomCode, playerIndex: 1 });
            io.to(roomCode).emit('matchStart', { msg: 'Đã ghép trận! Bắt đầu chơi!' });
            console.log(`Quick Play ghép trận: ${roomCode}`);
        } else {
            waiting = createRoom(socket);
            console.log(`Quick Play đang chờ ở phòng: ${waiting}`);
        }
    });

    socket.on('createRoom', () => {
        leaveRoom(socket);
        const roomCode = createRoom(socket);
        console.log(`Đã tạo phòng: ${roomCode}`);
    });

    socket.on('joinRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('errorMsg', 'Mã phòng không tồn tại!'); socket.emit('roomError', 'Mã phòng không tồn tại!'); return; }
        if (room.players.length >= 2) { socket.emit('errorMsg', 'Phòng đã đầy!'); socket.emit('roomError', 'Phòng đã đầy!'); return; }

        if (waiting === roomCode) waiting = null;
        room.players.push(socket.id);
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('roomJoined', { roomCode, playerIndex: 1 });
        io.to(roomCode).emit('matchStart', { msg: 'Đã kết nối 2 người! Bắt đầu chơi!' });
    });

    socket.on('playerSync', (data) => {
        if (socket.roomCode) socket.to(socket.roomCode).emit('enemySync', data);
    });

    socket.on('playerShoot', (bulletData) => {
        if (socket.roomCode) socket.to(socket.roomCode).emit('enemyShoot', bulletData);
    });

    socket.on('disconnect', () => leaveRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Server WebSocket game đang chạy tại cổng ' + PORT);
});
