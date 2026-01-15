export type Supplier = 'wuu-jing' | 'yuen-chang' | 'unknown';

export interface PackingListItem {
  lineNumber: number;
  inventoryId: string;
  description: string;
  quantity: number;
  weightMT: number;
  weightLbs: number;
  heatNumber?: string;
  bundleNumber?: string;
}

export interface ParsedPackingList {
  supplier: Supplier;
  poNumber?: string;
  invoiceNumber?: string;
  shipDate?: string;
  items: PackingListItem[];
  totalWeightMT: number;
  totalWeightLbs: number;
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
