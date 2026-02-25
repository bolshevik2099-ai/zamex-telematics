/**
 * Zamex Telematics - Teltonika TCP Listener
 * Main server entry point
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
        // Concatenate new data
        dataBuffer = Buffer.concat([dataBuffer, chunk]);

        // Log raw data for debugging
        const hex = chunk.slice(0, 32).toString('hex');
        console.log(`[Server] 📥 Received ${chunk.length} bytes from ${deviceIMEI || clientAddress}: ${hex}${chunk.length > 32 ? '...' : ''}`);

        // If we are already processing, return. The loop handles the new data.
        if (isProcessing) return;
        isProcessing = true;

        try {
            // STEP 1: IMEI Authentication
            if (!deviceIMEI) {
                if (dataBuffer.length < 17) {
                    isProcessing = false;
                    return;
                }

                deviceIMEI = TeltonikaParser.parseIMEI(dataBuffer);

                if (!deviceIMEI) {
                    console.error(`[Server] ❌ Invalid IMEI format from ${clientAddress}. Packet: ${dataBuffer.slice(0, 17).toString('hex')}`);
                    socket.write(Buffer.from([0x00]));
                    socket.destroy();
                    return;
                }

                console.log(`[Server] 📱 Device identified: ${deviceIMEI}`);
                clientConfig = await router.validateDevice(deviceIMEI);

                if (!clientConfig) {
                    console.warn(`[Server] ⚠️  Device ${deviceIMEI} not authorized`);
                    socket.write(Buffer.from([0x00]));
                    socket.destroy();
                    return;
                }

                // Accept connection with 0x01
                socket.write(Buffer.from([0x01]));
                console.log(`[Server] ✓ IMEI accepted: ${deviceIMEI}`);

                // Clear IMEI from buffer
                dataBuffer = dataBuffer.slice(17);
            }

            // STEP 2: AVL Data Processing
            while (dataBuffer.length >= 12) {
                const preamble = dataBuffer.readUInt32BE(0);

                if (preamble !== 0) {
                    console.warn(`[Server] ⚠️  Invalid preamble (0x${preamble.toString(16)}) from ${deviceIMEI}. Searching for sync...`);
                    let foundPreamble = false;
                    for (let i = 1; i <= dataBuffer.length - 12; i++) {
                        if (dataBuffer.readUInt32BE(i) === 0) {
                            console.log(`[Server] 🔄 Sync found! Skipping ${i} bytes.`);
                            dataBuffer = dataBuffer.slice(i);
                            foundPreamble = true;
                            break;
                        }
                    }

                    if (!foundPreamble) {
                        console.log(`[Server] 📡 No sync found in current buffer (${dataBuffer.length} bytes). Waiting...`);
                        if (dataBuffer.length > 4) {
                            dataBuffer = dataBuffer.slice(dataBuffer.length - 3);
                        }
                        break;
                    }
                }

                const dataLength = dataBuffer.readUInt32BE(4);
                const totalLength = dataLength + 12;

                if (dataLength > 10000 || dataLength === 0) {
                    console.error(`[Server] ❌ Junk data detected (length ${dataLength}) from ${deviceIMEI}. Clearing buffer.`);
                    dataBuffer = Buffer.alloc(0);
                    break;
                }

                if (dataBuffer.length < totalLength) {
                    console.log(`[Server] ⏳ Partial packet for ${deviceIMEI}: ${dataBuffer.length}/${totalLength} bytes. Waiting...`);
                    break;
                }

                // Extract and parse
                const packet = dataBuffer.slice(0, totalLength);
                dataBuffer = dataBuffer.slice(totalLength);

                const avlData = TeltonikaParser.parseAVLData(packet);

                if (avlData && avlData.records && avlData.records.length > 0) {
                    console.log(`[Server] 📊 Parsing ${avlData.numberOfRecords} records for ${deviceIMEI}...`);
                    const success = await router.routeData(clientConfig, avlData.records);
                    socket.write(TeltonikaParser.createACK(success ? avlData.numberOfRecords : 0));
                    console.log(`[Server] ${success ? '✅' : '❌'} ACK sent for ${avlData.numberOfRecords} records`);
                } else {
                    console.warn(`[Server] ⚠️  Could not parse records from packet for ${deviceIMEI}`);
                    socket.write(TeltonikaParser.createACK(0));
                }
            }
        } catch (error) {
            console.error(`[Server] 💥 Critical error for ${deviceIMEI || clientAddress}:`, error);
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
        }
    });

    // Handle socket errors
    socket.on('error', (error) => {
        console.error(`[Server] Socket error for ${deviceIMEI || clientAddress}:`, error.message);
    });

    // Handle socket close
    socket.on('close', () => {
        if (deviceIMEI) {
            console.log(`[Server] 🔌 Connection closed: ${deviceIMEI}`);
        } else {
            console.log(`[Server] 🔌 Connection closed before identification (${clientAddress})`);
        }
    });
});

// Handle server errors
server.on('error', (error) => {
    console.error('[Server] Server error:', error);
    process.exit(1);
});

// Start server
server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS - TELTONIKA LISTENER');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  🚀 TCP Server running on port ${PORT}`);
    console.log(`  🗄️  Master DB: ${SUPABASE_URL}`);
    console.log(`  📡 Waiting for Teltonika devices...`);
    console.log('═══════════════════════════════════════════════════\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n[Server] SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n[Server] SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('[Server] Server closed');
        process.exit(0);
    });
});
