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
    console.log(`\n[Server] 🔌 Connection attempt from ${clientAddress}`);

    let deviceIMEI = null;
    let clientConfig = null;
    let dataBuffer = Buffer.alloc(0);
    let isProcessing = false;

    // Set socket timeout (2 minutes)
    socket.setTimeout(120000);
    socket.on('timeout', () => {
        console.log(`[Server] ⏳ Timeout: ${deviceIMEI || clientAddress}`);
        socket.destroy();
    });

    // Handle incoming data
    socket.on('data', async (chunk) => {
        try {
            // 1. ESCUDO DE MEMORIA: Prevenir saturación si el buffer se sale de control
            if (dataBuffer.length > 50000) {
                console.warn(`[Server] ⚠️ Buffer overflow detectado (${dataBuffer.length} bytes). Reseteando.`);
                dataBuffer = Buffer.alloc(0);
            }

            // Concatenar datos recibidos
            dataBuffer = Buffer.concat([dataBuffer, chunk]);

            // Log de entrada para saber que el GPS está intentando algo
            const hex = chunk.slice(0, 16).toString('hex');
            console.log(`[Server] 📥 Received ${chunk.length} bytes from ${deviceIMEI || clientAddress}: ${hex}...`);

            if (isProcessing) return;
            isProcessing = true;

            // 2. BUCLE DE PROCESAMIENTO ELÁSTICO
            while (dataBuffer.length >= 15) {
                if (!deviceIMEI) {
                    // Protocolo Teltonika Handshake: 2 bytes longitud (00 0F) + 15 bytes IMEI
                    if (dataBuffer.length < 17) break; // Esperar a tener el IMEI completo

                    const imeiStr = TeltonikaParser.parseIMEI(dataBuffer);

                    if (!imeiStr) {
                        console.error(`[Server] ❌ IMEI Inválido o desconocido de ${clientAddress}. Packet: ${dataBuffer.slice(0, 17).toString('hex')}`);
                        dataBuffer = Buffer.alloc(0);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    deviceIMEI = imeiStr;
                    console.log(`[Server] 📱 Device identified: ${deviceIMEI}`);

                    // Validar en Supabase
                    clientConfig = await router.validateDevice(deviceIMEI);

                    if (!clientConfig) {
                        console.warn(`[Server] ⚠️  Device ${deviceIMEI} no autorizado`);
                        socket.write(Buffer.from([0x00]));
                        socket.destroy();
                        break;
                    }

                    // Aceptar conexión
                    socket.write(Buffer.from([0x01]));
                    console.log(`[Server] ✓ IMEI aceptado: ${deviceIMEI}`);

                    dataBuffer = dataBuffer.slice(17);
                    // Continuar con el resto de los datos si los hay
                } else {
                    // PROCESAMIENTO DE REGISTROS AVL
                    try {
                        // Primero, validar que el buffer tenga al menos el encabezado de datos (12 bytes)
                        if (dataBuffer.length < 12) break;

                        const preamble = dataBuffer.readUInt32BE(0);
                        if (preamble !== 0) {
                            console.warn(`[Server] 🔄 Perdimos sincronía con ${deviceIMEI}. Buscando 00000000...`);
                            let syncPos = -1;
                            for (let i = 1; i <= dataBuffer.length - 4; i++) {
                                if (dataBuffer.readUInt32BE(i) === 0) {
                                    syncPos = i;
                                    break;
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

                        // CRÍTICO: Si el paquete está incompleto, NO VACIAMOS EL BUFFER.
                        // Solo salimos del bucle para esperar a la siguiente llegada de datos.
                        if (dataBuffer.length < totalLength) {
                            console.log(`[Server] ⏳ Paquete parcial (${dataBuffer.length}/${totalLength}). Esperando resto...`);
                            break;
                        }

                        // Extraer paquete completo
                        const packet = dataBuffer.slice(0, totalLength);
                        dataBuffer = dataBuffer.slice(totalLength);

                        const avlData = TeltonikaParser.parseAVLData(packet);

                        if (avlData && avlData.records && avlData.records.length > 0) {
                            console.log(`[Server] 📊 ${deviceIMEI}: Procesando ${avlData.numberOfRecords} registros`);

                            // Guardar en Supabase (Inmune a fallos de red/db)
                            await router.routeData(clientConfig, avlData.records).catch(e =>
                                console.error(`[Router] ❌ Error enviando a Supabase para ${deviceIMEI}:`, e.message)
                            );

                            // Responder ACK
                            socket.write(TeltonikaParser.createACK(avlData.numberOfRecords));
                            console.log(`[Server] ✅ ACK enviado (${avlData.numberOfRecords}) para ${deviceIMEI}`);
                        } else {
                            console.warn(`[Parser] ⚠️ Datos inválidos de ${deviceIMEI}. Saltando.`);
                            socket.write(TeltonikaParser.createACK(0));
                        }
                    } catch (parseError) {
                        console.error(`[Server] ⚠️ Error crítico de lectura en ${deviceIMEI}:`, parseError.message);
                        dataBuffer = Buffer.alloc(0); // Último recurso: limpiar si falla todo
                        break;
                    }
                }
            }
        } catch (globalError) {
            console.error(`[Server] ❌ Error fuera de control para ${deviceIMEI || clientAddress}:`, globalError.message);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    });

    socket.on('error', (err) => {
        console.error(`[Server] 🔌 Error de Socket (${deviceIMEI || clientAddress}): ${err.message}`);
    });

    socket.on('close', () => {
        if (deviceIMEI) console.log(`[Server] 🔌 Conexión cerrada: ${deviceIMEI}`);
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - TELTONIKA ULTRA-LISTENER V3');
    console.log('  MODO: RESCATE FINAL (ELASTIC SHIELD ACTIVE)');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  🚀 TCP Server running on port ${PORT}`);
    console.log(`  🗄️  Master DB: ${SUPABASE_URL}`);
    console.log(`  📡 Waiting for Teltonika devices...`);
    console.log('═══════════════════════════════════════════════════\n');
});

// Shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
