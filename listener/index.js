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
            // 1. ESCUDO DE MEMORIA: Evitar saturación por datos duplicados
            if (dataBuffer.length > 10000) {
                console.log("[Server] ⚠️ Buffer saturado, purgando...");
                dataBuffer = Buffer.alloc(0);
            }

            dataBuffer = Buffer.concat([dataBuffer, chunk]);

            if (isProcessing) return;
            isProcessing = true;

            // 2. BUCLE DE PROCESAMIENTO SEGURO
            while (dataBuffer.length >= 15) {
                if (!deviceIMEI) {
                    // Identificación de IMEI (Protocolo Teltonika: 2 bytes longitud + IMEI)
                    if (dataBuffer.length < 17) break;

                    // Extraer IMEI (usando el parser robusto)
                    const imeiStr = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!imeiStr) {
                        console.error(`[Server] ❌ Invalid IMEI format from ${clientAddress}. Purgando.`);
                        dataBuffer = Buffer.alloc(0);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    deviceIMEI = imeiStr;

                    // Responder ACK 01 inmediatamente para validar conexión
                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server] ✅ IMEI Identificado: ${deviceIMEI}`);

                    // Validar dispositivo y obtener configuración del cliente
                    clientConfig = await router.validateDevice(deviceIMEI);
                    if (!clientConfig) {
                        console.warn(`[Server] ⚠️  Device ${deviceIMEI} not authorized`);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    dataBuffer = dataBuffer.slice(17);
                } else {
                    // Procesamiento de datos AVL
                    try {
                        // Llamar al parser con try-catch interno
                        const avlData = TeltonikaParser.parseAVLData(dataBuffer);

                        if (avlData && avlData.records && avlData.records.length > 0) {
                            console.log(`[Server] 📊 Procesando ${avlData.records.length} registros para ${deviceIMEI}...`);

                            // Guardar en Supabase (con protección de error)
                            await router.routeData(clientConfig, avlData.records).catch(e =>
                                console.error("[Router] ❌ Error en Supabase:", e.message)
                            );

                            // ENVIAR ACK: Clave para que el GPS deje de mandar el mismo paquete
                            socket.write(TeltonikaParser.createACK(avlData.numberOfRecords));
                            console.log(`[Server] ✓ ACK enviado: ${avlData.numberOfRecords} registros`);
                        }
                    } catch (parseError) {
                        console.error(`[Parser] ⚠️ Error de offset/longitud en ${deviceIMEI}. Purgando buffer.`);
                    }

                    // PURGA FINAL: Pase lo que pase, vaciamos el buffer para evitar el bucle de SIGTERM
                    dataBuffer = Buffer.alloc(0);
                    break;
                }
            }
        } catch (globalError) {
            console.error(`[Server] ❌ Error crítico evitado para ${deviceIMEI || clientAddress}:`, globalError.message);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    });

    socket.on('error', (err) => {
        console.error(`[Server] 🔌 Error de Socket (${deviceIMEI || clientAddress}): ${err.message}`);
        dataBuffer = Buffer.alloc(0);
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
