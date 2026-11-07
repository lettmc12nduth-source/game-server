const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
    console.log('Có người chơi kết nối:', socket.id);

    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = { players: [socket.id] };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('roomCreated', { roomCode, playerIndex: 0 });
        console.log(`Đã tạo phòng: ${roomCode}`);
    });

    socket.on('joinRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('errorMsg', 'Mã phòng không tồn tại!'); return; }
        if (room.players.length >= 2) { socket.emit('errorMsg', 'Phòng đã đầy!'); return; }

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

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            io.to(socket.roomCode).emit('playerLeft', 'Đối thủ đã thoát!');
            delete rooms[socket.roomCode];
        }
    });
});

server.listen(3000, () => {
    console.log('🚀 Server WebSocket game đang chạy tại http://localhost:3000');
});