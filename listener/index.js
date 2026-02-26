'use strict';
/**
 * ZAMEX Telematics - Teltonika TCP Listener  V10  BARE-MINIMUM
 *
 * Stripped to the protocol essentials:
 *   1. First chunk arrives → parse IMEI → immediately write 0x01
 *   2. Subsequent chunks → accumulate buffer → parse AVL → ACK → DB
 *
 * No state machines. No async pumps. No complexity.
 */

require('dotenv').config();
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');

const PORT = process.env.PORT || 5027;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const masterSupabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const router = new DataRouter(masterSupabase);

// ── Server ────────────────────────────────────────────────────────────────────
const server = net.createServer(socket => {
    socket.setNoDelay(true);

    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    let buf = Buffer.alloc(0);
    let imei = null;
    let clientCfgPromise = null;

    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);

        // ── Step 1: IMEI handshake (first 17 bytes) ─────────────────────
        if (!imei) {
            if (buf.length < 17) return; // wait for complete IMEI packet

            const parsed = TeltonikaParser.parseIMEI(buf);
            if (!parsed) {
                // Not a valid Teltonika IMEI — could be HTTP health check
                const firstByte = buf[0];
                if (firstByte >= 0x41 && firstByte <= 0x5A) {
                    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nZAMEX Listener V10\n');
                }
                socket.end();
                return;
            }

            imei = parsed;
            console.log(`[GPS] IMEI: ${imei} from ${addr}`);

            // Send exactly one byte — the acceptance handshake
            socket.write(Buffer.from([0x01]));
            console.log(`[GPS] 0x01 handshake sent to ${imei}`);

            // Start DB validation in background (no await)
            clientCfgPromise = router.validateDevice(imei)
                .then(cfg => {
                    if (cfg) {
                        console.log(`[GPS] Validated: ${imei} → ${cfg.cliente}`);
                    } else {
                        console.warn(`[GPS] Rejected IMEI: ${imei}`);
                        socket.destroy();
                    }
                    return cfg;
                });

            // Remove IMEI bytes, keep any trailing data
            buf = buf.slice(17);
            if (buf.length === 0) return; // wait for AVL data
        }

        // ── Step 2: AVL packet(s) ────────────────────────────────────────
        while (buf.length >= 12) {
            // Validate preamble (must be 0x00000000)
            if (buf.readUInt32BE(0) !== 0) {
                buf = buf.slice(1); // slide one byte and retry
                continue;
            }

            const dataLen = buf.readUInt32BE(4);
            const totalLength = dataLen + 12; // preamble(4) + length(4) + data + CRC(4)

            if (buf.length < totalLength) return; // wait for more chunks

            const packet = buf.slice(0, totalLength);
            buf = buf.slice(totalLength);

            const avl = TeltonikaParser.parseAVLData(packet);
            if (!avl || avl.records.length === 0) {
                console.warn(`[GPS] Empty/invalid AVL from ${imei}`);
                socket.write(TeltonikaParser.buildACK(0));
                continue;
            }

            // ACK immediately — the only thing the GPS is waiting for
            socket.write(TeltonikaParser.buildACK(avl.originalCount));
            console.log(`[GPS] ACK(${avl.originalCount}) → ${imei}  (${avl.records.length} parsed)`);

            // Insert after ACK, independent of socket state
            clientCfgPromise.then(cfg => {
                if (!cfg) return;
                return router.routeData(cfg, avl.records);
            }).then(ok => {
                if (ok) console.log(`[DB] Saved ${avl.records.length} records`);
            }).catch(e => {
                console.error(`[DB] Error: ${e.message}`);
            });
        }
    });

    socket.on('error', err => {
        if (err.code !== 'ECONNRESET') console.log(`[ERR] ${addr}: ${err.message}`);
    });
    socket.on('close', () => console.log(`[GPS] Disconnected: ${imei || addr}`));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nZAMEX — Teltonika Listener V10 BARE-MINIMUM — port ${PORT}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
