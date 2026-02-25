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

        // If we are already processing a previous chunk, wait
        if (isProcessing) return;
        isProcessing = true;

        // Pause socket while we do async DB work
        socket.pause();

        try {
            // STEP 1: IMEI Authentication
            if (!deviceIMEI) {
                if (dataBuffer.length < 17) {
                    isProcessing = false;
                    socket.resume();
                    return;
                }

                deviceIMEI = TeltonikaParser.parseIMEI(dataBuffer);

                if (!deviceIMEI) {
                    console.error(`[Server] ❌ Invalid IMEI format from ${clientAddress}`);
                    socket.write(Buffer.from([0x00])); // Reject
                    socket.destroy();
                    return;
                }

                console.log(`[Server] 📱 Device identified: ${deviceIMEI}`);
                clientConfig = await router.validateDevice(deviceIMEI);

                if (!clientConfig) {
                    console.warn(`[Server] ⚠️  Device ${deviceIMEI} not authorized`);
                    socket.write(Buffer.from([0x00])); // Reject
                    socket.destroy();
                    return;
                }

                // Accept connection
                socket.write(Buffer.from([0x01])); // Accept
                console.log(`[Server] ✓ IMEI accepted, routing to client: ${clientConfig.cliente}`);

                // Clear IMEI from buffer
                dataBuffer = dataBuffer.slice(17);
            }

            // STEP 2: AVL Data Processing
            while (dataBuffer.length >= 12) {
                // To avoid getting stuck if the buffer gets corrupted, 
                // search for the Teltonika preamble (00 00 00 00)
                const preamble = dataBuffer.readUInt32BE(0);

                if (preamble !== 0) {
                    // We are out of sync. Search for the next 00 00 00 00
                    let foundPreamble = false;
                    for (let i = 1; i <= dataBuffer.length - 12; i++) {
                        if (dataBuffer.readUInt32BE(i) === 0) {
                            console.warn(`[Server] 🔄 Resyncing buffer for ${deviceIMEI}: skipping ${i} bytes`);
                            dataBuffer = dataBuffer.slice(i);
                            foundPreamble = true;
                            break;
                        }
                    }

                    if (!foundPreamble) {
                        // No preamble found in the current buffer, wait for more data but keep the last 3 bytes just in case
                        if (dataBuffer.length > 4) {
                            dataBuffer = dataBuffer.slice(dataBuffer.length - 3);
                        }
                        break;
                    }
                }

                // Now we are (probably) at the start of a packet
                const dataLength = dataBuffer.readUInt32BE(4);
                const totalLength = dataLength + 12; // 8 bytes header + dataLength + 4 bytes CRC

                // Security check for crazy lengths
                if (dataLength > 10000) {
                    console.error(`[Server] ❌ Invalid data length (${dataLength}) from ${deviceIMEI}. Dropping buffer.`);
                    dataBuffer = Buffer.alloc(0);
                    break;
                }

                if (dataBuffer.length < totalLength) {
                    // Partial packet, wait for more
                    break;
                }

                // Extract full packet
                const packet = dataBuffer.slice(0, totalLength);

                // Parse AVL data
                const avlData = TeltonikaParser.parseAVLData(packet);

                if (avlData && avlData.records.length > 0) {
                    console.log(`[Server] 📊 Received ${avlData.numberOfRecords} records from ${deviceIMEI}`);

                    // Route data to client's Supabase
                    const success = await router.routeData(clientConfig, avlData.records);

                    // Send ACK to device
                    const recordsToAck = success ? avlData.numberOfRecords : 0;
                    socket.write(TeltonikaParser.createACK(recordsToAck));

                    if (success) {
                        console.log(`[Server] ✓ ACK sent: ${recordsToAck} records`);
                    } else {
                        console.error(`[Server] ❌ Routing/ACK failure for ${deviceIMEI}`);
                    }
                } else {
                    console.warn(`[Server] ⚠️  Empty or invalid AVL packet from ${deviceIMEI}`);
                    // Even if invalid, we might need to send 0 ACK to keep it alive
                    socket.write(TeltonikaParser.createACK(0));
                }

                // Remove processed packet from buffer
                dataBuffer = dataBuffer.slice(totalLength);
            }

        } catch (error) {
            console.error(`[Server] 💥 Error processing data for ${deviceIMEI || clientAddress}:`, error.message);
            // On severe error, reset buffer
            dataBuffer = Buffer.alloc(0);
        } finally {
            isProcessing = false;
            socket.resume();
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
