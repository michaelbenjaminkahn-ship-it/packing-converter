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

// Default warehouse
export const DEFAULT_WAREHOUSE = 'LA';

// Warehouses
export const WAREHOUSES = ['LA', 'Baltimore', 'Houston'] as const;

// Acumatica output columns
export const ACUMATICA_COLUMNS = [
  'Order Number',
  'Vendor',
  'Inventory ID',
  'Lot/Serial',
  'Piece Count',
  'Heat Number',
  'Gross Weight',
  'OrderQty',
  'Container',
  'Unit Cost',
  'Warehouse',
  'UOM',
  'Order Line Nbr',
] as const;
