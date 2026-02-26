const net = require('net');

const server = net.createServer((socket) => {
    // ESTAS LÍNEAS SON CLAVE PARA RAILWAY
    socket.setNoDelay(true); // Desactiva el retraso de paquetes (Nagle's Algorithm)
    socket.setKeepAlive(true, 10000); // Mantiene el socket despierto 10 segundos

    console.log(`[TCP] 📡 Conexión desde: ${socket.remoteAddress}`);

    socket.on('data', (data) => {
        try {
            // 1. Manejo de Handshake (IMEI) - El paquete Teltonika mide EXACTAMENTE 17 bytes
            if (data.length === 17) {
                // MANDAR EL 0x01 SIN NADA MÁS ALREDEDOR
                socket.write(Buffer.from([0x01]), 'binary');
                console.log(`[TCP] 📱 IMEI RECIBIDO Y 0x01 ENVIADO`);
                return;
            }

            // 2. Manejo de Datos (Payload)
            if (data.length > 20) {
                console.log(`[TCP] 📥 Recibidos ${data.length} bytes. Procesando...`);

                // 1. EXTRAER EL NÚMERO DE REGISTROS (Está en el byte índice 9 en Codec 8)
                const numRecords = data[9];

                // 2. MANDAR EL ACK DE INMEDIATO (4 bytes con el número de registros)
                const ack = Buffer.alloc(4);
                ack.writeUInt32BE(numRecords, 0);

                // MANDAR ACK EN BINARIO Y DARLE TIEMPO AL GPS PARA RESPIRAR
                socket.write(ack, 'binary', () => {
                    console.log(`[TCP] ✓ ACK ${numRecords} enviado con éxito. Esperando 500ms para cerrar...`);
                    // NO CERRAR INMEDIATAMENTE - Dar tiempo al GPS de procesar el ACK
                    setTimeout(() => {
                        socket.end(); // Fuerza al GPS a entender que la transacción terminó
                        console.log(`[TCP] 🔌 Socket cerrado tras 500ms de gracia.`);
                    }, 500);
                });

                // 3. SEPARAR EL PROCESAMIENTO
                // Aquí es donde el agente la está regando. 
                // Que use un setImmediate para que el socket no se bloquee.
                setImmediate(() => {
                    try {
                        console.log("Procesando datos en segundo plano para no trabar el socket...");
                        // Aquí va la lógica de Supabase envuelta en OTRO try-catch
                    } catch (e) {
                        console.error("[CRÍTICO] Error en el worker asíncrono:", e.message);
                    }
                });
            }
        } catch (err) {
            console.error("[CRÍTICO] El procesador falló pero NO mataremos el servidor:", err.message);
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
