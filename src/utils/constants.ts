// Conversion factor: 1 metric ton = 2204.62 pounds
export const MT_TO_LBS = 2204.62;

// Vendor codes
export const VENDOR_CODES = {
  'wuu-jing': 'V005006',
  'yuen-chang': 'V005010',
  'unknown': '',
} as const;

// Finish codes
export const FINISH_CODES = {
  'wuu-jing': '#1____',    // Hot rolled
  'yuen-chang': '2B____',  // Cold rolled
  'unknown': '#1____',     // Default to hot rolled
} as const;

// Supplier detection keywords
export const SUPPLIER_KEYWORDS = {
  'wuu-jing': ['wuu jing', 'wuu-jing', 'wuujing', '五井', 'wu jing', 'wu-jing'],
  'yuen-chang': ['yuen chang', 'yuen-chang', 'yuenchang', '元昌'],
} as const;

// Gauge to decimal conversion (for Yuen Chang cold rolled)
export const GAUGE_TO_DECIMAL: Record<string, number> = {
  '26GA': 0.018,
  '26': 0.018,
  '24GA': 0.024,
  '24': 0.024,
  '22GA': 0.030,
  '22': 0.030,
  '20GA': 0.036,
  '20': 0.036,
  '18GA': 0.048,
  '18': 0.048,
  '16GA': 0.060,
  '16': 0.060,
  '14GA': 0.075,
  '14': 0.075,
  '13GA': 0.090,
  '13': 0.090,
  '12GA': 0.105,
  '12': 0.105,
  '11GA': 0.120,
  '11': 0.120,
  '10GA': 0.135,
  '10': 0.135,
};

// MM to decimal conversion (for Wuu Jing hot rolled)
export const MM_TO_DECIMAL: Record<string, number> = {
  '4.76': 0.188,
  '6.35': 0.250,
  '7.94': 0.313,
  '9.53': 0.375,
  '12.70': 0.500,
  '12.7': 0.500,
};

// Fraction to decimal conversion
export const FRACTION_TO_DECIMAL: Record<string, number> = {
  '3/16': 0.188,
  '1/4': 0.250,
  '5/16': 0.313,
  '3/8': 0.375,
  '1/2': 0.500,
  '5/8': 0.625,
  '3/4': 0.750,
  '1': 1.000,
};

// Packing list indicators (+10 points each)
export const PACKING_LIST_INDICATORS = [
  'pcs', 'pc', 'pieces', 'qty',
  'size', 'gauge', 'thickness',
  'bundle', 'bundle no', 'item',
  'weight', 'net weight', 'gross weight', 'n\'weight', 'g\'weight',
  'heat', 'heat no', 'coil',
  // Wuu Jing specific patterns
  'container no', 'product no', 'n\'wt', 'g\'wt',
  // OCR-friendly variations (may OCR as these)
  'nweight', 'gweight', 'n weight', 'g weight',
  // Size pattern indicators
  'mm*', '*mm', '60"', '48"', '120"', '144"',
];

// Title bonus keywords (+30 points)
export const PACKING_LIST_TITLE_KEYWORDS = [
  'packing list',
  'packing-list',
  'packinglist',
  'shipping list',
  '裝箱單',
  '装箱单',
];

// Invoice keywords (-15 points each)
export const INVOICE_KEYWORDS = [
  'invoice',
  'total amount',
  'payment',
  'bill to',
  'price',
  'amount',
  'us$/pc',
  'us$/mt',
  'unit price',
];

// Mill certificate keywords (-15 points each)
export const MILL_CERT_KEYWORDS = [
  'certificate',
  'test result',
  'chemical composition',
  'tensile',
  'yield',
  'elongation',
  'hardness',
  'mechanical properties',
];

// Steel weight lookup table: Lbs per Square Foot by thickness (in decimal inches)
// Source: Chatham Steel (https://www.chathamsteel.com/index.php/steel-plate-sheets/)
// Formula: Lbs/Pc = (Width × Length / 144) × Lbs/Sq Ft
export const STEEL_LBS_PER_SQ_FT: Record<string, number> = {
  // Sheet gauges (cold rolled - 2B/#4 finish) - rarely used for theoretical weight
  '0.015': 0.630,   // 28 Ga
  '0.018': 0.756,   // 26 Ga
  '0.024': 1.008,   // 24 Ga
  '0.030': 1.260,   // 22 Ga
  '0.036': 1.512,   // 20 Ga
  '0.042': 1.764,   // 19 Ga
  '0.048': 2.016,   // 18 Ga
  '0.060': 2.520,   // 16 Ga
  '0.075': 3.150,   // 14 Ga
  '0.090': 3.780,   // 13 Ga
  '0.105': 4.410,   // 12 Ga
  '0.120': 5.040,   // 11 Ga
  '0.135': 5.670,   // 10 Ga
  '0.187': 7.871,   // 7 Ga
  // Plate thicknesses (hot rolled - #1 finish) - primary use case
  '0.188': 8.579,   // 3/16"
  '0.250': 11.16,   // 1/4"
  '0.313': 13.75,   // 5/16"
  '0.375': 16.5,    // 3/8"
  '0.500': 21.66,   // 1/2"
  '0.625': 26.83,   // 5/8"
  '0.750': 32.12,   // 3/4"
  '0.875': 37.29,   // 7/8"
  '1.000': 42.67,   // 1"
  '1.125': 47.83,   // 1-1/8"
  '1.250': 53,      // 1-1/4"
  '1.500': 63.34,   // 1-1/2"
  '1.750': 73.67,   // 1-3/4"
  '2.000': 84.01,   // 2"
  '2.500': 105.1,   // 2-1/2"
  '3.000': 126.3,   // 3"
  '3.250': 136.6,   // 3-1/4"
  '3.500': 147.0,   // 3-1/2"
  '3.750': 157.3,   // 3-3/4"
  '4.000': 167.6,   // 4"
};

// Get Lbs/Sq Ft for a given thickness, with interpolation fallback
export function getLbsPerSqFt(thicknessDecimal: number): number | null {
  // Try exact match first (formatted to 3 decimal places)
  const key = thicknessDecimal.toFixed(3);
  if (STEEL_LBS_PER_SQ_FT[key]) {
    return STEEL_LBS_PER_SQ_FT[key];
  }

  // Try with fewer decimals for common values like 1.000
  const keyShort = thicknessDecimal.toFixed(2).replace(/\.?0+$/, '') || '0';
  for (const [k, v] of Object.entries(STEEL_LBS_PER_SQ_FT)) {
    if (parseFloat(k).toFixed(2).replace(/\.?0+$/, '') === keyShort) {
      return v;
    }
  }

  // Linear interpolation between known values
  const thicknesses = Object.keys(STEEL_LBS_PER_SQ_FT).map(k => parseFloat(k)).sort((a, b) => a - b);

  // Find surrounding values
  let lower: number | null = null;
  let upper: number | null = null;
  for (const t of thicknesses) {
    if (t <= thicknessDecimal) lower = t;
    if (t >= thicknessDecimal && upper === null) upper = t;
  }

  if (lower !== null && upper !== null && lower !== upper) {
    // Interpolate
    const lowerLbs = STEEL_LBS_PER_SQ_FT[lower.toFixed(3)] || STEEL_LBS_PER_SQ_FT[lower.toString()];
    const upperLbs = STEEL_LBS_PER_SQ_FT[upper.toFixed(3)] || STEEL_LBS_PER_SQ_FT[upper.toString()];
    if (lowerLbs && upperLbs) {
      const ratio = (thicknessDecimal - lower) / (upper - lower);
      return lowerLbs + ratio * (upperLbs - lowerLbs);
    }
  }

  // No interpolation possible
  return null;
}

// Default warehouse
export const DEFAULT_WAREHOUSE = 'LA';

// Warehouses
export const WAREHOUSES = ['LA', 'Baltimore', 'Houston', 'Oakland', 'Seattle', 'Kent', 'Tampa', 'Camden'] as const;

// Acumatica output columns - must match template exactly
export const ACUMATICA_COLUMNS = [
  'Order Number',
  'Vendor',
  'Inventory ID',
  'Lot/Serial Nbr.',
  'Piece Count',
  'Heat Number',
  'Gross Weight',
  'OrderQty',
  'Container Qty',
  'Unit Cost',
  'Warehouse',
  'UOM',
  'Order Line Nbr',
] as const;
