export type Supplier = 'wuu-jing' | 'yuen-chang' | 'unknown';

export interface PackingListItem {
  lineNumber: number;
  inventoryId: string;
  lotSerialNbr: string;
  pieceCount: number;
  heatNumber: string;
  grossWeightLbs: number;
  containerQtyLbs: number;
  rawSize: string;
  warehouse?: string;
  finish?: string;
  containerNumber?: string;
  // Override fields - when set, these take precedence over calculated values
  orderQtyOverride?: number;
  unitCostOverride?: number;
}

export interface ParsedPackingList {
  supplier: Supplier;
  vendorCode: string;
  poNumber: string;
  items: PackingListItem[];
  totalGrossWeightLbs: number;
  totalNetWeightLbs: number;
  warehouse?: string;
  containers?: string[]; // List of unique container numbers
}

export interface UploadedFile {
  id: string;
  name: string;
  type: 'pdf' | 'excel';
  file: File;
  status: 'pending' | 'processing' | 'completed' | 'error';
  error?: string;
  result?: ParsedPackingList;
}

export interface ConversionResult {
  success: boolean;
  data?: ParsedPackingList;
  error?: string;
}

export interface AcumaticaRow {
  orderNumber: string;
  vendor: string;
  inventoryId: string;
  lotSerialNbr: string;
  pieceCount: number;
  heatNumber: string;
  grossWeight: number;
  orderQty: number;
  container: number;
  unitCost: number;
  warehouse: string;
  uom: string;
  orderLineNbr: number;
}

export interface PageScore {
  pageNumber: number;
  score: number;
  isPackingList: boolean;
  text: string;
}

export interface ParsedSize {
  thickness: number;
  width: number;
  length: number;
  thicknessFormatted: string;
}

/**
 * Invoice line item with price data
 */
export interface InvoiceLineItem {
  size: string;           // Size string (e.g., "3/16" x 48" x 120"")
  pcs: number;            // Piece count
  qtyLbs: number;         // Weight in lbs
  pricePerPiece: number;  // USD per piece
  pricePerLb: number;     // Calculated: pricePerPiece / (qtyLbs / pcs)
}

/**
 * Parsed invoice data
 */
export interface ParsedInvoice {
  supplier: Supplier;
  poNumber: string;       // EXCEL ORDER # for matching
  invoiceNumber: string;  // Invoice reference number
  items: InvoiceLineItem[];
  totalValue: number;
}
