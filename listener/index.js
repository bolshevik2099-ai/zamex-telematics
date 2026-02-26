/**
 * Zamex Telematics - Teltonika TCP ULTRA-LISTENER V6 (MULTIPLEX)
 * VERSION: Smart Port Multiplexing (HTTP + TCP on the same port)
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
// FUNCIÓN PRINCIPAL DE PROCESAMIENTO GPS
// ==========================================
function handleTeltonikaConnection(socket, initialChunk, clientAddress) {
    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.from(initialChunk); // Iniciar con el chunk que ya leímos
    let isProcessing = false;

    // Log del primer contacto
    console.log(`[Server TCP] 📥 Recibidos ${initialChunk.length} bytes (Teltonika Payload) de ${clientAddress}`);

    const processBuffer = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            while (dataBuffer.length >= 15) {
                if (!deviceIMEI) {
                    if (dataBuffer.length < 17) break; // Esperar 17 bytes

                    const imeiStr = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!imeiStr) {
                        console.error(`[Server TCP] ❌ IMEI no reconocido de ${clientAddress}. Packet: ${dataBuffer.slice(0, 17).toString('hex')}`);
                        dataBuffer = Buffer.alloc(0);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    deviceIMEI = imeiStr;
                    console.log(`[Server TCP] 📱 IMEI Identificado: ${deviceIMEI}`);

                    // 🚨 VITAL: Responder ACK 0x01 INMEDIATAMENTE para que el GPS no cierre la sesión por timeout!
                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server TCP] ✅ Handshake enviado al momento para ${deviceIMEI}`);

                    clientConfig = await router.validateDevice(deviceIMEI);
                    if (!clientConfig) {
                        console.warn(`[Server TCP] ⚠️  Rechazado (No autorizado): ${deviceIMEI}`);
                        // Ya mandamos 0x01, pero como no está autorizado, cortamos
                        socket.destroy();
                        break;
                    }

                    console.log(`[Server TCP] 🔐 Validación Supabase superada para ${deviceIMEI}`);
                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Datos AVL
                    if (dataBuffer.length < 12) break;

                    try {
                        const preamble = dataBuffer.readUInt32BE(0);
                        if (preamble !== 0) {
                            console.warn(`[Server TCP] 🔄 Resyncing buffer for ${deviceIMEI}...`);
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

                        if (dataBuffer.length < totalLength) {
                            console.log(`[Server TCP] ⏳ Paquete parcial (${dataBuffer.length}/${totalLength}). Esperando resto...`);
                            break; // Salimos sin borrar el buffer, para esperar el resto
                        }

                        // Extraer paquete exacto
                        const packet = dataBuffer.slice(0, totalLength);
                        dataBuffer = dataBuffer.slice(totalLength); // Solo removemos lo procesado

                        const avlData = TeltonikaParser.parseAVLData(packet);

                        if (avlData && avlData.records && avlData.records.length > 0) {
                            console.log(`[Server TCP] 📊 Procesando ${avlData.records.length} registros (${deviceIMEI})`);

                            await router.routeData(clientConfig, avlData.records).catch(e =>
                                console.error("[Router Supabase] ❌ Error de Base de Datos:", e.message)
                            );

                            const ack = Buffer.alloc(4);
                            ack.writeUInt32BE(avlData.numberOfRecords || avlData.records.length, 0);
                            socket.write(ack);
                            console.log(`[Server TCP] ✓ ACK ${avlData.numberOfRecords || avlData.records.length} enviado a ${deviceIMEI}`);
                        } else {
                            console.warn(`[Parser TCP] ⚠️ Datos inválidos de ${deviceIMEI}. Saltando.`);
                            const ack = Buffer.alloc(4);
                            ack.writeUInt32BE(0, 0);
                            socket.write(ack);
                        }
                    } catch (e) {
                        console.error("[Parser TCP] ⚠️ Error leyendo paquete TCP. Corrupción detectada:", e.message);
                        dataBuffer = Buffer.alloc(0);
                        break;
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

    // Procesar el chunk inicial inmediatamente
    processBuffer();

    // Escuchar el resto de chunks
    socket.on('data', async (chunk) => {
        if (dataBuffer.length > 20000) dataBuffer = Buffer.alloc(0);
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
        processBuffer();
    });

    socket.on('error', (e) => console.log(`[TCP Error] 🔌 ${deviceIMEI || clientAddress} -> ${e.message}`));
    socket.on('close', () => console.log(`[TCP Close] 🔌 Desconectado: ${deviceIMEI || clientAddress}`));
}

// ==========================================
// SERVIDOR MULTIPLEX (Escucha TODO en un solo puerto)
// ==========================================
const server = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Multiplex] 📡 Nueva conexión en puerta: ${clientAddress}`);

    // Usamos 'once' para inspeccionar SOLO el primer paquete de datos
    socket.once('data', (chunk) => {
        if (chunk.length === 0) return;

        // Inspeccionar el primer byte del paquete
        const firstByte = chunk[0];

        // HTTP: Empieza con letras legibles (G para GET, P para POST, etc.)
        // Teltonika: Empieza con 0x00 (00 0F para IMEI, 00 00 00 00 para datos)
        const isHTTP = firstByte >= 0x41 && firstByte <= 0x5A; // ASCII 'A' a 'Z'

        if (isHTTP) {
            console.log(`[Health Check] 🟢 Petición HTTP detectada de ${clientAddress}. Respondiendo 200 OK.`);
            const response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nZamex Teltonika Listener V6 ALIVE\n";
            socket.write(response);
            socket.end();
        } else if (firstByte === 0x00) {
            console.log(`[Multiplex] 🛸 Tráfico Teltonika detectado. Enrutando a TCP Handler.`);
            handleTeltonikaConnection(socket, chunk, clientAddress);
        } else {
            console.warn(`[Multiplex] ❓ Tráfico desconocido (Primer byte: ${firstByte.toString(16)}). Cerrando.`);
            socket.end();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - ULTRA-LISTENER V6');
    console.log('  MÓDULO: SMART MULTIPLEX (HTTP + TCP COMBINADO)');
    console.log(`  🚀 ESCUCHANDO EN PUERTO MAESTRO: ${PORT}`);
    console.log('═══════════════════════════════════════════════════\n');
});

const shutdownHandler = () => {
    console.log('\n[System] SIGTERM/SIGINT recibido. Apagando motor...');
    server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);
