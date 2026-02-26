'use strict';
require('dotenv').config();
const net = require('net');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 5027;
const masterSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const router = new DataRouter(masterSupabase);

const server = net.createServer((socket) => {
    // ESTAS LÍNEAS SON CLAVE PARA RAILWAY
    socket.setNoDelay(true); // Desactiva el retraso de paquetes
    socket.setKeepAlive(true, 10000); // Mantiene el socket despierto

    console.log(`[TCP] 📡 Conexión desde: ${socket.remoteAddress}`);

    let clientCfgPromise = null;
    let imeiStr = null;

    socket.on('data', (data) => {
        try {
            // 1. Manejo de Handshake (IMEI)
            // Relajado totalmente a tu código original: > 10 y < 20 (y que no hayamos seteado el imei aún)
            if (data.length > 10 && data.length <= 25 && !imeiStr) {
                imeiStr = data.toString().replace(/[^0-9]/g, '');

                // MANDAR EL 0x01 EXACTAMENTE COMO LO PEDISTE
                socket.write(Buffer.from([0x01]));
                console.log(`[TCP] 📱 IMEI: ${imeiStr} RECIBIDO Y 0x01 ENVIADO`);

                // Empezar a validar el dispositivo en DB silenciosamente en el fondo
                clientCfgPromise = router.validateDevice(imeiStr).catch(() => null);
                return;
            }

            // 2. Manejo de Datos (Payload)
            if (data.length > 20) {
                console.log(`[TCP] 📥 Recibidos ${data.length} bytes crudos. Parseando...`);

                // Usamos el parser de Codec8 para estar seguros de cuántos registros hay realmente 
                const avl = TeltonikaParser.parseAVLData(data);

                if (avl && avl.records && avl.records.length > 0) {
                    const numRecords = avl.originalCount;

                    // MANDAR EL ACK DE INMEDIATO (4 bytes con el número de registros)
                    const ack = Buffer.alloc(4);
                    ack.writeUInt32BE(numRecords, 0);
                    socket.write(ack);
                    console.log(`[TCP] ✓ ACK ${numRecords} enviado con éxito al GPS. Dando 500ms al GPS...`);

                    // DARLE RESPIRACIÓN: Dejar que el GPS procese el ACK antes de cortar
                    setTimeout(() => {
                        console.log(`[TCP] 🔌 Cerrando conexión de nuestro lado tras procesar (${numRecords} registros)`);
                        socket.end();
                    }, 500);

                    // 3. SEPARAR EL PROCESAMIENTO (Trabajo en Supabase)
                    setImmediate(() => {
                        console.log(`[PROCESO] Subiendo ${avl.records.length} registros en segundo plano para no trabar el socket...`);
                        if (clientCfgPromise) {
                            clientCfgPromise.then(cfg => {
                                if (cfg) {
                                    router.routeData(cfg, avl.records);
                                }
                            }).catch(err => console.error("[CRÍTICO] Error al subir a BD:", err.message));
                        }
                    });

                } else {
                    console.log(`[TCP] ⚠️ El Payload estaba vacío o no pudo ser leído.`);
                    const ack = Buffer.alloc(4);
                    socket.write(ack); // Enviar ACK 0
                    socket.end();
                }
            }
        } catch (err) {
            console.error('[ERROR] Falló el procesamiento pero el servidor SIGUE VIVO:', err.message);
            socket.end();
        }
    });

    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') console.log(`[Socket Error] ${err.message}`);
    });
    socket.on('close', () => console.log('[TCP] 🔌 Conexión cerrada (Nivel OS)'));
});

// ESCUDO TOTAL: Esto evita el SIGTERM por errores de código
process.on('uncaughtException', (err) => console.error('[ALERTA CRÍTICA] Error no capturado:', err));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ZAMEXIA LISTENER V12 'EXACT-REPLICA' activo en puerto ${PORT}`);
});
