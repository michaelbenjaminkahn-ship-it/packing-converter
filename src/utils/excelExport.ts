import * as XLSX from 'xlsx';
import { ParsedPackingList, AcumaticaRow, PackingListItem } from '../types';
import { ACUMATICA_COLUMNS, DEFAULT_WAREHOUSE } from './constants';

export type WeightType = 'actual' | 'theoretical';

// Steel density: 0.2833 lbs per cubic inch (for 304 stainless)
const STEEL_DENSITY_LBS_PER_CUBIC_INCH = 0.2833;

/**
 * Calculate theoretical weight from dimensions
 * thickness, width, length in inches
 */
function calculateTheoreticalWeight(item: PackingListItem): number {
  // Parse dimensions from inventory ID: "0.188-60__-144__-304/304L-#1____"
  const match = item.inventoryId.match(/^([\d.]+)-(\d+)__-(\d+)__-/);
  if (!match) {
    // Fallback to actual weight if can't parse
    return item.grossWeightLbs;
  }

  const thickness = parseFloat(match[1]);
  const width = parseFloat(match[2]);
  const length = parseFloat(match[3]);

  // Volume in cubic inches
  const volumePerPiece = thickness * width * length;

  // Weight per piece in pounds
  const weightPerPiece = volumePerPiece * STEEL_DENSITY_LBS_PER_CUBIC_INCH;

  // Total weight for all pieces
  const totalWeight = weightPerPiece * item.pieceCount;

  return Math.round(totalWeight);
}

/**
 * Get weight based on weight type selection
 */
function getWeight(item: PackingListItem, weightType: WeightType): { gross: number; net: number } {
  if (weightType === 'theoretical') {
    const theoretical = calculateTheoreticalWeight(item);
    return { gross: theoretical, net: theoretical };
  }
  return { gross: item.grossWeightLbs, net: item.containerQtyLbs };
}

/**
 * Convert parsed packing list to Acumatica format rows
 */
export function toAcumaticaRows(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual'
): AcumaticaRow[] {
  return packingList.items.map((item) => {
    const weights = getWeight(item, weightType);
    return {
      orderNumber: packingList.poNumber,
      vendor: packingList.vendorCode,
      inventoryId: item.inventoryId,
      lotSerialNbr: item.lotSerialNbr,
      pieceCount: item.pieceCount,
      heatNumber: item.heatNumber,
      grossWeight: weights.gross,
      orderQty: '',
      containerQty: weights.net,
      unitCost: '',
      warehouse,
      uom: 'LB',
      orderLineNbr: '',
    };
  });
}

/**
 * Export parsed packing list to Excel file for Acumatica
 */
export function exportToExcel(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual'
): Blob {
  // Convert to Acumatica rows
  const rows = toAcumaticaRows(packingList, warehouse, weightType);

  // Create worksheet data with headers
  const wsData: (string | number)[][] = [
    [...ACUMATICA_COLUMNS],
    ...rows.map((row) => [
      row.orderNumber,
      row.vendor,
      row.inventoryId,
      row.lotSerialNbr,
      row.pieceCount,
      row.heatNumber,
      row.grossWeight,
      row.orderQty,
      row.containerQty,
      row.unitCost,
      row.warehouse,
      row.uom,
      row.orderLineNbr,
    ]),
  ];

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Set column widths
  ws['!cols'] = [
    { wch: 12 }, // Order Number
    { wch: 10 }, // Vendor
    { wch: 35 }, // Inventory ID
    { wch: 15 }, // Lot/Serial Nbr.
    { wch: 12 }, // Piece Count
    { wch: 12 }, // Heat Number
    { wch: 12 }, // Gross Weight
    { wch: 10 }, // OrderQty
    { wch: 14 }, // Container Qty
    { wch: 10 }, // Unit Cost
    { wch: 12 }, // Warehouse
    { wch: 6 },  // UOM
    { wch: 14 }, // Order Line Nbr
  ];

  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(wb, ws, 'Packing List');

  // Generate Excel file as blob
  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Trigger download of Excel file
 */
export function downloadExcel(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual',
  filename?: string
): void {
  const blob = exportToExcel(packingList, warehouse, weightType);
  const url = URL.createObjectURL(blob);

  const defaultFilename = `PO${packingList.poNumber}_converted.xlsx`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || defaultFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Export multiple packing lists to a single Excel file with multiple sheets
 */
export function exportMultipleToExcel(
  packingLists: ParsedPackingList[],
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual'
): Blob {
  const wb = XLSX.utils.book_new();

  packingLists.forEach((packingList, index) => {
    const rows = toAcumaticaRows(packingList, warehouse, weightType);

    const wsData: (string | number)[][] = [
      [...ACUMATICA_COLUMNS],
      ...rows.map((row) => [
        row.orderNumber,
        row.vendor,
        row.inventoryId,
        row.lotSerialNbr,
        row.pieceCount,
        row.heatNumber,
        row.grossWeight,
        row.orderQty,
        row.containerQty,
        row.unitCost,
        row.warehouse,
        row.uom,
        row.orderLineNbr,
      ]),
    ];

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Set column widths
    ws['!cols'] = [
      { wch: 12 },
      { wch: 10 },
      { wch: 35 },
      { wch: 15 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 10 },
      { wch: 14 },
      { wch: 10 },
      { wch: 12 },
      { wch: 6 },
      { wch: 14 },
    ];

    const sheetName = packingList.poNumber
      ? `PO ${packingList.poNumber}`
      : `Sheet ${index + 1}`;

    XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31)); // Excel sheet name limit
  });

  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
