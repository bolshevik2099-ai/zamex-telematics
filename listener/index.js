'use strict';
/**
 * ZAMEX Telematics - Teltonika TCP Listener  ///  V9 CLEAN
 *
 * Architecture: Smart Multiplexer on a single port
 * ┌──────────────────────────────────────────────────────┐
 * │  PORT (process.env.PORT || 5027)                     │
 * │  Every TCP connection enters the Multiplexer.        │
 * │                                                      │
 * │  First byte == ASCII letter? → HTTP Health Check OK  │
 * │  First byte == 0x00?         → Teltonika TCP Handler │
 * │  Anything else?              → Drop                  │
 * └──────────────────────────────────────────────────────┘
 *
 * Teltonika TCP flow:
 *   1. Device sends 17-byte IMEI packet  [2b length][15b IMEI]
 *   2. Server responds: 0x01 (accept) immediately
 *   3. Server validates IMEI in Supabase asynchronously
 *      (while waiting, the socket listener is already active
 *       to prevent race-condition data loss)
 *   4. Device sends AVL data packets
 *   5. Server sends 4-byte ACK = number of records declared by device
 *      (using originalCount, not records.length, to prevent re-send loops)
 *   6. Server inserts records into client Supabase in background (fire-and-forget)
 *   7. Repeat step 4-6 for each batch
 */

require('dotenv').config();
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

// ── Environment ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5027;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[Startup] ❌ SUPABASE_URL or SUPABASE_SERVICE_KEY is missing. Exiting.');
    process.exit(1);
}

const masterSupabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const router = new DataRouter(masterSupabase);

// ── Teltonika connection handler ─────────────────────────────────────────────

/**
 * Handles a validated Teltonika TCP connection.
 * Called by the multiplexer after the first byte confirms Teltonika traffic.
 *
 * @param {net.Socket} socket
 * @param {Buffer}     firstChunk - The chunk that triggered detection (starts with 0x00)
 * @param {string}     remoteAddr - "IP:port" string for logging
 */
function handleTeltonika(socket, firstChunk, remoteAddr) {

    // ── Socket tuning ──────────────────────────────────────────────────────
    socket.setNoDelay(true);                // Disable Nagle — ACKs must leave instantly
    socket.setKeepAlive(true, 30_000);      // Keep the link alive between batches
    socket.setTimeout(120_000);             // Drop silent connections after 2 minutes

    // ── State ──────────────────────────────────────────────────────────────
    let imei = null;
    let clientCfg = null;
    let buf = Buffer.alloc(0);
    let busy = false;               // Async mutex — prevents concurrent pump() runs

    console.log(`[TCP] 📡 Teltonika connection from ${remoteAddr} (${firstChunk.length} bytes)`);

    // ── Data pump (async state machine) ───────────────────────────────────
    /**
     * Drains buf byte-by-byte in a loop.
     * The isProcessing flag ensures only one instance runs at a time,
     * even when socket.on('data') fires while an await is pending.
     */
    const pump = async () => {
        if (busy) return;
        busy = true;
        try {
            await _drain();
        } finally {
            busy = false;
        }
    };

    const _drain = async () => {
        while (true) {

            // ── Phase 1: IMEI handshake ──────────────────────────────────
            if (!imei) {
                if (buf.length < 17) break; // Wait for complete IMEI packet

                const parsed = TeltonikaParser.parseIMEI(buf);
                if (!parsed) {
                    console.warn(`[TCP] ❌ Invalid IMEI from ${remoteAddr}. Dropping.`);
                    socket.write(Buffer.from([0x00])); // Reject
                    socket.destroy();
                    return;
                }

                imei = parsed;
                console.log(`[TCP] 📱 IMEI: ${imei}`);

                // ⚡ Respond IMMEDIATELY before any async work
                socket.write(Buffer.from([0x01]));
                console.log(`[TCP] ✅ Handshake sent to ${imei}`);

                // Now validate asynchronously — socket.on('data') is already
                // registered below so no bytes will be lost during this await
                clientCfg = await router.validateDevice(imei);

                if (!clientCfg) {
                    console.warn(`[TCP] ⛔ Device rejected: ${imei}`);
                    socket.destroy();
                    return;
                }

                buf = buf.slice(17); // Consume IMEI packet from buffer
                continue;            // Immediately check if AVL data already arrived
            }

            // ── Phase 2: AVL data packets ────────────────────────────────
            if (buf.length < 12) break; // Minimum header size

            // Preamble MUST be 4 zero bytes — resync if corrupted
            const preamble = buf.readUInt32BE(0);
            if (preamble !== 0) {
                const syncAt = _findNextPreamble(buf);
                if (syncAt > 0) {
                    console.warn(`[TCP] 🔄 Skipping ${syncAt} noise bytes — resyncing`);
                    buf = buf.slice(syncAt);
                } else {
                    console.warn(`[TCP] 🗑️ No valid preamble found — clearing buffer`);
                    buf = Buffer.alloc(0);
                }
                continue;
            }

            // Total expected packet size: Preamble(4) + Length(4) + Data(N) + CRC(4)
            const dataLen = buf.readUInt32BE(4);
            const totalLength = 4 + 4 + dataLen + 4;

            if (buf.length < totalLength) {
                // Partial packet — wait for more chunks
                break;
            }

            // Extract exactly one packet from the buffer
            const packet = buf.slice(0, totalLength);
            buf = buf.slice(totalLength);

            const avl = TeltonikaParser.parseAVLData(packet);

            if (avl && avl.records.length > 0) {
                // ⚡ ACK uses originalCount (what the GPS claimed) — NOT records.length
                // If we ACK less than originalCount, the GPS thinks data was lost
                // and will re-send the entire packet forever.
                const ackCount = avl.originalCount;
                socket.write(TeltonikaParser.buildACK(ackCount));
                console.log(`[TCP] ✓ ACK(${ackCount}) → ${imei}  [parsed: ${avl.records.length}]`);

                // Fire-and-forget: insert in background without blocking the read loop
                router.routeData(clientCfg, avl.records)
                    .then(() => console.log(`[DB]  💾 Saved ${avl.records.length} records for ${clientCfg.cliente}`))
                    .catch(e => console.error(`[DB]  ❌ Insert failed: ${e.message}`));

            } else {
                // Parser returned nothing useful — still ACK 0 so the GPS moves on
                console.warn(`[TCP] ⚠️ Empty or unreadable AVL packet from ${imei}. ACK(0) sent.`);
                socket.write(TeltonikaParser.buildACK(0));
            }
        }
    };

    // ── Socket events ──────────────────────────────────────────────────────
    // IMPORTANT: Register 'data' handler BEFORE calling pump() the first time.
    // This prevents a race condition: if pump() awaits validateDevice() and the
    // GPS sends its AVL payload during that await, the data would be silently
    // discarded if the handler wasn't registered yet.
    socket.on('data', chunk => {
        if (buf.length > 50_000) {
            console.warn(`[TCP] 🚨 Buffer overflow protection triggered for ${imei}. Resetting.`);
            buf = Buffer.alloc(0);
        }
        buf = Buffer.concat([buf, chunk]);
        pump();
    });

    socket.on('timeout', () => {
        console.log(`[TCP] ⏱️ Inactivity timeout for ${imei || remoteAddr}. Closing.`);
        socket.destroy();
    });

    socket.on('error', err => {
        if (err.code !== 'ECONNRESET') {
            console.log(`[TCP] 🔌 Socket error ${imei || remoteAddr}: ${err.message}`);
        }
    });

    socket.on('close', () => {
        console.log(`[TCP] 🔌 Disconnected: ${imei || remoteAddr}`);
    });

    // ── Kick off processing with the first chunk ───────────────────────────
    buf = Buffer.concat([buf, firstChunk]);
    pump();
}

// Helper: find the next 0x00000000 preamble position in buf for resync
function _findNextPreamble(buf) {
    for (let i = 1; i <= buf.length - 4; i++) {
        if (buf.readUInt32BE(i) === 0) return i;
    }
    return -1;
}

// ── Smart Multiplexer ────────────────────────────────────────────────────────

const server = net.createServer(socket => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;

    // Only inspect the very first chunk — then dispatch permanently
    socket.once('data', chunk => {
        if (!chunk || chunk.length === 0) return;

        const b0 = chunk[0];

        if (b0 >= 0x41 && b0 <= 0x5A) {
            // HTTP (GET/POST/etc.) — Railway health check
            socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nZAMEX Teltonika Listener V9 — OK\n');
            socket.end();

        } else if (b0 === 0x00) {
            // Teltonika data (all Teltonika packets start with 0x00)
            handleTeltonika(socket, chunk, remoteAddr);

        } else {
            console.warn(`[Mux] ❓ Unknown traffic from ${remoteAddr} (first byte: 0x${b0.toString(16)}). Dropped.`);
            socket.end();
        }
    });

    socket.on('error', err => {
        if (err.code !== 'ECONNRESET') {
            console.log(`[Mux] Socket error ${remoteAddr}: ${err.message}`);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS — TELTONIKA LISTENER  V9  CLEAN     ');
    console.log('  Smart Multiplexer · Codec 8/8E · Fire-and-Forget DB  ');
    console.log(`  🚀  Listening on port ${PORT}                        `);
    console.log('═══════════════════════════════════════════════════════\n');
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

const shutdown = (sig) => {
    console.log(`\n[System] ${sig} received — shutting down gracefully…`);
    server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
