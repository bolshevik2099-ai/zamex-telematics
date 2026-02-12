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

    // Handle incoming data
    socket.on('data', async (chunk) => {
        try {
            dataBuffer = Buffer.concat([dataBuffer, chunk]);

            // STEP 1: IMEI Authentication (first message from device)
            if (!deviceIMEI) {
                if (dataBuffer.length < 17) {
                    // Not enough data yet, wait for more
                    return;
                }

                deviceIMEI = TeltonikaParser.parseIMEI(dataBuffer);

                if (!deviceIMEI) {
                    console.error(`[Server] Invalid IMEI from ${clientAddress}`);
                    socket.write(Buffer.from([0x00])); // Reject
                    socket.end();
                    return;
                }

                console.log(`[Server] 📱 Device identified: ${deviceIMEI}`);

                // Validate device in master database
                clientConfig = await router.validateDevice(deviceIMEI);

                if (!clientConfig) {
                    console.warn(`[Server] ⚠️  Device ${deviceIMEI} not authorized or client not configured`);
                    socket.write(Buffer.from([0x00])); // Reject
                    socket.end();
                    return;
                }

                // Accept connection
                socket.write(Buffer.from([0x01])); // Accept
                console.log(`[Server] ✓ IMEI accepted, routing to client: ${clientConfig.cliente}`);

                // Clear buffer after IMEI processing
                dataBuffer = Buffer.alloc(0);
                return;
            }

            // STEP 2: AVL Data Processing
            // Check if we have enough data (at least header)
            if (dataBuffer.length < 12) {
                return; // Wait for more data
            }

            // Parse AVL data
            const avlData = TeltonikaParser.parseAVLData(dataBuffer);

            if (!avlData || avlData.records.length === 0) {
                console.warn(`[Server] Failed to parse AVL data from ${deviceIMEI}`);
                socket.write(TeltonikaParser.createACK(0));
                dataBuffer = Buffer.alloc(0);
                return;
            }

            console.log(`[Server] 📊 Received ${avlData.numberOfRecords} records from ${deviceIMEI}`);

            // Route data to client's Supabase
            const success = await router.routeData(clientConfig, avlData.records);

            // Send ACK to device
            const recordsToAck = success ? avlData.numberOfRecords : 0;
            socket.write(TeltonikaParser.createACK(recordsToAck));

            if (success) {
                console.log(`[Server] ✓ ACK sent: ${recordsToAck} records`);
            } else {
                console.error(`[Server] ❌ Failed to route data, ACK sent: 0`);
            }

            // Clear buffer after processing
            dataBuffer = Buffer.alloc(0);

        } catch (error) {
            console.error(`[Server] Error processing data from ${deviceIMEI || clientAddress}:`, error);
            socket.write(TeltonikaParser.createACK(0));
            dataBuffer = Buffer.alloc(0);
        }
    });

    // Handle socket errors
    socket.on('error', (error) => {
        console.error(`[Server] Socket error for ${deviceIMEI || clientAddress}:`, error.message);
    });

    // Handle socket close
    socket.on('close', () => {
        console.log(`[Server] 🔌 Connection closed: ${deviceIMEI || clientAddress}\n`);
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
