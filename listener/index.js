/**
 * Zamex Telematics - Teltonika TCP ULTRA-LISTENER V3
 * Main server entry point - EMERGENCY RESCUE VERSION
 */

require('dotenv').config();
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

// Configuration
const PORT = process.env.PORT || 5027;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

// Initialize Master Supabase (Zamex)
const masterSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Initialize Router
const router = new DataRouter(masterSupabase);

// Create TCP Server
const server = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Server] 🔌 New connection from ${clientAddress}`);

    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.alloc(0);
    let isProcessing = false;

    // Set socket timeout (disconnect if no data for 2 minutes)
    socket.setTimeout(120000);
    socket.on('timeout', () => {
        console.log(`[Server] ⏳ Connection timeout: ${deviceIMEI || clientAddress}`);
        socket.destroy();
    });

    // Handle incoming data
    socket.on('data', async (chunk) => {
        try {
            // 1. Concatenar solo una vez y dentro del try/catch global
            dataBuffer = Buffer.concat([dataBuffer, chunk]);

            // 2. Solo procesar si no hay otra tarea activa
            if (isProcessing) return;
            isProcessing = true;

            // 3. Bucle de procesamiento (Mínimo 15 bytes para un mensaje válido)
            while (dataBuffer.length >= 15) {
                if (!deviceIMEI) {
                    // Esperar a tener al menos 17 bytes para el handshake de IMEI
                    if (dataBuffer.length < 17) break;

                    deviceIMEI = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!deviceIMEI) {
                        console.error(`[Server] ❌ Invalid IMEI from ${clientAddress}. Clearing junk.`);
                        dataBuffer = Buffer.alloc(0);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    console.log(`[Server] 📱 Device identified: ${deviceIMEI}`);
                    clientConfig = await router.validateDevice(deviceIMEI);

                    if (!clientConfig) {
                        console.warn(`[Server] ⚠️  Device ${deviceIMEI} not authorized`);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    // Handshake Success
                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server] ✓ IMEI accepted: ${deviceIMEI}`);

                    // Quitar los 17 bytes del IMEI del buffer
                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Lógica de AVL (Protegida contra errores de offset/parsing)
                    try {
                        // Primero validamos si hay un preámbulo correcto (00 00 00 00)
                        const preamble = dataBuffer.readUInt32BE(0);
                        if (preamble !== 0) {
                            console.warn(`[Server] 🔄 Resyncing buffer for ${deviceIMEI}...`);
                            let syncPos = -1;
                            for (let i = 1; i <= dataBuffer.length - 4; i++) {
                                if (dataBuffer.readUInt32BE(i) === 0) {
                                    syncPos = i;
                                    break;
                                }
                            }
                            if (syncPos !== -1) {
                                dataBuffer = dataBuffer.slice(syncPos);
                                continue; // Re-intentar con el buffer alineado
                            } else {
                                dataBuffer = Buffer.alloc(0); // No hay sync, limpiar todo
                                break;
                            }
                        }

                        // Calcular longitud esperada
                        const dataLength = dataBuffer.readUInt32BE(4);
                        const totalLength = dataLength + 12;

                        if (dataBuffer.length < totalLength) {
                            console.log(`[Server] ⏳ ESPERANDO: ${dataBuffer.length}/${totalLength} bytes...`);
                            break; // Esperar a que llegue el resto
                        }

                        // Extraer paquete completo
                        const packet = dataBuffer.slice(0, totalLength);

                        // Parseo con aislamiento interno
                        const avlData = TeltonikaParser.parseAVLData(packet);

                        if (avlData && avlData.records && avlData.records.length > 0) {
                            console.log(`[Server] 📊 ${deviceIMEI}: Procesando ${avlData.numberOfRecords} registros`);
                            const success = await router.routeData(clientConfig, avlData.records);

                            // Responder ACK (4 bytes)
                            socket.write(TeltonikaParser.createACK(success ? avlData.numberOfRecords : 0));
                            console.log(`[Server] ✅ ACK enviado (${avlData.numberOfRecords}) para ${deviceIMEI}`);
                        } else {
                            console.warn(`[Parser] ⚠️ Paquete vacío o inválido de ${deviceIMEI}. ACK 0.`);
                            socket.write(TeltonikaParser.createACK(0));
                        }

                        // IMPORTANTE: Limpiar el paquete procesado del buffer
                        dataBuffer = dataBuffer.slice(totalLength);

                    } catch (parseError) {
                        console.error(`[Server] ⚠️ Error en Parser para ${deviceIMEI}:`, parseError.message);
                        dataBuffer = Buffer.alloc(0); // Limpieza de emergencia para desbloquear
                        break;
                    }
                }
            }
        } catch (globalError) {
            console.error(`[Server] ❌ Error Crítico en Socket (${deviceIMEI || clientAddress}):`, globalError.message);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    });

    socket.on('error', (error) => {
        console.error(`[Server] 💥 Error de red (${deviceIMEI || clientAddress}):`, error.message);
    });

    socket.on('close', () => {
        console.log(`[Server] 🔌 Conexión cerrada: ${deviceIMEI || clientAddress}`);
    });
});

// Handle server errors
server.on('error', (error) => {
    console.error('[Server] Server error:', error);
    process.exit(1);
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - TELTONIKA ULTRA-LISTENER V3');
    console.log('  MODO: RESCATE (RECORDS ISOLATION + BUFFER SHIELD)');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  🚀 TCP Server running on port ${PORT}`);
    console.log(`  🗄️  Master DB: ${SUPABASE_URL}`);
    console.log(`  📡 Waiting for Teltonika devices...`);
    console.log('═══════════════════════════════════════════════════\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n[Server] SIGTERM received, shutting down gracefully...');
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('\n[Server] SIGINT received, shutting down gracefully...');
    server.close(() => process.exit(0));
});
