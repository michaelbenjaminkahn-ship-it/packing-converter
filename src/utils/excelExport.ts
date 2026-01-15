import * as XLSX from 'xlsx';
import { ParsedPackingList, AcumaticaRow } from '../types';
import { ACUMATICA_COLUMNS, DEFAULT_WAREHOUSE } from './constants';

/**
 * Convert parsed packing list to Acumatica format rows
 */
export function toAcumaticaRows(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE
): AcumaticaRow[] {
  return packingList.items.map((item) => ({
    orderNumber: packingList.poNumber,
    vendor: packingList.vendorCode,
    inventoryId: item.inventoryId,
    lotSerialNbr: item.lotSerialNbr,
    pieceCount: item.pieceCount,
    heatNumber: item.heatNumber,
    grossWeight: item.grossWeightLbs,
    orderQty: '',
    containerQty: item.containerQtyLbs,
    unitCost: '',
    warehouse,
    uom: 'LB',
    orderLineNbr: '',
  }));
}

/**
 * Export parsed packing list to Excel file for Acumatica
 */
export function exportToExcel(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE
): Blob {
  // Convert to Acumatica rows
  const rows = toAcumaticaRows(packingList, warehouse);

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
  filename?: string
): void {
  const blob = exportToExcel(packingList, warehouse);
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
  warehouse: string = DEFAULT_WAREHOUSE
): Blob {
  const wb = XLSX.utils.book_new();

  packingLists.forEach((packingList, index) => {
    const rows = toAcumaticaRows(packingList, warehouse);

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
