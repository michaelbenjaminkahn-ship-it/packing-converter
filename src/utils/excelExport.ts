import * as XLSX from 'xlsx';
import { ParsedPackingList, AcumaticaRow, PackingListItem } from '../types';
import { ACUMATICA_COLUMNS, DEFAULT_WAREHOUSE, getLbsPerSqFt } from './constants';

export type WeightType = 'actual' | 'theoretical';

// Fallback steel density: 0.2833 lbs per cubic inch (for 304 stainless)
// Used only when thickness is not in lookup table
const STEEL_DENSITY_LBS_PER_CUBIC_INCH = 0.2833;

/**
 * Check if finish is #1 (hot rolled)
 */
function isHotRolledFinish(inventoryId: string): boolean {
  const match = inventoryId.match(/#1|#4|#8|2B|BA/i);
  const finish = match ? match[0].toUpperCase() : null;
  return finish === '#1';
}

/**
 * Get skid weight based on length for #1 finish items
 * 96" or 120" → 40 lbs
 * > 120" → 55 lbs
 */
function getSkidWeight(lengthInches: number): number {
  if (lengthInches <= 120) {
    return 40;
  }
  return 55;
}

/**
 * Calculate theoretical weight from dimensions using Yoshi's lookup table
 * Formula: Lbs/Pc = (Width × Length / 144) × Lbs/Sq Ft
 * For #1 finish items, adds skid weight based on length
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

  // Try to use lookup table first
  const lbsPerSqFt = getLbsPerSqFt(thickness);

  let steelWeight: number;
  if (lbsPerSqFt !== null) {
    // Use lookup table: Lbs/Pc = (Width × Length / 144) × Lbs/Sq Ft × pieceCount
    const sqFt = (width * length) / 144;
    steelWeight = sqFt * lbsPerSqFt * item.pieceCount;
  } else {
    // Fallback to density calculation
    const volumePerPiece = thickness * width * length;
    const weightPerPiece = volumePerPiece * STEEL_DENSITY_LBS_PER_CUBIC_INCH;
    steelWeight = weightPerPiece * item.pieceCount;
  }

  // Add skid weight for #1 finish items
  let totalWeight = steelWeight;
  if (isHotRolledFinish(item.inventoryId)) {
    totalWeight += getSkidWeight(length);
  }

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
  // Pre-calculate OrderQty per SKU (sum of container quantities for items with same inventoryId)
  const orderQtyBySku: Record<string, number> = {};
  packingList.items.forEach((item) => {
    const weights = getWeight(item, weightType);
    if (!orderQtyBySku[item.inventoryId]) {
      orderQtyBySku[item.inventoryId] = 0;
    }
    orderQtyBySku[item.inventoryId] += weights.net;
  });

  return packingList.items.map((item) => {
    const weights = getWeight(item, weightType);
    // Unit cost: blank by default - price data comes from invoice, not packing list
    // User can manually enter via unitCostOverride
    const unitCost = item.unitCostOverride ?? 0;

    // OrderQty: use override if set, otherwise calculated per SKU
    const orderQty = item.orderQtyOverride ?? orderQtyBySku[item.inventoryId];

    // Warehouse: use item-level override if set
    const itemWarehouse = item.warehouse || warehouse;

    // Order Line Nbr: use override if set, otherwise blank (0)
    const orderLineNbr = item.orderLineNbrOverride ?? 0;

    return {
      orderNumber: packingList.poNumber,
      vendor: packingList.vendorCode,
      inventoryId: item.inventoryId,
      lotSerialNbr: item.lotSerialNbr,
      pieceCount: item.pieceCount,
      heatNumber: item.heatNumber,
      grossWeight: weights.gross,
      orderQty, // Sum of container qty for this SKU, or override
      container: weights.net, // Individual line container qty
      unitCost,
      warehouse: itemWarehouse,
      uom: 'LB',
      orderLineNbr,
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
      row.container,
      row.unitCost,
      row.warehouse,
      row.uom,
      row.orderLineNbr,
    ]),
  ];

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Apply 4 decimal place format to Unit Cost column (column J, index 9)
  const unitCostColIndex = 9; // 0-indexed: J column
  for (let rowIdx = 1; rowIdx <= rows.length; rowIdx++) {
    const cellRef = XLSX.utils.encode_cell({ r: rowIdx, c: unitCostColIndex });
    if (ws[cellRef] && typeof ws[cellRef].v === 'number') {
      ws[cellRef].z = '0.0000'; // 4 decimal places
    }
  }

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
 * Generate filename in format: PO#1726 Container#TCLU7614333.xlsx
 */
function generateFilename(poNumber: string, containerNumber: string | undefined): string {
  const poStr = poNumber && poNumber !== 'UNKNOWN' ? poNumber : 'Unknown';
  const containerStr = containerNumber || `TEMP${Date.now().toString().slice(-6)}`;
  return `PO#${poStr} Container#${containerStr}.xlsx`;
}

/**
 * Split packing list by container and download separate files
 */
export function downloadByContainer(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual'
): void {
  // Get unique container numbers
  const containers = [...new Set(packingList.items.map(item => item.containerNumber).filter(Boolean))];

  if (containers.length <= 1) {
    // Only one or no containers, download as single file
    const containerNum = containers[0];
    const filename = generateFilename(packingList.poNumber, containerNum);
    downloadExcel(packingList, warehouse, weightType, filename);
    return;
  }

  // Multiple containers - create separate files
  containers.forEach((containerNum) => {
    const containerItems = packingList.items.filter(item => item.containerNumber === containerNum);

    const containerPackingList: ParsedPackingList = {
      ...packingList,
      items: containerItems,
      totalGrossWeightLbs: containerItems.reduce((sum, item) => sum + item.grossWeightLbs, 0),
      totalNetWeightLbs: containerItems.reduce((sum, item) => sum + item.containerQtyLbs, 0),
    };

    const blob = exportToExcel(containerPackingList, warehouse, weightType);
    const url = URL.createObjectURL(blob);

    const filename = generateFilename(packingList.poNumber, containerNum);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
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
        row.container,
        row.unitCost,
        row.warehouse,
        row.uom,
        row.orderLineNbr,
      ]),
    ];

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Apply 4 decimal place format to Unit Cost column (column J, index 9)
    const unitCostColIndex = 9;
    for (let rowIdx = 1; rowIdx <= rows.length; rowIdx++) {
      const cellRef = XLSX.utils.encode_cell({ r: rowIdx, c: unitCostColIndex });
      if (ws[cellRef] && typeof ws[cellRef].v === 'number') {
        ws[cellRef].z = '0.0000';
      }
    }

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
