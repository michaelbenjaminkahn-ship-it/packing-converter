import { Supplier, ParsedSize } from '../types';
import {
  MT_TO_LBS,
  GAUGE_TO_DECIMAL,
  MM_TO_DECIMAL,
  FRACTION_TO_DECIMAL,
  FINISH_CODES,
} from './constants';
import { getMappedInventoryId, getThicknessDisplay } from '../config/inventoryMappings';

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
 * Format thickness to 4 decimal places
 * Example: 0.1875 -> "0.1875", 0.4375 -> "0.4375", 0.25 -> "0.2500"
 */
export function formatThickness(thickness: number): string {
  return thickness.toFixed(4);
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
 * Parse Yuen Chang size format: "22GA*48"*120"" or "22GA x 48" x 120"" or "22GA(48"*120")"
 */
export function parseYuenChangSize(sizeStr: string): ParsedSize | null {
  // Normalize the string - remove extra spaces and standardize separators
  const normalized = sizeStr.replace(/\s+/g, ' ').trim();

  // Try multiple patterns for flexibility
  // Pattern 1: 26GA x 48" x 120" (with spaces around separator)
  // Pattern 2: 22GA*48"*120" (no spaces)
  // Pattern 3: 22GA(48"*120") (parentheses format)

  // More flexible regex that handles various separator styles
  const match = normalized.match(/(\d+)\s*(?:GA)?\s*[*×xX(\s]\s*(\d+)[""']?\s*[*×xX)\s]\s*(\d+)[""']?/i);
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

  // Fallback: try to extract numbers in sequence
  const numbers = normalized.match(/(\d+)\s*GA[^0-9]*(\d+)[^0-9]*(\d+)/i);
  if (numbers) {
    const gauge = numbers[1] + 'GA';
    const width = parseFloat(numbers[2]);
    const length = parseFloat(numbers[3]);

    const thickness = GAUGE_TO_DECIMAL[gauge] || GAUGE_TO_DECIMAL[numbers[1]];

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
 * Parse Yeou Yih Steel size format: "304/304L 0.750" X 60" X 120"" or "0.750" X 60" X 120""
 * Uses decimal thickness in inches (e.g., 0.750, 0.500, 1.000)
 */
export function parseYeouYihSize(sizeStr: string): ParsedSize | null {
  // Normalize separators and clean string
  const normalized = sizeStr
    .replace(/\s+/g, ' ')
    .replace(/[×x]/gi, 'X')
    .trim();

  // Pattern: decimal_thickness" X width" X length"
  // Examples: "0.750" X 60" X 120"", "1.000" X 60" X 240""
  // May have 304/304L prefix and/or PCS suffix
  const match = normalized.match(/(\d+\.\d+)[""']?\s*X\s*(\d+)[""']?\s*X\s*(\d+)/i);

  if (match) {
    const thickness = parseFloat(match[1]);
    const width = parseFloat(match[2]);
    const length = parseFloat(match[3]);

    if (!isNaN(thickness) && !isNaN(width) && !isNaN(length) && thickness > 0 && thickness <= 4) {
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
 * Parse a size string and return dimensions based on supplier
 */
export function parseSize(sizeStr: string, supplier: Supplier): ParsedSize | null {
  if (supplier === 'wuu-jing') {
    return parseWuuJingSize(sizeStr);
  } else if (supplier === 'yuen-chang') {
    return parseYuenChangSize(sizeStr);
  } else if (supplier === 'yeou-yih') {
    return parseYeouYihSize(sizeStr);
  }

  // Try all formats for unknown supplier
  return parseWuuJingSize(sizeStr) || parseYuenChangSize(sizeStr) || parseYeouYihSize(sizeStr);
}

/**
 * Build Inventory ID from parsed size
 * Format: {thickness}-{width}__-{length}__-304/304L-{finish}
 * @param size - Parsed size dimensions
 * @param supplier - Supplier name (used for default finish)
 * @param finish - Optional explicit finish override (e.g., "#1", "2B", "#4")
 *
 * Checks manual mappings first (src/config/inventoryMappings.ts)
 */
export function buildInventoryId(size: ParsedSize, supplier: Supplier, finish?: string): string {
  // Check for manual mapping first
  const mapping = getMappedInventoryId(size.thickness, size.width, size.length);
  if (mapping) {
    return mapping.inventoryId;
  }

  // Check for thickness display override
  const thicknessDisplay = getThicknessDisplay(size.thickness) || size.thicknessFormatted;

  let finishCode: string;
  if (finish) {
    // Use explicit finish - add trailing underscores to normalize length
    finishCode = finish;
  } else {
    // Use supplier default
    finishCode = FINISH_CODES[supplier] || FINISH_CODES['wuu-jing'];
  }
  return `${thicknessDisplay}-${size.width}__-${size.length}__-304/304L-${finishCode}`;
}

/**
 * Build lot/serial number from PO number and bundle/item identifier
 * For Wuu Jing: Use bundle number directly (e.g., "001837-01" or "001739-4-01")
 * For Yuen Chang: Use item identifier directly (e.g., "WM006")
 */
export function buildLotSerialNbr(poNumber: string, bundleOrItem: string | number, _supplier?: Supplier): string {
  const bundleStr = String(bundleOrItem);

  // If it's already a full 3-part bundle number (like "001739-4-01"), use as-is
  if (bundleStr.match(/^\d{6}-\d+-\d{2}$/)) {
    return bundleStr;
  }

  // If it's already a full 2-part bundle number (like "001837-01"), use as-is
  if (bundleStr.match(/^\d{6}-\d{2}$/)) {
    return bundleStr;
  }

  // If it's an item code (like "WM006", "XL007"), use as-is
  if (bundleStr.match(/^[A-Z]{2}\d{3}$/i)) {
    return bundleStr;
  }

  // Otherwise, build from PO number and bundle number
  const po = poNumber.replace(/\D/g, '').padStart(6, '0');
  const bundle = bundleStr.replace(/\D/g, '').padStart(2, '0');
  return `${po}-${bundle}`;
}

/**
 * Extract warehouse from destination in packing list
 * Maps destination cities to warehouse codes
 * Returns { warehouse, detected } where detected is true if found in text
 */
export function extractWarehouse(text: string): { warehouse: string; detected: boolean } {
  const lowerText = text.toLowerCase();

  // Check for destination patterns (case insensitive)
  if (lowerText.includes('baltimore')) return { warehouse: 'Baltimore', detected: true };
  if (lowerText.includes('houston')) return { warehouse: 'Houston', detected: true };
  if (lowerText.includes('oakland')) return { warehouse: 'Oakland', detected: true };
  if (lowerText.includes('seattle')) return { warehouse: 'Seattle', detected: true };
  if (lowerText.includes('kent')) return { warehouse: 'Kent', detected: true };
  if (lowerText.includes('tampa')) return { warehouse: 'Tampa', detected: true };
  if (lowerText.includes('camden')) return { warehouse: 'Camden', detected: true };
  if (lowerText.includes('los angeles') || lowerText.includes('la,') || lowerText.includes('to: la')) return { warehouse: 'LA', detected: true };

  // Default warehouse - not detected
  return { warehouse: 'LA', detected: false };
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

/**
 * Extract PO number from Wuu Jing bundle numbers
 * Bundle format: 001812-01 or 001739-4-01 -> PO# 1812 or 1739
 * Returns the most common PO found, or empty string if none found
 */
export function extractPoFromBundles(text: string): string {
  // Match both 2-part (001812-01) and 3-part (001739-4-01) formats
  const bundlePattern3 = /(\d{6})-\d+-\d{2}/g;
  const bundlePattern2 = /(\d{6})-\d{2}/g;

  // Try 3-part format first
  let matches = [...text.matchAll(bundlePattern3)];
  if (matches.length === 0) {
    matches = [...text.matchAll(bundlePattern2)];
  }

  if (matches.length === 0) {
    return '';
  }

  // Count PO occurrences
  const poCounts: Record<string, number> = {};
  for (const match of matches) {
    // Remove leading zeros: 001812 -> 1812
    const po = match[1].replace(/^0+/, '') || '0';
    poCounts[po] = (poCounts[po] || 0) + 1;
  }

  // Return the most common PO
  const sortedPos = Object.entries(poCounts).sort((a, b) => b[1] - a[1]);
  return sortedPos[0]?.[0] || '';
}

/**
 * Extract multiple PO numbers from Yuen Chang packing lists
 * Returns array of unique PO numbers found
 */
export function extractMultiplePos(text: string): string[] {
  const poPattern = /PO[:\s#-]*(\d{3,6})/gi;
  const matches = [...text.matchAll(poPattern)];

  const uniquePos = [...new Set(matches.map(m => m[1]))];
  return uniquePos;
}

/**
 * Extract PO numbers from Yeou Yih Steel packing lists
 * Format: "S2509021 001715" where 001715 is the PO number
 * Returns array of unique PO numbers found
 */
export function extractYeouYihPos(text: string): string[] {
  // Pattern: S####### followed by a 6-digit PO number
  const pattern = /S\d{7}\s+(\d{6})/g;
  const matches = [...text.matchAll(pattern)];

  // Extract and dedupe PO numbers, removing leading zeros
  const uniquePos = [...new Set(matches.map(m => m[1].replace(/^0+/, '') || m[1]))];
  return uniquePos;
}

/**
 * Extract sales order to PO mapping from Yeou Yih Steel packing lists
 * Format: "S2509021 001715" -> { salesOrder: "S2509021", poNumber: "1715" }
 */
export function extractYeouYihSalesOrderMapping(text: string): Map<string, string> {
  const pattern = /S(\d{7})\s+(\d{6})/g;
  const matches = [...text.matchAll(pattern)];

  const mapping = new Map<string, string>();
  for (const match of matches) {
    const salesOrder = `S${match[1]}`;
    const poNumber = match[2].replace(/^0+/, '') || match[2];
    mapping.set(salesOrder, poNumber);
  }
  return mapping;
}
