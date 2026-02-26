/**
 * Zamex Telematics - Teltonika TCP ULTRA-LISTENER V8 (ULTRA-STABLE)
 * VERSION: Bulletproof Lock-based Stream + Nagle bypass
 */

require('dotenv').config();
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

const PORT = process.env.PORT || 5027; // UN SOLO PUERTO PARA TODO
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL/KEY');
    process.exit(1);
}

const masterSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const router = new DataRouter(masterSupabase);

// ==========================================
// FUNCIÓN BOMBEO DE FLUJO DE DATOS
// ==========================================
function handleTeltonikaConnection(socket, initialChunk, clientAddress) {
    // 🚨 VITAL: Re-asegurar Nagle bypass en el handler específico
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);
    socket.setTimeout(120000); // 2 minutos de tolerancia antes de soltar la red por inactividad

    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.from(initialChunk); // Iniciar de inmediato
    let isProcessing = false;

    // Primer log exhaustivo
    console.log(`[Server TCP] 📥 Recibidos ${initialChunk.length} bytes iniciales de ${clientAddress}`);
    console.log(`[Server TCP] 🔍 Raw Hex Inicial: ${initialChunk.toString('hex')}`);

    const pump = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            while (dataBuffer.length > 0) {
                if (!deviceIMEI) {
                    if (dataBuffer.length < 17) break; // IMEI requiere mínimo 17 bytes

                    const imeiStr = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!imeiStr) {
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    deviceIMEI = imeiStr;
                    console.log(`[Server TCP] 📱 IMEI Identificado: ${deviceIMEI}`);

                    // 🚨 VITAL: Responder INMEDIATAMENTE
                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server TCP] ✅ Handshake 0x01 enviado en microsegundos.`);

                    // Ahora validamos asincronamente
                    clientConfig = await router.validateDevice(deviceIMEI);

                    if (!clientConfig) {
                        console.warn(`[Server TCP] ⚠️ Rechazado: ${deviceIMEI}`);
                        socket.destroy();
                        break;
                    }

                    // Avanzar buffer
                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Datos AVL
                    if (dataBuffer.length < 12) break;

                    const preamble = dataBuffer.readUInt32BE(0);
                    if (preamble !== 0) {
                        // Tratar de resincronizar si el encabezado está corrupto
                        let syncPos = -1;
                        for (let i = 1; i <= dataBuffer.length - 4; i++) {
                            if (dataBuffer.readUInt32BE(i) === 0) {
                                syncPos = i; break;
                            }
                        }
                        if (syncPos !== -1) {
                            console.warn(`[Server TCP] 🔄 Limpiando ${syncPos} bytes de ruido antes del payload.`);
                            dataBuffer = dataBuffer.slice(syncPos);
                            continue;
                        } else {
                            dataBuffer = Buffer.alloc(0);
                            break;
                        }
                    }

                    const dataLength = dataBuffer.readUInt32BE(4);
                    const totalLength = dataLength + 12;

                    if (dataBuffer.length < totalLength) {
                        console.log(`[Server TCP] ⏳ Paquete parcial detectado en memoria (${dataBuffer.length} / ${totalLength} bytes). Esperando más chunks...`);
                        break;
                    }

                    console.log(`[Server TCP] 📦 Paquete completo en memoria (${totalLength} bytes). Extrayendo...`);
                    const packet = dataBuffer.slice(0, totalLength);
                    dataBuffer = dataBuffer.slice(totalLength);

                    const avlData = TeltonikaParser.parseAVLData(packet);

                    if (avlData && avlData.records && avlData.records.length > 0) {
                        // 🚨 VITAL: Siempre confirmar a Teltonika la misma cantidad de registros que ellos reportan en su Header (originalCount). 
                        // Si confirmamos menos porque el parser purgó uno dañado, Teltonika asume pérdida de datos y repite todo el paquete.
                        const recordCount = avlData.originalCount || avlData.records.length;

                        // 🚨 VITAL: ACK súper rápido (TCP Puro / 4 bytes exactos)
                        const ack = Buffer.alloc(4);
                        ack.writeUInt32BE(recordCount, 0);
                        socket.write(ack);
                        console.log(`[Server TCP] ✓ ACK ${recordCount} devuelto a ${deviceIMEI} al instante.`);

                        // Inserción en background (NO bloquea)
                        router.routeData(clientConfig, avlData.records).then(() => {
                            console.log(`[Router Supabase] 💾 Insertados ${recordCount} registros de ${deviceIMEI}`);
                        }).catch(e =>
                            console.error("[Router Supabase] ❌ Error de BD:", e.message)
                        );
                    } else {
                        console.warn(`[Parser TCP] ⚠️ Datos extraídos están vacíos o corruptos para ${deviceIMEI}. (avlData: ${avlData ? 'Válido' : 'Nulo'})`);
                        const ack = Buffer.alloc(4);
                        ack.writeUInt32BE(0, 0);
                        socket.write(ack);
                    }
                }
            }
        } catch (err) {
            console.error(`[Server TCP] ❌ Error general (${deviceIMEI}):`, err.message);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    };

    // ⚡ CRÍTICO: Registrar PRIMERO el listener de datos ANTES de llamar a pump()
    // Esto evita la Race Condition: si pump() hace un 'await' y el GPS manda
    // datos en ese microinstante, los bytes quedarían en el vacío porque el
    // listener aún no existía. Ahora el buffer los captura siempre.
    socket.on('data', (chunk) => {
        console.log(`[Server TCP] 📥 Recibidos ${chunk.length} bytes adicionales de ${deviceIMEI || clientAddress}`);
        console.log(`[Server TCP] 🔍 Raw Hex Adicional: ${chunk.toString('hex').substring(0, 100)}...`);
        if (dataBuffer.length > 20000) dataBuffer = Buffer.alloc(0);
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
        pump();
    });

    socket.on('timeout', () => {
        console.warn(`[TCP Timeout] ⏱️ El dispositivo ${deviceIMEI || clientAddress} no envió datos en 120s. Cerrando conexión por inactividad.`);
        socket.destroy();
    });

    socket.on('error', (e) => console.log(`[TCP Error] 🔌 ${deviceIMEI || clientAddress} -> ${e.message}`));
    socket.on('close', () => console.log(`[TCP Close] 🔌 Desconectado: ${deviceIMEI || clientAddress}`));

    // ⚡ Ahora sí encendemos la bomba con el chunk inicial
    pump();
}

// ==========================================
// SERVIDOR MULTIPLEXADOR PRINCIPAL
// ==========================================
const server = net.createServer((socket) => {
    // 🚨 APAGAR NAGLE
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);

    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Multiplex] 📡 Nueva conexión en puerta: ${clientAddress}`);

    socket.once('data', (chunk) => {
        if (chunk.length === 0) return;

        const firstByte = chunk[0];
        const isHTTP = firstByte >= 0x41 && firstByte <= 0x5A;

        if (isHTTP) {
            console.log(`[Health Check] 🟢 Petición HTTP detectada. 200 OK.`);
            const response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nZamex Listener V8 (Ultra-Stable)\n";
            socket.write(response);
            socket.end();
        } else if (firstByte === 0x00) {
            // Mandar a Teltonika puro
            handleTeltonikaConnection(socket, chunk, clientAddress);
        } else {
            console.warn(`[Multiplex] ❓ Tráfico desconocido (${firstByte.toString(16)}).`);
            socket.end();
        }
    });

    socket.on('error', (e) => {
        // Ignorar ERST silenciosamente si es Railway Health check matando conexiones
        if (e.code !== 'ECONNRESET') {
            console.log(`[Multiplex Error] ${clientAddress} -> ${e.message}`);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - ULTRA-LISTENER V8 (ULTRA-STABLE)');
    console.log('  MÓDULO: ASYNC PUMP & FAST-HANDSHAKE');
    console.log(`  🚀 ESCUCHANDO EN PUERTO MAESTRO: ${PORT}`);
    console.log('═══════════════════════════════════════════════════\n');
});

process.on('SIGTERM', () => {
    console.log('\n[System] SIGTERM recibido. Apagando V8...');
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    console.log('\n[System] SIGINT recibido. Apagando V8...');
    server.close(() => process.exit(0));
});
