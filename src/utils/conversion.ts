import { Supplier, ParsedSize } from '../types';
import {
  MT_TO_LBS,
  GAUGE_TO_DECIMAL,
  MM_TO_DECIMAL,
  FRACTION_TO_DECIMAL,
  FINISH_CODES,
} from './constants';

/**
 * Convert metric tons to pounds
 */
export function mtToLbs(metricTons: number): number {
  return Math.round(metricTons * MT_TO_LBS);
}

/**
 * Convert pounds to metric tons
 */
export function lbsToMt(pounds: number): number {
  return pounds / MT_TO_LBS;
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Format thickness to 3 decimal places
 * Example: 0.188 -> "0.188", 0.25 -> "0.250"
 */
export function formatThickness(thickness: number): string {
  return thickness.toFixed(3);
}

/**
 * Parse Wuu Jing size format: "4.76*1525MM*3660MM(3/16"*60"*144")"
 * Returns parsed dimensions in inches
 */
export function parseWuuJingSize(sizeStr: string): ParsedSize | null {
  // Try to extract from the imperial part in parentheses: (3/16"*60"*144")
  const imperialMatch = sizeStr.match(/\(([^)]+)\)/);
  if (imperialMatch) {
    const imperial = imperialMatch[1];
    // Match pattern like: 3/16"*60"*144" or 1/4"*48"*120"
    const parts = imperial.split(/[*×x]/i).map(s => s.trim().replace(/["']/g, ''));
    if (parts.length >= 3) {
      const thickness = parseThickness(parts[0]);
      const width = parseFloat(parts[1]);
      const length = parseFloat(parts[2]);

      if (thickness && !isNaN(width) && !isNaN(length)) {
        return {
          thickness,
          width,
          length,
          thicknessFormatted: formatThickness(thickness),
        };
      }
    }
  }

  // Fallback: try to parse metric part: 4.76*1525MM*3660MM
  const metricMatch = sizeStr.match(/(\d+\.?\d*)\s*[*×x]\s*(\d+)(?:MM)?\s*[*×x]\s*(\d+)(?:MM)?/i);
  if (metricMatch) {
    const thicknessMM = metricMatch[1];
    const widthMM = parseFloat(metricMatch[2]);
    const lengthMM = parseFloat(metricMatch[3]);

    // Convert MM to inches (25.4mm = 1 inch)
    const thickness = MM_TO_DECIMAL[thicknessMM] || parseFloat(thicknessMM) / 25.4;
    const width = Math.round(widthMM / 25.4);
    const length = Math.round(lengthMM / 25.4);

    if (thickness && !isNaN(width) && !isNaN(length)) {
      return {
        thickness,
        width,
        length,
        thicknessFormatted: formatThickness(thickness),
      };
    }
  }

  return null;
}

/**
 * Parse Yuen Chang size format: "22GA*48"*120"" or "22GA(48"*120")"
 */
export function parseYuenChangSize(sizeStr: string): ParsedSize | null {
  // Match pattern like: 22GA*48"*120" or 22GA(48"*120")
  const match = sizeStr.match(/(\d+)(?:GA)?\s*[*×x(]\s*(\d+)["']?\s*[*×x]\s*(\d+)["']?/i);
  if (match) {
    const gauge = match[1] + 'GA';
    const width = parseFloat(match[2]);
    const length = parseFloat(match[3]);

    const thickness = GAUGE_TO_DECIMAL[gauge] || GAUGE_TO_DECIMAL[match[1]];

    if (thickness && !isNaN(width) && !isNaN(length)) {
      return {
        thickness,
        width,
        length,
        thicknessFormatted: formatThickness(thickness),
      };
    }
  }

  return null;
}

/**
 * Parse any thickness value (fraction, decimal, gauge, mm)
 */
export function parseThickness(value: string): number | null {
  const cleaned = value.trim().toUpperCase().replace(/["']/g, '');

  // Check gauge
  if (GAUGE_TO_DECIMAL[cleaned] || GAUGE_TO_DECIMAL[cleaned.replace('GA', '')]) {
    return GAUGE_TO_DECIMAL[cleaned] || GAUGE_TO_DECIMAL[cleaned.replace('GA', '')];
  }

  // Check fraction
  if (FRACTION_TO_DECIMAL[cleaned]) {
    return FRACTION_TO_DECIMAL[cleaned];
  }

  // Check if it's a fraction like 3/16
  if (cleaned.includes('/')) {
    const [num, denom] = cleaned.split('/').map(Number);
    if (!isNaN(num) && !isNaN(denom) && denom !== 0) {
      return num / denom;
    }
  }

  // Check MM conversion
  if (MM_TO_DECIMAL[cleaned]) {
    return MM_TO_DECIMAL[cleaned];
  }

  // Try direct decimal parse
  const decimal = parseFloat(cleaned);
  if (!isNaN(decimal)) {
    // If it's a small number, assume it's already in inches
    if (decimal < 2) {
      return decimal;
    }
    // If larger, might be MM - convert
    if (decimal > 2 && decimal < 20) {
      return MM_TO_DECIMAL[cleaned] || decimal / 25.4;
    }
  }

  return null;
}

/**
 * Parse a size string and return dimensions based on supplier
 */
export function parseSize(sizeStr: string, supplier: Supplier): ParsedSize | null {
  if (supplier === 'wuu-jing') {
    return parseWuuJingSize(sizeStr);
  } else if (supplier === 'yuen-chang') {
    return parseYuenChangSize(sizeStr);
  }

  // Try both formats for unknown supplier
  return parseWuuJingSize(sizeStr) || parseYuenChangSize(sizeStr);
}

/**
 * Build Inventory ID from parsed size
 * Format: {thickness}-{width}__-{length}__-304/304L-{finish}
 */
export function buildInventoryId(size: ParsedSize, supplier: Supplier): string {
  const finish = FINISH_CODES[supplier] || FINISH_CODES['wuu-jing'];
  return `${size.thicknessFormatted}-${size.width}__-${size.length}__-304/304L-${finish}`;
}

/**
 * Build lot/serial number from PO number and bundle number
 * Format: 00{poNumber}-{bundleNumber padded to 2 digits}
 */
export function buildLotSerialNbr(poNumber: string, bundleNumber: string | number): string {
  const po = poNumber.replace(/\D/g, '').padStart(4, '0');
  const bundle = String(bundleNumber).replace(/\D/g, '').padStart(2, '0');
  return `00${po}-${bundle}`;
}

/**
 * Extract PO number from filename or text
 * Only matches explicit PO patterns, not random numbers or timestamps
 */
export function extractPoNumber(text: string): string {
  // Look for explicit PO number patterns only
  const patterns = [
    /PO[:\s#-]*(\d{3,6})/i,
    /P\.?O\.?[:\s#-]*(\d{3,6})/i,
    /ORDER[:\s#-]*(\d{3,6})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Don't fallback to random numbers - require explicit PO pattern
  return '';
}
