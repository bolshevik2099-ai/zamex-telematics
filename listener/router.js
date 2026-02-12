/**
 * Data Router - Routes telemetry data to client's Supabase database
 */

const { createClient } = require('@supabase/supabase-js');

class DataRouter {
    constructor(masterSupabase) {
        this.masterSupabase = masterSupabase;
        this.clientCache = new Map(); // Cache client credentials by IMEI
    }

    /**
     * Validate device and get client credentials from vista_maestra_dispositivos
     * @param {string} imei - Device IMEI
     * @returns {Promise<Object|null>} - Client configuration or null if not found
     */
    async validateDevice(imei) {
        try {
            // Check cache first
            if (this.clientCache.has(imei)) {
                console.log(`[Router] Using cached credentials for IMEI: ${imei}`);
                return this.clientCache.get(imei);
            }

            // Query master database
            const { data, error } = await this.masterSupabase
                .from('vista_maestra_dispositivos')
                .select('*')
                .eq('imei', imei)
                .single();

            if (error) {
                console.error(`[Router] Error querying master DB for IMEI ${imei}:`, error.message);
                return null;
            }

            if (!data) {
                console.warn(`[Router] Device not found in master DB: ${imei}`);
                return null;
            }

            // Validate client has Supabase configuration
            if (!data.supabase_url_destino || !data.supabase_service_key_destino) {
                console.warn(`[Router] Client "${data.cliente}" has no Supabase configuration`);
                return null;
            }

            const clientConfig = {
                imei: data.imei,
                unidad: data.unidad,
                cliente: data.cliente,
                supabaseUrl: data.supabase_url_destino,
                supabaseKey: data.supabase_service_key_destino
            };

            // Cache for 5 minutes
            this.clientCache.set(imei, clientConfig);
            setTimeout(() => this.clientCache.delete(imei), 5 * 60 * 1000);

            console.log(`[Router] Device validated: ${imei} -> Client: ${data.cliente}`);
            return clientConfig;
        } catch (error) {
            console.error('[Router] Unexpected error in validateDevice:', error);
            return null;
        }
    }

    /**
     * Route telemetry records to client's Supabase
     * @param {Object} clientConfig - Client configuration from validateDevice
     * @param {Array} records - Parsed telemetry records
     * @returns {Promise<Boolean>} - Success status
     */
    async routeData(clientConfig, records) {
        try {
            // Create Supabase client for this specific customer
            const clientSupabase = createClient(
                clientConfig.supabaseUrl,
                clientConfig.supabaseKey
            );

            // Transform records to match client's telemetria table schema
            const telemetriaRecords = records.map(record => ({
                imei: clientConfig.imei,
                recorded_at: record.recorded_at,
                latitude: record.latitude,
                longitude: record.longitude,
                speed: record.speed,
                angle: record.angle,
                satellites: record.satellites,
                altitude: record.altitude,
                event_id: record.event_id,
                priority: record.priority,
                io_elements: record.io_elements
            }));

            // Insert into client's telemetria table
            const { data, error } = await clientSupabase
                .from('telemetria')
                .insert(telemetriaRecords);

            if (error) {
                console.error(`[Router] Error inserting data for client ${clientConfig.cliente}:`, error.message);
                return false;
            }

            console.log(`[Router] ✓ Inserted ${telemetriaRecords.length} records for ${clientConfig.cliente} (IMEI: ${clientConfig.imei})`);
            return true;
        } catch (error) {
            console.error('[Router] Unexpected error in routeData:', error);
            return false;
        }
    }

    /**
     * Clear all cached credentials
     */
    clearCache() {
        this.clientCache.clear();
        console.log('[Router] Cache cleared');
    }
}

module.exports = DataRouter;
