'use strict';
/**
 * ZAMEX Telematics - Teltonika TCP Listener  V9.1  (INSTANT-ACK)
 *
 * KEY FIX in V9.1:
 *   In V9.0, we were still `await`-ing router.validateDevice() before
 *   processing AVL data. Even though validateDevice was called AFTER
 *   sending the 0x01 handshake, the GPS had already sent its AVL payload
 *   during that await window and was waiting for a 4-byte ACK.
 *   If validateDevice took >200ms (Supabase latency), the GPS hit
 *   its internal ACK timeout, closed the connection, and the batch
 *   was considered "lost" — leading to retransmission loops.
 *
 *   V9.1 COMPLETELY DECOUPLES GPS ACK FROM SUPABASE:
 *
 *   1. IMEI arrives → 0x01 sent immediately
 *   2. validateDevice() is started as a BACKGROUND PROMISE (no await)
 *   3. GPS sends AVL data → parsed → ACK sent INSTANTLY (0 Supabase dependency)
 *   4. routeData() awaits the background validateDevice promise and inserts
 *
 *   The GPS gets its ACK in microseconds. Supabase gets the data a
 *   few hundred milliseconds later, completely independently.
 */

require('dotenv').config();
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

// ── Environment ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5027;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[Startup] ❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Exiting.');
    process.exit(1);
}

const masterSupabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const router = new DataRouter(masterSupabase);

// ── Teltonika connection handler ──────────────────────────────────────────────
function handleTeltonika(socket, firstChunk, remoteAddr) {

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(120_000);

    let imei = null;
    let clientCfgPromise = null; // Validation runs in background — NOT awaited in main path
    let buf = Buffer.alloc(0);
    let busy = false;

    console.log(`[TCP] 📡 Teltonika from ${remoteAddr} (${firstChunk.length} bytes)`);

    // ── Data pump ──────────────────────────────────────────────────────────
    const pump = async () => {
        if (busy) return;
        busy = true;
        try {
            await _drain();
        } catch (err) {
            console.error(`[TCP] ❌ Pump error (${imei || remoteAddr}): ${err.message}`);
            buf = Buffer.alloc(0);
        } finally {
            busy = false;
        }
    };

    const _drain = async () => {
        while (true) {

            // ── Phase 1: IMEI (17 bytes) ─────────────────────────────────
            if (!imei) {
                if (buf.length < 17) break;

                const parsed = TeltonikaParser.parseIMEI(buf);
                if (!parsed) {
                    console.warn(`[TCP] ❌ Invalid IMEI from ${remoteAddr}`);
                    socket.write(Buffer.from([0x00]));
                    socket.destroy();
                    return;
                }

                imei = parsed;
                console.log(`[TCP] 📱 IMEI: ${imei}`);

                // ⚡ Step 1: Handshake immediately — GPS is waiting for this
                socket.write(Buffer.from([0x01]));
                console.log(`[TCP] ✅ Handshake sent`);

                // ⚡ Step 2: Validation runs in background (NOT awaited here)
                //    AVL data will arrive and be ACK'd instantly in Phase 2
                //    below WITHOUT waiting for this promise to resolve.
                clientCfgPromise = router.validateDevice(imei);

                buf = buf.slice(17); // Remove IMEI bytes
                continue;           // Immediately process any pending AVL data
            }

            // ── Phase 2: AVL packets (instant ACK, no Supabase wait) ──────
            if (buf.length < 12) break;

            // Resync if preamble is corrupted
            const preamble = buf.readUInt32BE(0);
            if (preamble !== 0) {
                const syncAt = _findNextPreamble(buf);
                if (syncAt > 0) {
                    buf = buf.slice(syncAt);
                } else {
                    buf = Buffer.alloc(0);
                }
                continue;
            }

            const dataLen = buf.readUInt32BE(4);
            const totalLength = dataLen + 12;

            if (buf.length < totalLength) break; // Incomplete packet — wait for more

            const packet = buf.slice(0, totalLength);
            buf = buf.slice(totalLength);

            const avl = TeltonikaParser.parseAVLData(packet);

            if (avl && avl.records.length > 0) {

                // ⚡⚡⚡ ACK SENT INSTANTLY — zero dependency on Supabase ⚡⚡⚡
                socket.write(TeltonikaParser.buildACK(avl.originalCount));
                console.log(`[TCP] ✓ ACK(${avl.originalCount}) → ${imei}  [parsed: ${avl.records.length}]`);

                // DB insert runs completely independently in the background
                const recordsCopy = avl.records.slice();
                (async () => {
                    try {
                        const cfg = await clientCfgPromise; // Already resolved by now in most cases
                        if (!cfg) {
                            console.warn(`[DB]  ⛔ No config for ${imei}. ${recordsCopy.length} records lost.`);
                            return;
                        }
                        await router.routeData(cfg, recordsCopy);
                        console.log(`[DB]  💾 Saved ${recordsCopy.length} records for ${cfg.cliente}`);
                    } catch (e) {
                        console.error(`[DB]  ❌ Insert error: ${e.message}`);
                    }
                })();

            } else {
                console.warn(`[TCP] ⚠️ Unreadable AVL from ${imei}. ACK(0).`);
                socket.write(TeltonikaParser.buildACK(0));
            }
        }
    };

    // ── Socket events ──────────────────────────────────────────────────────
    // CRITICAL: registered BEFORE first pump() call to prevent race conditions
    socket.on('data', chunk => {
        if (buf.length > 50_000) {
            console.warn(`[TCP] 🚨 Buffer overflow for ${imei}. Resetting.`);
            buf = Buffer.alloc(0);
        }
        buf = Buffer.concat([buf, chunk]);
        pump();
    });

    socket.on('timeout', () => {
        console.log(`[TCP] ⏱️ Timeout: ${imei || remoteAddr}`);
        socket.destroy();
    });

    socket.on('error', err => {
        if (err.code !== 'ECONNRESET') {
            console.log(`[TCP] 🔌 Error ${imei || remoteAddr}: ${err.message}`);
        }
    });

    socket.on('close', () => {
        console.log(`[TCP] 🔌 Disconnected: ${imei || remoteAddr}`);
    });

    // Kick off with the initial chunk already in hand
    buf = Buffer.concat([buf, firstChunk]);
    pump();
}

function _findNextPreamble(buf) {
    for (let i = 1; i <= buf.length - 4; i++) {
        if (buf.readUInt32BE(i) === 0) return i;
    }
    return -1;
}

// ── Smart Multiplexer (HTTP health check + Teltonika TCP on same port) ────────
const server = net.createServer(socket => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;

    socket.once('data', chunk => {
        if (!chunk || chunk.length === 0) return;
        const b0 = chunk[0];

        if (b0 >= 0x41 && b0 <= 0x5A) {
            // HTTP — Railway health check
            socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nZAMEX Listener V9.1 INSTANT-ACK\n');
            socket.end();
        } else if (b0 === 0x00) {
            // Teltonika
            handleTeltonika(socket, chunk, remoteAddr);
        } else {
            socket.end();
        }
    });

    socket.on('error', err => {
        if (err.code !== 'ECONNRESET') {
            console.log(`[Mux] Error ${remoteAddr}: ${err.message}`);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('══════════════════════════════════════════════════════════');
    console.log('  ZAMEX TELEMATICS — TELTONIKA LISTENER  V9.1  INSTANT-ACK ');
    console.log('  GPS ACK is decoupled from Supabase. Zero-latency confirm. ');
    console.log(`  🚀  Listening on port ${PORT}`);
    console.log('══════════════════════════════════════════════════════════\n');
});

const shutdown = sig => {
    console.log(`\n[System] ${sig} — shutting down.`);
    server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
