// Narrow, fail-soft extraction of the quoted stanza id from WhatsApp's
// undocumented ZWAMEDIAITEM.ZMETADATA protobuf.
//
// This is deliberately not a contextInfo implementation. It recognizes one
// top-level field: field 5 with wire type 2 (length-delimited). Other fields
// are skipped only far enough to validate the outer protobuf. Do not parse the
// participant, quoted text, nested messages, or any other semantic field.
//
// Safety rule: an unsupported wire type, malformed/truncated encoding,
// duplicate field 5, or a field-5 payload outside the stanza-id shape returns
// null. Decoder rejection must remove linkage instead of guessing one.

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_FIELD_NUMBER = 0x1fffffff;
const QUOTED_STANZA_FIELD = 5;
const MIN_STANZA_ID_BYTES = 20;
const MAX_STANZA_ID_BYTES = 32;

function readCanonicalVarint(bytes, start) {
  let value = 0n;
  let pos = start;
  for (let index = 0; index < 10; index += 1) {
    if (pos >= bytes.length) return null;
    const byte = bytes[pos];
    pos += 1;

    // A uint64 varint's final byte can carry only bit zero.
    if (index === 9 && byte > 1) return null;
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);

    if ((byte & 0x80) === 0) {
      // Reject overlong encodings. Accepting alternate byte strings for the
      // same key or length makes corruption harder to distinguish from data.
      if (index > 0 && byte === 0) return null;
      return { value, next: pos };
    }
  }
  return null;
}

function isUpperHexStanzaId(bytes) {
  if (bytes.length < MIN_STANZA_ID_BYTES
      || bytes.length > MAX_STANZA_ID_BYTES) {
    return false;
  }
  for (const byte of bytes) {
    const digit = byte >= 0x30 && byte <= 0x39;
    const upperHex = byte >= 0x41 && byte <= 0x46;
    if (!digit && !upperHex) return false;
  }
  return true;
}

/**
 * Return the quoted stanza id from a ZMETADATA blob, or null.
 * Decoder failures are data outcomes and must not escape into the connector
 * capture loop.
 */
export function extractQuotedStanzaId(metadata) {
  try {
    if (!ArrayBuffer.isView(metadata)) return null;
    const bytes = Buffer.from(
      metadata.buffer,
      metadata.byteOffset,
      metadata.byteLength,
    );
    if (bytes.length === 0 || bytes.length > MAX_METADATA_BYTES) return null;

    let pos = 0;
    let candidate = null;
    while (pos < bytes.length) {
      const key = readCanonicalVarint(bytes, pos);
      if (key == null || key.value === 0n) return null;
      pos = key.next;

      const wireType = Number(key.value & 0x07n);
      const fieldNumberBig = key.value >> 3n;
      if (fieldNumberBig === 0n
          || fieldNumberBig > BigInt(MAX_FIELD_NUMBER)) {
        return null;
      }
      const fieldNumber = Number(fieldNumberBig);

      if (wireType === 0) {
        if (fieldNumber === QUOTED_STANZA_FIELD) return null;
        const value = readCanonicalVarint(bytes, pos);
        if (value == null) return null;
        pos = value.next;
      } else if (wireType === 1) {
        if (fieldNumber === QUOTED_STANZA_FIELD || pos + 8 > bytes.length) {
          return null;
        }
        pos += 8;
      } else if (wireType === 2) {
        const length = readCanonicalVarint(bytes, pos);
        if (length == null) return null;
        pos = length.next;
        if (length.value > BigInt(bytes.length - pos)) return null;
        const byteLength = Number(length.value);
        const value = bytes.subarray(pos, pos + byteLength);
        pos += byteLength;

        if (fieldNumber === QUOTED_STANZA_FIELD) {
          if (candidate != null || !isUpperHexStanzaId(value)) return null;
          candidate = value.toString("ascii");
        }
      } else if (wireType === 5) {
        if (fieldNumber === QUOTED_STANZA_FIELD || pos + 4 > bytes.length) {
          return null;
        }
        pos += 4;
      } else {
        // Groups (3/4) and reserved wire types (6/7) are outside this decoder.
        return null;
      }
    }

    return candidate;
  } catch {
    return null;
  }
}
