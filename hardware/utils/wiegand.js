// Wiegand / RFID card-number normalisation.
//
// A long-range UHF reader wired over Wiegand hands the controller a *number*,
// not the raw EPC. Depending on the reader's output setting that number is
// either a 26-bit (facility + card) or 34-bit value, and Hikvision reports it
// back as an ASCII decimal string. Everything inside VillaSafe is stored as a
// canonical UPPERCASE hex string so the enrolled tag and the swipe match.

/** Strip whitespace / separators and uppercase. */
function clean(v) {
  return String(v == null ? '' : v).replace(/[\s:_-]/g, '').trim().toUpperCase();
}

function isHex(v) { return /^[0-9A-F]+$/.test(v); }
function isDecimal(v) { return /^[0-9]+$/.test(v); }

/** Wiegand-26: 8-bit facility code + 16-bit card number → 24-bit value. */
function facilityCardToHex(facility, card) {
  const f = Number(facility) & 0xff;
  const c = Number(card) & 0xffff;
  return (((f << 16) | c) >>> 0).toString(16).toUpperCase().padStart(6, '0');
}

/** Decode a 26-bit raw value back into { facility, card }. */
function hexToFacilityCard(hex) {
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return null;
  return { facility: (n >> 16) & 0xff, card: n & 0xffff };
}

/**
 * Normalise any supported input into the canonical hex UID.
 * @param {string|number} raw    value from the reader / controller / admin UI
 * @param {string} format        'auto' | 'hex' | 'epc' | 'wiegand26' | 'wiegand34' | 'facility_card'
 */
function normalizeCardNumber(raw, format = 'auto') {
  const v = clean(raw);
  if (!v) return null;

  switch (String(format || 'auto').toLowerCase()) {
    case 'hex':
    case 'epc':
      return isHex(v) ? v : null;

    case 'wiegand26':
    case 'wiegand34': {
      if (!isDecimal(v)) return isHex(v) ? v : null;
      const width = format === 'wiegand34' ? 9 : 6;
      const n = BigInt(v);
      return n.toString(16).toUpperCase().padStart(width, '0');
    }

    case 'facility_card': {
      const m = v.match(/^(\d{1,3})[,./]?(\d{1,5})$/);
      if (!m) return null;
      return facilityCardToHex(m[1], m[2]);
    }

    default: {
      // auto: pure digits are treated as a Wiegand decimal, otherwise hex.
      if (isDecimal(v) && v.length <= 12) {
        return BigInt(v).toString(16).toUpperCase().padStart(6, '0');
      }
      return isHex(v) ? v : null;
    }
  }
}

/**
 * Produce every representation a controller might report for one enrolled tag,
 * so matching still works when the reader format is mis-configured.
 */
function candidateForms(raw) {
  const out = new Set();
  const v = clean(raw);
  if (!v) return [];
  out.add(v);
  const hex = normalizeCardNumber(v, 'auto');
  if (hex) {
    out.add(hex);
    out.add(hex.replace(/^0+/, '') || '0');
    const dec = BigInt('0x' + hex).toString(10);
    out.add(dec);
    out.add(dec.padStart(10, '0'));
  }
  if (isDecimal(v)) out.add(String(BigInt(v)));
  return [...out];
}

module.exports = {
  clean, isHex, isDecimal,
  normalizeCardNumber, facilityCardToHex, hexToFacilityCard, candidateForms,
};
