// Pure WhatsApp content-shape predicates shared by capture and Stage-0.
// These rules consume fields emitted by the connector. They do not assign a
// semantic name to ZMESSAGETYPE or ZGROUPEVENTTYPE numeric values.

const IDENTIFIER_BODY_MESSAGE_TYPE = 10;

function _messageTypeOf(value) {
  try {
    if (Number.isInteger(value)) return value;
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function _isBareIdentifierOrUsername(text) {
  if (/^\d+@lid$/i.test(text)) return true;
  if (/^\+?\d+@s\.whatsapp\.net$/i.test(text)) return true;
  return /^@?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
}

// The rule requires the complete observed shape: the message-type field and a
// body containing one identifier-like token. Group-event provenance is not an
// input, and prose containing whitespace does not match.
export function isWhatsAppIdentifierBodyPlaceholder(rawContent) {
  try {
    if (rawContent == null || typeof rawContent !== "object") return false;
    if (_messageTypeOf(rawContent.message_type)
        !== IDENTIFIER_BODY_MESSAGE_TYPE) {
      return false;
    }
    const text = typeof rawContent.text === "string"
      ? rawContent.text.trim()
      : "";
    return text.length > 0 && _isBareIdentifierOrUsername(text);
  } catch {
    return false;
  }
}
