/**
 * Zamex Telematics - Teltonika TCP ULTRA-LISTENER V5 (DUAL-PORT)
 * VERSION: TCP for GPS + HTTP for Railway Health Check
 */

require('dotenv').config();
const net = require('net');
const http = require('http'); // Añadido para el Health Check de Railway
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

// 🚀 RUTEO DE PUERTOS VITAL:
// Railway asume que tu app web/HTTP correrá en process.env.PORT.
// Si no responde en ese puerto, te mata con SIGTERM.
// Por otro lado, tus GPS están programados para hablar por el puerto 5027 (TCP).
// SOLUCIÓN: Levantar DOS servidores en el mismo script.
const PORT_HTTP = process.env.PORT || 8080;
const PORT_TCP = parseInt(process.env.TCP_PORT || 5027, 10);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL/KEY');
    process.exit(1);
}

const masterSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const router = new DataRouter(masterSupabase);

// ==========================================
// 1. SERVIDOR HTTP (Escudo Anti-SIGTERM)
// ==========================================
const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Zamex Teltonika Listener is ALIVE and kicking! (V5)\n');
    } else {
        res.writeHead(404);
        res.end();
    }
});

httpServer.listen(PORT_HTTP, '0.0.0.0', () => {
    console.log(`\n[Health Check] 🟢 Servidor HTTP activo en puerto: ${PORT_HTTP}`);
});


// ==========================================
// 2. SERVIDOR TCP (El verdadero recolector)
// ==========================================
const server = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Server TCP] 📡 NUEVA CONEXIÓN DESDE: ${clientAddress}`);

    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.alloc(0);
    let isProcessing = false;

    socket.on('data', async (chunk) => {
        try {
            console.log(`[Server TCP] 📥 Recibidos ${chunk.length} bytes de ${clientAddress}`);

            // Escudo de saturación
            if (dataBuffer.length > 20000) dataBuffer = Buffer.alloc(0);

            dataBuffer = Buffer.concat([dataBuffer, chunk]);

            if (isProcessing) return;
            isProcessing = true;

            // Bucle elástico
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

                    clientConfig = await router.validateDevice(deviceIMEI);
                    if (!clientConfig) {
                        console.warn(`[Server TCP] ⚠️  Rechazado (No autorizado): ${deviceIMEI}`);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server TCP] ✅ Handshake OK para ${deviceIMEI}`);
                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Datos AVL
                    if (dataBuffer.length < 12) break;

                    try {
                        const avlData = TeltonikaParser.parseAVLData(dataBuffer);

                        if (avlData && avlData.records && avlData.records.length > 0) {
                            console.log(`[Server TCP] 📊 Procesando ${avlData.records.length} registros (${deviceIMEI})`);

                            await router.routeData(clientConfig, avlData.records).catch(e =>
                                console.error("[Router Supabase] ❌ Error de Base de Datos:", e.message)
                            );

                            const ack = Buffer.alloc(4);
                            ack.writeUInt32BE(avlData.records.length, 0);
                            socket.write(ack);
                            console.log(`[Server TCP] ✓ ACK ${avlData.records.length} enviado a ${deviceIMEI}`);
                        }
                    } catch (e) {
                        console.error("[Parser TCP] ⚠️ Error leyendo datos, aislando el fallo. Retomando...");
                    }

                    dataBuffer = Buffer.alloc(0);
                    break;
                }
            }
        } catch (err) {
            console.error(`[Server TCP] ❌ Error general (${deviceIMEI}):`, err.message);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    });

    socket.on('error', (e) => console.log(`[TCP Error] 🔌 ${deviceIMEI || clientAddress} -> ${e.message}`));
    socket.on('close', () => console.log(`[TCP Close] 🔌 Desconectado: ${deviceIMEI || clientAddress}`));
});

server.listen(PORT_TCP, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - ULTRA-LISTENER V5 (DUAL-PORT)');
    console.log(`  🚀 GPS TCP  -> PUERTO INTERNO: ${PORT_TCP}`);
    console.log(`  🚀 RAILWAY  -> PUERTO INTERNO: ${PORT_HTTP}`);
    console.log('═══════════════════════════════════════════════════\n');
});

// ==========================================
// 3. APAGADO SEGURO
// ==========================================
const shutdownHandler = () => {
    console.log('\n[System] SIGTERM/SIGINT recibido. Cerrando...');
    httpServer.close();
    server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);
