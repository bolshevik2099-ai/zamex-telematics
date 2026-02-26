/**
 * Zamex Telematics - Teltonika TCP ULTRA-LISTENER V3.1
 * VERSION: "ELASTIC SHIELD" + NO-TIMEOUT STARTUP
 */

require('dotenv').config();
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

const PORT = process.env.PORT || 5027; // USAMOS EL PUERTO DINÁMICO DE RAILWAY
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL/KEY');
    process.exit(1);
}

const masterSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const router = new DataRouter(masterSupabase);

const server = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Server] 📡 NUEVA CONEXIÓN DESDE: ${clientAddress}`);

    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.alloc(0);
    let isProcessing = false;

    socket.on('data', async (chunk) => {
        try {
            // Log inmediato para saber que llega ALGO
            console.log(`[Server] 📥 Recibidos ${chunk.length} bytes de ${clientAddress}`);

            // 1. Escudo de saturación
            if (dataBuffer.length > 20000) dataBuffer = Buffer.alloc(0);

            dataBuffer = Buffer.concat([dataBuffer, chunk]);

            if (isProcessing) return;
            isProcessing = true;

            // 2. Bucle de procesamiento elástico
            while (dataBuffer.length >= 15) {
                if (!deviceIMEI) {
                    // Esperar handshake (17 bytes: 2 len + 15 imei)
                    if (dataBuffer.length < 17) break;

                    const imeiStr = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!imeiStr) {
                        console.error(`[Server] ❌ IMEI no reconocido. Buffer: ${dataBuffer.slice(0, 17).toString('hex')}`);
                        dataBuffer = Buffer.alloc(0);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    deviceIMEI = imeiStr;
                    console.log(`[Server] 📱 Dispositivo identificado: ${deviceIMEI}`);

                    clientConfig = await router.validateDevice(deviceIMEI);
                    if (!clientConfig) {
                        console.warn(`[Server] ⚠️  No autorizado: ${deviceIMEI}`);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server] ✅ Handshake OK para ${deviceIMEI}`);
                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Datos AVL
                    if (dataBuffer.length < 12) break;

                    try {
                        const avlData = TeltonikaParser.parseAVLData(dataBuffer);

                        if (avlData && avlData.records && avlData.records.length > 0) {
                            console.log(`[Server] 📊 Procesando ${avlData.records.length} registros (${deviceIMEI})`);

                            await router.routeData(clientConfig, avlData.records).catch(e =>
                                console.error("[Router] ❌ Error Supabase:", e.message)
                            );

                            // Mandar ACK (4 bytes con el número de registros)
                            const ack = Buffer.alloc(4);
                            ack.writeUInt32BE(avlData.records.length, 0);
                            socket.write(ack);
                            console.log(`[Server] ✓ ACK enviado: ${avlData.records.length}`);
                        }
                    } catch (e) {
                        console.error("[Parser] ⚠️ Error en paquete, limpiando...");
                    }

                    dataBuffer = Buffer.alloc(0); // Limpia total para evitar bucles de error
                    break;
                }
            }
        } catch (err) {
            console.error("[Server] ❌ Error crítico:", err.message);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    });

    socket.on('error', (e) => console.log(`[Socket Error] ${e.message}`));
    socket.on('close', () => console.log(`[Server] 🔌 Cerrado: ${deviceIMEI || clientAddress}`));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - ULTRA-LISTENER V4');
    console.log(`  🚀 ESCUCHANDO EN PUERTO INTERNO: ${PORT}`);
    console.log('═══════════════════════════════════════════════════\n');
});

process.on('SIGTERM', () => {
    console.log('SIGTERM recibido. Cerrando...');
    server.close(() => process.exit(0));
});
