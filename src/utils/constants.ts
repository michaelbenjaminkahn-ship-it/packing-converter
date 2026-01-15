// Conversion factor: 1 metric ton = 2204.62 pounds
export const MT_TO_LBS = 2204.62;

// Supplier detection keywords
export const SUPPLIER_KEYWORDS = {
  'wuu-jing': ['wuu jing', 'wuu-jing', 'wuujing', '五井'],
  'yuen-chang': ['yuen chang', 'yuen-chang', 'yuenchang', '元昌'],
} as const;

// Common steel size patterns (e.g., "3/8 x 4", "1/2 x 6", etc.)
export const SIZE_PATTERN = /(\d+\/\d+|\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/;

// Packing list detection keywords
export const PACKING_LIST_KEYWORDS = [
  'packing list',
  'packing-list',
  'packinglist',
  'shipping list',
  '裝箱單',
  '装箱单',
];

// Invoice keywords (to exclude)
export const INVOICE_KEYWORDS = [
  'commercial invoice',
  'proforma invoice',
  'invoice no',
  '發票',
  '发票',
];

// Mill certificate keywords (to exclude)
export const MILL_CERT_KEYWORDS = [
  'mill certificate',
  'mill test',
  'test certificate',
  'material certificate',
  '品質證明',
  '材質證明',
];
