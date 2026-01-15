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
