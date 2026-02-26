/**
 * Zamex Telematics - Teltonika TCP ULTRA-LISTENER V7 (ULTRA-STREAM)
 * VERSION: Zero-Latency Data Pump & Socket Pause/Resume
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
// FUNCIÓN BOMBEO DE FLUJO DE DATOS (ZERO LATENCY)
// ==========================================
function handleTeltonikaConnection(socket, initialChunk, clientAddress) {
    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.alloc(0);

    const pump = async () => {
        try {
            while (dataBuffer.length >= 15) {
                if (!deviceIMEI) {
                    if (dataBuffer.length < 17) break; // Esperar 17 bytes (IMEI Packet)

                    const imeiStr = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!imeiStr) {
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        return; // Fin del flujo
                    }

                    deviceIMEI = imeiStr;
                    console.log(`[Server TCP] 📱 IMEI Identificado: ${deviceIMEI}`);

                    // 🚨 VITAL: Enviar ACK para el IMEI Instantáneamente
                    socket.write(Buffer.from([0x01]));

                    // 🚨 VITAL: Pausamos el socket para no cruzar cables mientras valida en BD
                    socket.pause();
                    clientConfig = await router.validateDevice(deviceIMEI);
                    socket.resume(); // Retoma lectura inmediata

                    if (!clientConfig) {
                        console.warn(`[Server TCP] ⚠️ Rechazado: ${deviceIMEI}`);
                        socket.destroy();
                        return;
                    }

                    // Consumimos el IMEI de la memoria y seguimos el while para el siguiente payload
                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Datos AVL
                    if (dataBuffer.length < 12) break;

                    const preamble = dataBuffer.readUInt32BE(0);
                    if (preamble !== 0) {
                        // Limpieza por ruido en la red
                        let syncPos = -1;
                        for (let i = 1; i <= dataBuffer.length - 4; i++) {
                            if (dataBuffer.readUInt32BE(i) === 0) {
                                syncPos = i; break;
                            }
                        }
                        if (syncPos !== -1) {
                            dataBuffer = dataBuffer.slice(syncPos);
                            continue;
                        } else {
                            dataBuffer = Buffer.alloc(0);
                            break;
                        }
                    }

                    const dataLength = dataBuffer.readUInt32BE(4);
                    const totalLength = dataLength + 12;

                    // Escudo Anti-Desfragmentación (Paquete incompleto)
                    if (dataBuffer.length < totalLength) break;

                    // 🚨 EXTRACCIÓN QUIRÚRGICA: Sacamos exactamente 1 paquete del Buffer
                    const packet = dataBuffer.slice(0, totalLength);
                    dataBuffer = dataBuffer.slice(totalLength);

                    const avlData = TeltonikaParser.parseAVLData(packet);

                    if (avlData && avlData.records && avlData.records.length > 0) {
                        const recordCount = avlData.numberOfRecords || avlData.records.length;

                        // 🚨 VITAL V6.4: Enviar ACK a la velocidad de la luz
                        const ack = Buffer.alloc(4);
                        ack.writeUInt32BE(recordCount, 0);
                        socket.write(ack);
                        console.log(`[Server TCP] ✓ ACK ${recordCount} enviado al instante para ${deviceIMEI}`);

                        // 🚨 Inserción Fire-and-Forget a Supabase, NO bloquea el socket de red
                        router.routeData(clientConfig, avlData.records).catch(e =>
                            console.error("[Router Supabase] ❌ Error de Base de Datos:", e.message)
                        );
                    } else {
                        const ack = Buffer.alloc(4);
                        ack.writeUInt32BE(0, 0);
                        socket.write(ack);
                    }
                }
            }
        } catch (err) {
            console.error(`[Server TCP] ❌ Error general (${deviceIMEI}):`, err.message);
            dataBuffer = Buffer.alloc(0);
        }
    };

    // 🚨 VITAL: EventDriven puro. En cuanto llega un byte, se concatena y se enciende la bomba de procesamiento
    socket.on('data', (chunk) => {
        if (dataBuffer.length > 20000) dataBuffer = Buffer.alloc(0); // Escudo de saturación extrema
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
        pump();
    });

    socket.on('error', (e) => console.log(`[TCP Error] 🔌 ${deviceIMEI || clientAddress} -> ${e.message}`));
    socket.on('close', () => console.log(`[TCP Close] 🔌 Desconectado: ${deviceIMEI || clientAddress}`));

    // Inyectar el chunk inicial del Multiplexador para que encienda la bomba la primera vez
    dataBuffer = Buffer.concat([dataBuffer, initialChunk]);
    pump();
}

// ==========================================
// SERVIDOR MULTIPLEX (HTTP + TCP)
// ==========================================
const server = net.createServer((socket) => {
    // 🚨 VITAL: Desactivar Algoritmo Nagle para que los ACK salgan 1 byte a la vez sin demoras
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);

    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Multiplex] 📡 Nueva conexión en puerta: ${clientAddress}`);

    socket.once('data', (chunk) => {
        if (chunk.length === 0) return;

        const firstByte = chunk[0];
        const isHTTP = firstByte >= 0x41 && firstByte <= 0x5A; // ASCII 'A' a 'Z' (GET, POST, etc)

        if (isHTTP) {
            console.log(`[Health Check] 🟢 Petición HTTP detectada de ${clientAddress}. 200 OK.`);
            const response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nZamex Teltonika Listener V7 (Ultra-Stream) ALIVE\n";
            socket.write(response);
            socket.end();
        } else if (firstByte === 0x00) {
            handleTeltonikaConnection(socket, chunk, clientAddress);
        } else {
            console.warn(`[Multiplex] ❓ Tráfico desconocido (${firstByte.toString(16)}). Bloqueado.`);
            socket.end();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - ULTRA-LISTENER V7 (ULTRA-STREAM)');
    console.log('  MÓDULO: ZERO-LATENCY DATA PUMP ACTIVO');
    console.log(`  🚀 ESCUCHANDO EN PUERTO MAESTRO: ${PORT}`);
    console.log('═══════════════════════════════════════════════════\n');
});

process.on('SIGTERM', () => {
    console.log('\n[System] SIGTERM recibido. Apagando motor V7...');
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    console.log('\n[System] SIGINT recibido. Apagando motor V7...');
    server.close(() => process.exit(0));
});
