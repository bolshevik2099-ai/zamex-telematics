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
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000); // 30s
    socket.setTimeout(60000); // 1m

    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP] 📡 Nueva conexión desde: ${addr}`);

    let buf = Buffer.alloc(0);
    let imei = null;
    let clientCfgPromise = null;

    socket.on('data', (chunk) => {
        try {
            // CONCATENAMOS LOS CHUNKS
            // Esto es vital en redes celulares GPRS. El paquete AVL llega en pedazos.
            // El código anterior lo ignoraba si data.length no era > 20 en ESE instante exacto.
            buf = Buffer.concat([buf, chunk]);

            // 1. MANEJO DE HANDSHAKE (IMEI)
            if (!imei) {
                // Teltonika IMEI = EXACTAMENTE 17 bytes iniciales
                if (buf.length >= 17) {
                    const handshakeChunk = buf.slice(0, 17);

                    // Asegurarnos que sean 0x00 0x0F al inicio
                    if (handshakeChunk[0] === 0x00 && handshakeChunk[1] === 0x0F) {
                        const parsedImei = handshakeChunk.toString('ascii', 2, 17);
                        imei = parsedImei;
                        console.log(`[TCP] 📱 IMEI RECIBIDO: ${imei}`);

                        // EL 0x01 SE MANDA LIMPIO, EN BUFFER, SIN NADA QUE ENSUCIE
                        socket.write(Buffer.from([0x01]));
                        console.log(`[TCP] ✅ Handshake 0x01 enviado`);

                        // Validar dispositivo en DB en segundo plano. Cero espera para el GPS.
                        clientCfgPromise = router.validateDevice(imei).catch(e => {
                            console.error(`[DB] Falló validación IMEI:`, e.message);
                            return null;
                        });

                        // Sacamos el paquete de 17 bytes de nuestro acumulador
                        buf = buf.slice(17);
                    } else {
                        // Tráfico basura (ej. HTTP Health Check de Railway o scanners)
                        socket.end();
                        return;
                    }
                } else {
                    // Ha llegado menos de 17 bytes (ej: 8 bytes). 
                    // No hacemos nada, esperamos a que el siguiente chunk complete los 17 (GPRS latency).
                    return;
                }
            }

            // Si llegamos hasta aquí, el IMEI está verificado, y buf tiene lo que queda.
            // 2. MANEJO DE PAYLOADS AVL
            while (buf.length >= 12) {
                // El preámbulo siempre es 4 bytes de ceros
                if (buf.readUInt32BE(0) !== 0) {
                    // Desfase en el protocolo, borramos 1 byte para buscar resincronización
                    buf = buf.slice(1);
                    continue;
                }

                const dataLength = buf.readUInt32BE(4);
                const totalPacketLength = dataLength + 12; // Preámbulo(4) + Length(4) + Data(N) + CRC(4)

                // Este era el GRAVE ERROR del código de emergencia.
                // Si llegaban 500 bytes (de 1263 totales), intentaba parsearlo y fallaba, 
                // o se saltaba el código (data[9]). GPRS y TCP fragmentan los paquetes al azar.
                // AQUÍ OBLIGAMOS AL SISTEMA A ESPERAR HASTA TENER EL PAQUETE COMPLETO:
                if (buf.length < totalPacketLength) {
                    return; // Retorna y espera más 'data' events de TCP
                }

                // EXTRAEMOS EL PAQUETE COMPLETO DE LOS DATOS QUE LLEGARON
                const packet = buf.slice(0, totalPacketLength);
                buf = buf.slice(totalPacketLength); // El resto (otro paquete AVL) se queda en espera

                console.log(`[TCP] 📥 Recepción de paquete completo AVL: ${totalPacketLength} bytes verdaderos.`);

                // USAMOS TU PARSER ESTABLE PARA ENCONTRAR EL NUMERO REAL EXACTO (Sin importar Codec8 o 8E)
                const avl = TeltonikaParser.parseAVLData(packet);

                if (avl && avl.records.length > 0) {
                    // 3. MANDAR ACK INMEDIATO DE 4 BYTES
                    const ack = TeltonikaParser.buildACK(avl.originalCount);
                    socket.write(ack);
                    console.log(`[TCP] ✓ ACK ${avl.originalCount} ENVIADO AL GPS INSTANTÁNEAMENTE.`);

                    // IMPORTANTE: NO CERRAREMOS EL SOCKET (socket.end).
                    // El GPS de Teltonika necesita recibir ese ACK y ÉL de forma nativa cortará 
                    // la sesión cuando haya vaciado toda su memoria. Cortarlo nosotros lo obliga a reintentar.

                    // 4. AISLAMIENTO BASE DE DATOS (Background Thread)
                    const recordsToSave = avl.records;
                    setImmediate(() => {
                        console.log(`[PROCESO] ⏳ Insertando ${recordsToSave.length} registros en Supabase...`);
                        if (clientCfgPromise) {
                            clientCfgPromise.then(cfg => {
                                if (cfg) {
                                    return router.routeData(cfg, recordsToSave);
                                } else {
                                    console.log(`[DB] No hay configuración de destino para ${imei}. Datos omitidos.`);
                                }
                            }).catch(err => console.error(`[CRÍTICO DB] No pudimos sincronizar GPS con Supabase:`, err.message));
                        }
                    });
                } else {
                    console.log(`[TCP] ⚠️ El paquete AVL no contenía registros legibles (Pings vacíos). ACK 0.`);
                    socket.write(TeltonikaParser.buildACK(0));
                }
            }
        } catch (err) {
            console.error('[CRÍTICO TCP] Fallo letal pero servidor aislado:', err.message);
        }
    });

    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') console.log(`[Socket Error] ${addr}: ${err.message}`);
    });

    socket.on('close', () => console.log(`[TCP] 🔌 Cliente GPS cerró la tubería limpiamente.`));

    socket.on('timeout', () => {
        console.log(`[TCP] ⏱️ Timeout interno GPS, cerrando socket atascado.`);
        socket.destroy();
    });
});

process.on('uncaughtException', (err) => console.error('[ALERTA GLOBAL CRÍTICA]', err));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ZAMEXIA TELTONIKA V11 (BUFFER ACCUMULATOR & NON-DROP) activo en puerto ${PORT}`);
});
