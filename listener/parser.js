'use strict';
/**
 * ZAMEX Telematics - Teltonika Protocol Parser
 * Supports: Codec 8 (0x08) and Codec 8 Extended (0x8E)
 *
 * Packet structure (Codec 8):
 *   [4b Preamble=0x00000000][4b DataLen][1b CodecID][1b RecordCount]
 *   [Records...][1b RecordCount2][4b CRC32]
 *
 * IMEI packet:
 *   [2b Length][Nb IMEI string in ASCII]
 */

class TeltonikaParser {

  // ─── IMEI HANDSHAKE ──────────────────────────────────────────────────────

  /**
   * Extracts the IMEI string from the initial 17-byte handshake packet.
   * @param {Buffer} buf - Raw socket buffer (minimum 17 bytes expected)
   * @returns {string|null} 15-digit IMEI string, or null on failure
   */
  static parseIMEI(buf) {
    try {
      if (buf.length < 2) return null;
      const len = buf.readUInt16BE(0);          // 2-byte length prefix
      if (len !== 15) return null;              // IMEI is always 15 digits
      if (buf.length < 2 + len) return null;   // Incomplete packet

      const imei = buf.slice(2, 2 + len).toString('ascii');
      if (!/^\d{15}$/.test(imei)) return null; // Must be 15 numeric digits
      return imei;
    } catch (e) {
      console.error('[Parser] IMEI parse error:', e.message);
      return null;
    }
  }

  // ─── AVL DATA PACKET ─────────────────────────────────────────────────────

  /**
   * Parses a complete Codec 8 / 8E AVL data packet.
   * @param {Buffer} buf - Exact-length packet buffer (preamble to CRC)
   * @returns {{ codecID, originalCount, numberOfRecords, records }|null}
   */
  static parseAVLData(buf) {
    try {
      let offset = 0;

      // Preamble (4 bytes of 0x00)
      if (buf.length < 8) return null;
      const preamble = buf.readUInt32BE(0);
      if (preamble !== 0) {
        console.warn('[Parser] ⚠️ Preamble is not zero:', preamble.toString(16));
        return null;
      }
      offset += 4;

      // Data length (4 bytes) — excludes preamble + length + CRC
      const dataLen = buf.readUInt32BE(offset);
      offset += 4;

      // Codec ID (1 byte)
      const codecID = buf.readUInt8(offset);
      offset += 1;

      if (codecID !== 0x08 && codecID !== 0x8E) {
        console.warn(`[Parser] ⚠️ Unsupported Codec: 0x${codecID.toString(16)}`);
        return null;
      }

      // Number of records (1 byte)
      const originalCount = buf.readUInt8(offset);
      offset += 1;

      const records = [];

      for (let i = 0; i < originalCount; i++) {
        try {
          if (offset + 26 + 5 > buf.length) break; // Not enough bytes for min record
          const result = this._parseRecord(buf, offset, codecID);
          if (!result) break;
          records.push(result.data);
          offset = result.offset;
        } catch (recErr) {
          console.error(`[Parser] Record ${i + 1}/${originalCount} failed: ${recErr.message}`);
          break;
        }
      }

      // Footer record count (1 byte) — should match originalCount
      if (offset < buf.length - 4) {
        const footer = buf.readUInt8(offset);
        if (footer !== originalCount) {
          console.warn(`[Parser] ⚠️ Footer mismatch: header=${originalCount} footer=${footer}`);
        }
        offset += 1;
      }

      // CRC32 (4 bytes — we skip validation for performance but consume the bytes)

      return {
        codecID,
        originalCount,       // What the GPS claimed to send (use this for ACK!)
        numberOfRecords: records.length, // What we actually parsed
        records
      };
    } catch (e) {
      console.error('[Parser] 💥 AVL packet crash:', e.message);
      return null;
    }
  }

  // ─── PRIVATE: SINGLE AVL RECORD ──────────────────────────────────────────

  static _parseRecord(buf, offset, codecID) {
    if (offset + 8 + 1 + 15 > buf.length) throw new Error('Buffer too short for record header');

    const record = {};

    // Timestamp: 8-byte ms since Unix epoch
    const ts = buf.readBigUInt64BE(offset);
    record.recorded_at = new Date(Number(ts)).toISOString();
    offset += 8;

    // Priority: 1 byte
    record.priority = buf.readUInt8(offset);
    offset += 1;

    // GPS element: 15 bytes
    const gps = this._parseGPS(buf, offset);
    Object.assign(record, gps.data);
    offset = gps.offset;

    // IO element: variable length
    const io = this._parseIO(buf, offset, codecID);
    record.io_elements = io.data;
    record.event_id = io.eventID;
    offset = io.offset;

    return { data: record, offset };
  }

  // ─── PRIVATE: GPS ────────────────────────────────────────────────────────

  static _parseGPS(buf, offset) {
    if (offset + 15 > buf.length) throw new Error('Buffer too short for GPS');
    return {
      data: {
        longitude: buf.readInt32BE(offset) / 10_000_000, // 4b
        latitude: buf.readInt32BE(offset + 4) / 10_000_000, // 4b
        altitude: buf.readInt16BE(offset + 8),               // 2b
        angle: buf.readUInt16BE(offset + 10),             // 2b
        satellites: buf.readUInt8(offset + 12),                // 1b
        speed: buf.readUInt16BE(offset + 13),             // 2b
      },
      offset: offset + 15
    };
  }

  // ─── PRIVATE: IO ELEMENT ─────────────────────────────────────────────────

  static _parseIO(buf, offset, codecID) {
    const is8E = codecID === 0x8E;
    const hdrSize = is8E ? 4 : 2;

    if (offset + hdrSize > buf.length) throw new Error('Buffer too short for IO header');

    const eventID = is8E ? buf.readUInt16BE(offset) : buf.readUInt8(offset);
    offset += is8E ? 2 : 1;

        /* totalElements */ is8E ? buf.readUInt16BE(offset) : buf.readUInt8(offset);
    offset += is8E ? 2 : 1;

    const io = {};

    // Fixed-width IO groups: 1, 2, 4, 8 bytes each
    for (const byteLen of [1, 2, 4, 8]) {
      const res = this._parseIOGroup(buf, offset, byteLen, is8E);
      Object.assign(io, res.data);
      offset = res.offset;
    }

    // Variable-length IO group (Codec 8E only)
    if (is8E) {
      const varRes = this._parseIOVarGroup(buf, offset);
      Object.assign(io, varRes.data);
      offset = varRes.offset;
    }

    return { data: io, eventID, offset };
  }

  static _parseIOGroup(buf, offset, byteLen, is8E) {
    const io = {};
    const countSize = is8E ? 2 : 1;
    if (offset + countSize > buf.length) return { data: io, offset };

    const count = is8E ? buf.readUInt16BE(offset) : buf.readUInt8(offset);
    offset += countSize;

    const idSize = is8E ? 2 : 1;
    for (let i = 0; i < count; i++) {
      if (offset + idSize + byteLen > buf.length) break;
      const id = is8E ? buf.readUInt16BE(offset) : buf.readUInt8(offset);
      offset += idSize;

      let val;
      if (byteLen === 1) val = buf.readUInt8(offset);
      else if (byteLen === 2) val = buf.readUInt16BE(offset);
      else if (byteLen === 4) val = buf.readUInt32BE(offset);
      else val = Number(buf.readBigUInt64BE(offset));
      offset += byteLen;

      io[`io_${id}`] = val;
    }
    return { data: io, offset };
  }

  static _parseIOVarGroup(buf, offset) {
    const io = {};
    if (offset + 2 > buf.length) return { data: io, offset };

    const count = buf.readUInt16BE(offset);
    offset += 2;

    for (let i = 0; i < count; i++) {
      if (offset + 4 > buf.length) break;
      const id = buf.readUInt16BE(offset); offset += 2;
      const len = buf.readUInt16BE(offset); offset += 2;
      if (offset + len > buf.length) break;
      io[`io_${id}`] = buf.slice(offset, offset + len).toString('hex');
      offset += len;
    }
    return { data: io, offset };
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  /**
   * Builds a 4-byte big-endian ACK buffer to confirm N received records.
   * @param {number} count
   * @returns {Buffer}
   */
  static buildACK(count) {
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(count, 0);
    return ack;
  }
}

module.exports = TeltonikaParser;
