const net = require('net');

const server = net.createServer((socket) => {
    console.log(`[TCP] 📡 Conexión desde: ${socket.remoteAddress}`);

    socket.on('data', (data) => {
        try {
            // 1. Manejo de Handshake (IMEI)
            if (data.length > 10 && data.length < 20) {
                const imei = data.toString().replace(/[^0-9]/g, '');
                console.log(`[TCP] 📱 IMEI: ${imei}`);
                socket.write(Buffer.from([0x01])); // El 0x01 binario que el GPS ama
                console.log(`[TCP] ✅ Handshake enviado`);
                return;
            }

            // 2. Manejo de Datos (Payload)
            if (data.length > 20) {
                console.log(`[TCP] 📥 Recibidos ${data.length} bytes de datos crudos`);
                // Aquí el agente puede meter su lógica de Supabase LUEGO.
                // Por ahora, solo mandamos el ACK para que el GPS borre su memoria.
                const numRecords = data[9]; // El protocolo Teltonika trae el conteo aquí
                const ack = Buffer.alloc(4);
                ack.writeUInt32BE(numRecords, 0);
                socket.write(ack);
                console.log(`[TCP] ✓ ACK ${numRecords} enviado. GPS debería limpiar memoria.`);
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
