'use strict';
/**
 * ZAMEX Telematics - Data Router
 *
 * Responsibilities:
 *   1. Validate a GPS device IMEI against the master Supabase view
 *      `vista_maestra_dispositivos` and return its client config.
 *   2. Insert parsed telemetry records into the client's own Supabase
 *      `telemetria` table.
 *   3. Cache device credentials in memory for 5 minutes to avoid
 *      hammering the master DB on every AVL packet.
 */

const { createClient } = require('@supabase/supabase-js');

class DataRouter {

    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} masterSupabase
     */
    constructor(masterSupabase) {
        this.master = masterSupabase;
        /** @type {Map<string, {imei, unidad, cliente, supabaseUrl, supabaseKey}>} */
        this.cache = new Map();
    }

    // ─── DEVICE VALIDATION ───────────────────────────────────────────────────

    /**
     * Looks up a device by IMEI in the master DB.
     * Returns a client config object on success, or null if not found / error.
     *
     * @param {string} imei
     * @returns {Promise<{imei, unidad, cliente, supabaseUrl, supabaseKey}|null>}
     */
    async validateDevice(imei) {
        // ── Cache hit ──────────────────────────────────────────────────────
        if (this.cache.has(imei)) {
            console.log(`[Router] Using cached credentials for IMEI: ${imei}`);
            return this.cache.get(imei);
        }

        // ── DB lookup ──────────────────────────────────────────────────────
        try {
            const { data, error } = await this.master
                .from('vista_maestra_dispositivos')
                .select('imei, unidad, cliente, supabase_url_destino, supabase_service_key_destino')
                .eq('imei', imei)
                .single();

            if (error) {
                console.error(`[Router] DB error for IMEI ${imei}:`, error.message);
                return null;
            }
            if (!data) {
                console.warn(`[Router] Device not found: ${imei}`);
                return null;
            }
            if (!data.supabase_url_destino || !data.supabase_service_key_destino) {
                console.warn(`[Router] Client "${data.cliente}" has no Supabase config`);
                return null;
            }

            const config = {
                imei: data.imei,
                unidad: data.unidad,
                cliente: data.cliente,
                supabaseUrl: data.supabase_url_destino,
                supabaseKey: data.supabase_service_key_destino,
            };

            // Cache for 5 minutes
            this.cache.set(imei, config);
            setTimeout(() => this.cache.delete(imei), 5 * 60 * 1000);

            console.log(`[Router] Device validated: ${imei} -> Client: ${data.cliente}`);
            return config;

        } catch (e) {
            console.error('[Router] Unexpected error in validateDevice:', e.message);
            return null;
        }
    }

    // ─── DATA INSERTION ──────────────────────────────────────────────────────

    /**
     * Inserts an array of parsed AVL records into the client's Supabase.
     *
     * @param {{ imei, unidad, cliente, supabaseUrl, supabaseKey }} config
     * @param {Array<Object>} records  - Parsed records from TeltonikaParser
     * @returns {Promise<boolean>}
     */
    async routeData(config, records) {
        if (!records || records.length === 0) return false;
        try {
            const supabase = createClient(config.supabaseUrl, config.supabaseKey);

            const rows = records.map(r => ({
                imei: config.imei,
                recorded_at: r.recorded_at,
                latitude: r.latitude,
                longitude: r.longitude,
                speed: r.speed,
                angle: r.angle,
                satellites: r.satellites,
                altitude: r.altitude,
                event_id: r.event_id,
                priority: r.priority,
                io_elements: r.io_elements,
            }));

            const { error } = await supabase.from('telemetria').insert(rows);

            if (error) {
                console.error(`[Router] Insert error for ${config.cliente}:`, error.message);
                return false;
            }

            console.log(`[Router] ✓ Inserted ${rows.length} records for ${config.cliente} (IMEI: ${config.imei})`);
            return true;

        } catch (e) {
            console.error('[Router] Unexpected error in routeData:', e.message);
            return false;
        }
    }
}

module.exports = DataRouter;
