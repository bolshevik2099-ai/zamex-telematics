'use strict';
require('dotenv').config();
const net = require('net');
const TeltonikaParser = require('./parser');
const DataRouter = require('./router');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 5027;
// Solo inicializamos base de datos si las variables existen (modo seguro/auditoría)
const masterSupabase = process.env.SUPABASE_URL ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
const router = masterSupabase ? new DataRouter(masterSupabase) : null;

const server = net.createServer((socket) => {
    // REGLA DE ORO 3: Keep-Alive y NoDelay (Sin latencia y sin cerrar por nuestra cuenta)
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    let imeiStr = null;
    let clientCfgPromise = null;

    // REGLA DE ORO 1: El Acumulador Maestro
    let buffer = Buffer.alloc(0);

    console.log(`[TCP] 📡 Conexión viva desde: ${socket.remoteAddress}`);

    socket.on('data', (data) => {
        try {
            // Concatenar los fragmentos de red GPRS (1000 bytes + 263 bytes, etc)
            buffer = Buffer.concat([buffer, data]);

            // MANEJO DEL HANDSHAKE (Se espera que el primer paquete sea el IMEI puro)
            if (!imeiStr) {
                // Teltonika IMEI = 2 bytes length + 15 bytes IMEI = 17 bytes totales
                if (buffer.length >= 17) {
                    const handshakeChunk = buffer.slice(0, 17);

                    // Verificamos cabecera de Handshake (0x00 0x0F)
                    if (handshakeChunk[0] === 0x00 && handshakeChunk[1] === 0x0F) {
                        imeiStr = handshakeChunk.toString('ascii', 2, 17);
                        console.log(`[TCP] 📱 IMEI verificado: ${imeiStr}`);

                        // Mandar 0x01 exacto y dejar buffer libre de esos 17 bytes
                        socket.write(Buffer.from([0x01]), 'binary');
                        console.log(`[TCP] ✅ Handshake 0x01 enviado. En espera de datos...`);
                        buffer = buffer.slice(17);

                        // Empezar a validar el dispositivo en DB silenciosamente en el fondo si hay Supabase
                        if (router) {
                            clientCfgPromise = router.validateDevice(imeiStr).catch(() => null);
                        }
                    } else {
                        // Basura en el puerto, se cierra para proteger.
                        socket.end();
                    }
                }
                return; // Cortar aquí y seguir acumulando si no llega a 17 bytes
            }

            // MANEJO DEL PAYLOAD (Si ya pasamos el handshake, procesamos los AVL)
            // Un paquete Teltonika válido *mínimo* debe tener 12 bytes de cabecera/cola para poder medirlo
            while (buffer.length >= 12) {

                // Buscar el preámbulo (Tienen que ser 4 bytes de 0x00)
                if (buffer.readUInt32BE(0) !== 0) {
                    // Si encontramos ruido entre paquetes, recorremos el buffer un byte hacia adelante
                    buffer = buffer.slice(1);
                    continue;
                }

                // REGLA DE ORO 2: Validación Matemática de Tamaño del Paquete (Bytes 4 al 7)
                const dataLength = buffer.readUInt32BE(4);
                // Preámbulo (4) + Data Length (4) + [Payload: dataLength bytes] + CRC (4)
                const totalMandatoryLength = dataLength + 12;

                // ¿Ya recibimos el paquete completo o está fragmentado en la red?
                if (buffer.length < totalMandatoryLength) {
                    // Faltan bytes (ej. solo tenemos 1000 de 1263).
                    // El servidor NO hace nada. Sale del `while` y espera el siguiente evento 'data'.
                    return;
                }

                // >>> ¡SI LLEGAMOS AQUÍ, TENEMOS EL PAQUETE 100% COMPLETO Y MIDE LO QUE DICE MEDIR! <<<

                // Recortamos exactamente el paquete perfecto
                const completePacket = buffer.slice(0, totalMandatoryLength);

                // El acumulador se queda con lo que sobra (por si el GPS mandó dos paquetes pegados)
                buffer = buffer.slice(totalMandatoryLength);

                console.log(`[TCP] 📥 Recepción Perfecta: ${totalMandatoryLength} bytes absolutos ensamblados.`);

                // Extraemos la cuenta de registros con seguridad milimétrica 
                // En Teltonika Codec 8/8E, tras los 8 bytes de cabecera y el byte de Codec (byte 8),
                // el Byte en el índice 9 siempre es el Número Original de Registros.
                const numRecords = completePacket[9];

                // MANDAR ACK INCONTROVERTIBLE (Calculado con base en el byte 9 del paquete perfecto)
                const ack = Buffer.alloc(4);
                ack.writeUInt32BE(numRecords, 0);
                socket.write(ack, 'binary');

                console.log(`[TCP] ✓ ACK ${numRecords} enviado con éxito al GPS. (Socket abierto y respirando)`);

                // Aislar toda inserción en base de datos para no lastimar los tiempos del socket
                if (router) {
                    setImmediate(() => {
                        try {
                            const avl = TeltonikaParser.parseAVLData(completePacket);
                            if (avl && avl.records && avl.records.length > 0 && clientCfgPromise) {
                                clientCfgPromise.then(cfg => {
                                    if (cfg) router.routeData(cfg, avl.records);
                                });
                            }
                        } catch (err) {
                            console.error('[CRÍTICO] Falló el parser asíncrono, pero el ACK TCP está a salvo:', err.message);
                        }
                    });
                }
            } // Fin del while
        } catch (err) {
            console.error('[ERROR] Error atrapado en socket.on(data):', err.message);
        }
    });

    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') console.log(`[Socket Error] ${err.message}`);
    });

    // Dejamos que el GPS cierre o que el KeepAlive detecte muerte limpia
    socket.on('close', () => console.log('[TCP] 🔌 Conexión cerrada (Corte de sesión)'));
});

// ESCUDOS GLOBALES DE AUDITORÍA
process.on('uncaughtException', (err) => console.error('[ALERTA CRÍTICA] Error global:', err.message));
process.on('unhandledRejection', (reason) => console.error('[ALERTA CRÍTICA] Promesa caída global:', reason));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ZAMEXIA: THE MASTER BUFFER (Anti-Fragmentación) activo en puerto ${PORT}`);
});
