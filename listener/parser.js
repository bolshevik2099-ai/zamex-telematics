/**
 * Teltonika Codec 8 / 8 Extended Protocol Parser
 * Parses binary AVL data packets from Teltonika GPS devices
 */

class TeltonikaParser {
  /**
   * Parse IMEI from initial connection
   */
  static parseIMEI(buffer) {
    try {
      if (buffer.length < 2) return null;
      const imeiLength = buffer.readUInt16BE(0);

      if (imeiLength !== 15) return null;
      if (buffer.length < 2 + imeiLength) return null;

      const imei = buffer.slice(2, 2 + imeiLength).toString('ascii');
      if (!/^\d{15}$/.test(imei)) return null;

      return imei;
    } catch (error) {
      console.error('[Parser] IMEI Error:', error.message);
      return null;
    }
  }

  /**
   * Parse Codec 8 AVL data packet with extreme robustness
   */
  static parseAVLData(buffer) {
    try {
      let offset = 0;

      // Header: Preamble (4) + Length (4)
      if (buffer.length < offset + 8) return null;
      offset += 8;

      // Codec ID (1 byte)
      const codecID = buffer.readUInt8(offset);
      offset += 1;

      if (codecID !== 0x08 && codecID !== 0x8E) {
        console.warn(`[Parser] ⚠️ Unsupported Codec: 0x${codecID.toString(16)}`);
        return null;
      }

      // Number of Data (1 byte)
      const numberOfData = buffer.readUInt8(offset);
      offset += 1;

      const records = [];

      // Parse each AVL record with internal error isolation
      for (let i = 0; i < numberOfData; i++) {
        try {
          // Check if we have enough buffer for a minimal record (approx 26 bytes) + footer + CRC
          if (offset + 26 + 5 > buffer.length) break;

          const record = this.parseAVLRecord(buffer, offset, codecID);
          if (record && record.data) {
            records.push(record.data);
            offset = record.newOffset;
          } else {
            break; // Impossible to sync if record parsing fails without returning offset
          }
        } catch (recordError) {
          console.error(`[Parser] ❌ Record ${i + 1}/${numberOfData} failed:`, recordError.message);
          break; // Stop parsing packet if we lose synchronization
        }
      }

      // Validate Footer (1 byte)
      if (offset < buffer.length - 4) {
        const footerCount = buffer.readUInt8(offset);
        if (footerCount !== numberOfData) {
          console.warn(`[Parser] ⚠️ Footer mismatch: expected ${numberOfData}, got ${footerCount}`);
        }
      }

      return {
        codecID,
        numberOfRecords: records.length,
        originalCount: numberOfData,
        records
      };
    } catch (error) {
      console.error('[Parser] 💥 Packet crash:', error.message);
      return null;
    }
  }

  static parseAVLRecord(buffer, offset, codecID) {
    // Extensive bounds check before reading
    if (offset + 8 + 1 + 15 + 2 > buffer.length) {
      throw new Error('Buffer end reached during record parse');
    }

    const record = {};

    // Timestamp (8 bytes)
    const timestamp = buffer.readBigUInt64BE(offset);
    record.recorded_at = new Date(Number(timestamp)).toISOString();
    offset += 8;

    // Priority (1 byte)
    record.priority = buffer.readUInt8(offset);
    offset += 1;

    // GPS (15 bytes)
    const gps = this.parseGPSElement(buffer, offset);
    Object.assign(record, gps.data);
    offset = gps.newOffset;

    // IO
    const io = this.parseIOElement(buffer, offset, codecID);
    record.io_elements = io.data;
    record.event_id = io.eventID;
    offset = io.newOffset;

    return { data: record, newOffset: offset };
  }

  static parseGPSElement(buffer, offset) {
    if (offset + 15 > buffer.length) throw new Error('Short GPS');

    const gps = {};
    gps.longitude = buffer.readInt32BE(offset) / 10000000;
    offset += 4;
    gps.latitude = buffer.readInt32BE(offset) / 10000000;
    offset += 4;
    gps.altitude = buffer.readInt16BE(offset);
    offset += 2;
    gps.angle = buffer.readUInt16BE(offset);
    offset += 2;
    gps.satellites = buffer.readUInt8(offset);
    offset += 1;
    gps.speed = buffer.readUInt16BE(offset);
    offset += 2;

    return { data: gps, newOffset: offset };
  }

  static parseIOElement(buffer, offset, codecID) {
    const headerSize = codecID === 0x8E ? 4 : 2;
    if (offset + headerSize > buffer.length) throw new Error('Short IO Header');

    const eventID = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
    offset += codecID === 0x8E ? 2 : 1;

    const totalElements = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
    offset += codecID === 0x8E ? 2 : 1;

    const io = {};
    const lengths = [1, 2, 4, 8];
    for (const len of lengths) {
      const result = this.parseIOElements(buffer, offset, len, codecID);
      Object.assign(io, result.data);
      offset = result.newOffset;
    }

    if (codecID === 0x8E) {
      const varResult = this.parseVariableIOElements(buffer, offset);
      Object.assign(io, varResult.data);
      offset = varResult.newOffset;
    }

    return { data: io, eventID, newOffset: offset };
  }

  static parseIOElements(buffer, offset, byteLength, codecID) {
    const io = {};
    const countSize = codecID === 0x8E ? 2 : 1;
    if (offset + countSize > buffer.length) return { data: io, newOffset: offset };

    const count = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
    offset += countSize;

    for (let i = 0; i < count; i++) {
      const idSize = codecID === 0x8E ? 2 : 1;
      if (offset + idSize + byteLength > buffer.length) break;

      const ioID = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += idSize;

      let value;
      switch (byteLength) {
        case 1: value = buffer.readUInt8(offset); break;
        case 2: value = buffer.readUInt16BE(offset); break;
        case 4: value = buffer.readUInt32BE(offset); break;
        case 8: value = Number(buffer.readBigUInt64BE(offset)); break;
      }
      offset += byteLength;
      io[`io_${ioID}`] = value;
    }

    return { data: io, newOffset: offset };
  }

  static parseVariableIOElements(buffer, offset) {
    const io = {};
    if (offset + 2 > buffer.length) return { data: io, newOffset: offset };

    const count = buffer.readUInt16BE(offset);
    offset += 2;

    for (let i = 0; i < count; i++) {
      if (offset + 4 > buffer.length) break;
      const ioID = buffer.readUInt16BE(offset);
      offset += 2;
      const length = buffer.readUInt16BE(offset);
      offset += 2;

      if (offset + length > buffer.length) break;
      const value = buffer.slice(offset, offset + length).toString('hex');
      offset += length;
      io[`io_${ioID}`] = value;
    }

    return { data: io, newOffset: offset };
  }

  static createACK(numberOfRecords) {
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(numberOfRecords, 0);
    return ack;
  }
}

module.exports = TeltonikaParser;
