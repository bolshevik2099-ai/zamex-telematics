/**
 * Teltonika Codec 8 / 8 Extended Protocol Parser
 * Parses binary AVL data packets from Teltonika GPS devices
 */

class TeltonikaParser {
  /**
   * Parse IMEI from initial connection
   * @param {Buffer} buffer - Raw buffer from socket
   * @returns {string|null} - IMEI as string or null if invalid
   */
  static parseIMEI(buffer) {
    try {
      // First 2 bytes = IMEI length
      const imeiLength = buffer.readUInt16BE(0);
      
      if (imeiLength !== 15) {
        console.warn('Invalid IMEI length:', imeiLength);
        return null;
      }
      
      // Next 15 bytes = IMEI as ASCII
      const imei = buffer.slice(2, 2 + imeiLength).toString('ascii');
      
      // Validate IMEI (should be 15 digits)
      if (!/^\d{15}$/.test(imei)) {
        console.warn('IMEI contains non-numeric characters:', imei);
        return null;
      }
      
      return imei;
    } catch (error) {
      console.error('Error parsing IMEI:', error);
      return null;
    }
  }

  /**
   * Parse Codec 8 AVL data packet
   * @param {Buffer} buffer - Raw AVL data buffer
   * @returns {Object|null} - Parsed data or null if invalid
   */
  static parseAVLData(buffer) {
    try {
      let offset = 0;

      // Skip preamble (4 bytes - usually 00 00 00 00)
      offset += 4;

      // Data field length (4 bytes)
      const dataLength = buffer.readUInt32BE(offset);
      offset += 4;

      // Codec ID (1 byte) - Should be 0x08 for Codec 8
      const codecID = buffer.readUInt8(offset);
      offset += 1;

      if (codecID !== 0x08 && codecID !== 0x8E) {
        console.warn('Unsupported Codec ID:', codecID.toString(16));
        return null;
      }

      // Number of Data (1 byte)
      const numberOfData = buffer.readUInt8(offset);
      offset += 1;

      const records = [];

      // Parse each AVL record
      for (let i = 0; i < numberOfData; i++) {
        const record = this.parseAVLRecord(buffer, offset, codecID);
        if (record) {
          records.push(record.data);
          offset = record.newOffset;
        }
      }

      return {
        codecID,
        numberOfRecords: numberOfData,
        records
      };
    } catch (error) {
      console.error('Error parsing AVL data:', error);
      return null;
    }
  }

  /**
   * Parse a single AVL record
   * @param {Buffer} buffer - Buffer containing the record
   * @param {number} offset - Current offset in buffer
   * @param {number} codecID - Codec identifier
   * @returns {Object} - Parsed record and new offset
   */
  static parseAVLRecord(buffer, offset, codecID) {
    try {
      const record = {};

      // Timestamp (8 bytes) - milliseconds since 1970-01-01 00:00:00 UTC
      const timestamp = buffer.readBigUInt64BE(offset);
      record.recorded_at = new Date(Number(timestamp)).toISOString();
      offset += 8;

      // Priority (1 byte)
      record.priority = buffer.readUInt8(offset);
      offset += 1;

      // GPS Element
      const gps = this.parseGPSElement(buffer, offset);
      Object.assign(record, gps.data);
      offset = gps.newOffset;

      // IO Element
      const io = this.parseIOElement(buffer, offset, codecID);
      record.io_elements = io.data;
      record.event_id = io.eventID;
      offset = io.newOffset;

      return { data: record, newOffset: offset };
    } catch (error) {
      console.error('Error parsing AVL record:', error);
      return null;
    }
  }

  /**
   * Parse GPS Element from AVL record
   * @param {Buffer} buffer
   * @param {number} offset
   * @returns {Object}
   */
  static parseGPSElement(buffer, offset) {
    const gps = {};

    // Longitude (4 bytes, signed)
    gps.longitude = buffer.readInt32BE(offset) / 10000000;
    offset += 4;

    // Latitude (4 bytes, signed)
    gps.latitude = buffer.readInt32BE(offset) / 10000000;
    offset += 4;

    // Altitude (2 bytes, signed)
    gps.altitude = buffer.readInt16BE(offset);
    offset += 2;

    // Angle (2 bytes)
    gps.angle = buffer.readUInt16BE(offset);
    offset += 2;

    // Satellites (1 byte)
    gps.satellites = buffer.readUInt8(offset);
    offset += 1;

    // Speed (2 bytes)
    gps.speed = buffer.readUInt16BE(offset);
    offset += 2;

    return { data: gps, newOffset: offset };
  }

  /**
   * Parse IO Element from AVL record
   * @param {Buffer} buffer
   * @param {number} offset
   * @param {number} codecID
   * @returns {Object}
   */
  static parseIOElement(buffer, offset, codecID) {
    const io = {};

    // Event IO ID (1 byte for Codec 8, 2 bytes for Codec 8 Extended)
    const eventID = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
    offset += codecID === 0x8E ? 2 : 1;

    // Total IO Elements (1 byte for Codec 8, 2 bytes for Codec 8 Extended)
    const totalElements = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
    offset += codecID === 0x8E ? 2 : 1;

    // Parse 1 byte IO elements
    const io1ByteResult = this.parseIOElements(buffer, offset, 1, codecID);
    Object.assign(io, io1ByteResult.data);
    offset = io1ByteResult.newOffset;

    // Parse 2 byte IO elements
    const io2ByteResult = this.parseIOElements(buffer, offset, 2, codecID);
    Object.assign(io, io2ByteResult.data);
    offset = io2ByteResult.newOffset;

    // Parse 4 byte IO elements
    const io4ByteResult = this.parseIOElements(buffer, offset, 4, codecID);
    Object.assign(io, io4ByteResult.data);
    offset = io4ByteResult.newOffset;

    // Parse 8 byte IO elements
    const io8ByteResult = this.parseIOElements(buffer, offset, 8, codecID);
    Object.assign(io, io8ByteResult.data);
    offset = io8ByteResult.newOffset;

    return { data: io, eventID, newOffset: offset };
  }

  /**
   * Parse IO elements of specific byte length
   * @param {Buffer} buffer
   * @param {number} offset
   * @param {number} byteLength - 1, 2, 4, or 8
   * @param {number} codecID
   * @returns {Object}
   */
  static parseIOElements(buffer, offset, byteLength, codecID) {
    const io = {};

    // Number of IO elements of this size (1 byte for Codec 8, 2 bytes for Codec 8 Extended)
    const count = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
    offset += codecID === 0x8E ? 2 : 1;

    for (let i = 0; i < count; i++) {
      // IO ID (1 byte for Codec 8, 2 bytes for Codec 8 Extended)
      const ioID = codecID === 0x8E ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += codecID === 0x8E ? 2 : 1;

      // IO Value
      let value;
      switch (byteLength) {
        case 1:
          value = buffer.readUInt8(offset);
          break;
        case 2:
          value = buffer.readUInt16BE(offset);
          break;
        case 4:
          value = buffer.readUInt32BE(offset);
          break;
        case 8:
          value = Number(buffer.readBigUInt64BE(offset));
          break;
      }
      offset += byteLength;

      io[`io_${ioID}`] = value;
    }

    return { data: io, newOffset: offset };
  }

  /**
   * Create ACK response for received data
   * @param {number} numberOfRecords - Number of records successfully received
   * @returns {Buffer}
   */
  static createACK(numberOfRecords) {
    const ack = Buffer.allocUnsafe(4);
    ack.writeUInt32BE(numberOfRecords, 0);
    return ack;
  }
}

module.exports = TeltonikaParser;
