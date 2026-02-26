const net = require('net');

const server = net.createServer((socket) => {
    // ESTAS LÍNEAS SON CLAVE PARA RAILWAY
    socket.setNoDelay(true); // Desactiva el retraso de paquetes (Nagle's Algorithm)
    socket.setKeepAlive(true, 10000); // Mantiene el socket despierto 10 segundos

    console.log(`[TCP] 📡 Conexión desde: ${socket.remoteAddress}`);

    socket.on('data', (data) => {
        try {
            // 1. Manejo de Handshake (IMEI)
            if (data.length > 10 && data.length < 20) {
                // MANDAR EL 0x01 SIN NADA MÁS ALREDEDOR
                socket.write(Buffer.from([0x01]), 'binary');
                console.log(`[TCP] 📱 IMEI RECIBIDO Y 0x01 ENVIADO`);
                return;
            }

            // 2. Manejo de Datos (Payload)
            if (data.length > 20) {
                console.log(`[TCP] 📥 Recibidos ${data.length} bytes de datos crudos`);
                // AQUÍ ESTÁ LA MAGIA PARA FORZAR EL BORRADO DEL GPS SIN CRASHEAR
                const numRecords = data[9]; // El protocolo Teltonika trae el conteo aquí
                const ack = Buffer.alloc(4);
                ack.writeUInt32BE(numRecords, 0);

                // MANDAR ACK EN BINARIO Y CERRAR EL SOCKET INMEDIATAMENTE
                socket.write(ack, 'binary', () => {
                    console.log(`[TCP] ✓ ACK ${numRecords} enviado en binario. CERRANDO SOCKET.`);
                    socket.end(); // Fuerza al GPS a entender que la transacción terminó con éxito
                });
            }
        } catch (err) {
            console.error('[ERROR] Falló el procesamiento pero el servidor SIGUE VIVO:', err.message);
        }
    });

    socket.on('error', (err) => console.log(`[Socket Error] ${err.message}`));
    socket.on('close', () => console.log('[TCP] 🔌 Conexión cerrada'));
});

// ESCUDO TOTAL: Esto evita el SIGTERM por errores de código
process.on('uncaughtException', (err) => console.error('[ALERTA CRÍTICA] Error no capturado:', err));

const PORT = process.env.PORT || 5027;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ZAMEXIA EMERGENCY LISTENER activo en puerto ${PORT}`);
});
