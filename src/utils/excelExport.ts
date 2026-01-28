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
 * Calculate theoretical weights from dimensions using Yoshi's lookup table
 * Formula: Lbs/Pc = (Width × Length / 144) × Lbs/Sq Ft
 * Returns both steel weight (for Order Qty & Container) and total weight with skid (for Gross)
 */
function calculateTheoreticalWeights(item: PackingListItem): { steelWeight: number; totalWeight: number } {
  // Parse dimensions from inventory ID: "0.188-60__-144__-304/304L-#1____"
  const match = item.inventoryId.match(/^([\d.]+)-(\d+)__-(\d+)__-/);
  if (!match) {
    // Fallback to actual weight if can't parse
    return { steelWeight: item.grossWeightLbs, totalWeight: item.grossWeightLbs };
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

  // Add skid weight for #1 finish items (only to total, not to pure steel weight)
  let totalWeight = steelWeight;
  if (isHotRolledFinish(item.inventoryId)) {
    totalWeight += getSkidWeight(length);
  }

  // Round steelWeight to 2 decimals for Order Qty precision, totalWeight to whole number for Gross
  return { steelWeight: Math.round(steelWeight * 100) / 100, totalWeight: Math.round(totalWeight) };
}

/**
 * Get weight based on weight type selection
 * Returns: gross (with skid for #1), net/container (pure steel), orderQty (pure steel)
 */
function getWeight(item: PackingListItem, weightType: WeightType): { gross: number; net: number; orderQty: number } {
  if (weightType === 'theoretical') {
    const { steelWeight, totalWeight } = calculateTheoreticalWeights(item);
    // Gross: includes skid weight for #1 finish (what's on the scale)
    // Net/Container: pure steel weight only (inventory weight)
    // OrderQty: pure steel weight only (sum per SKU)
    return { gross: totalWeight, net: steelWeight, orderQty: steelWeight };
  }
  return { gross: item.grossWeightLbs, net: item.containerQtyLbs, orderQty: item.containerQtyLbs };
}

/**
 * Calculate order quantity totals per SKU from a packing list
 * Scoped by PO number for multi-PO packing lists
 * Key format: "PO:inventoryId" to separate quantities per PO
 */
export function calculateOrderQtyBySku(
  packingList: ParsedPackingList,
  weightType: WeightType = 'actual'
): Record<string, number> {
  const orderQtyBySku: Record<string, number> = {};
  packingList.items.forEach((item) => {
    const weights = getWeight(item, weightType);
    // Use item-level PO if available, otherwise fall back to packing list PO
    const itemPo = item.poNumber || packingList.poNumber;
    // Key by PO:inventoryId to separate quantities per PO
    const key = `${itemPo}:${item.inventoryId}`;
    if (!orderQtyBySku[key]) {
      orderQtyBySku[key] = 0;
    }
    orderQtyBySku[key] += weights.orderQty;
  });
  return orderQtyBySku;
}

/**
 * Convert parsed packing list to Acumatica format rows
 * @param packingList - The packing list to convert
 * @param warehouse - Default warehouse code
 * @param weightType - Whether to use actual or theoretical weights
 * @param preCalculatedOrderQty - Optional pre-calculated order quantities per SKU
 *                                (used when splitting by container to preserve full PO totals)
 *                                Key format: "PO:inventoryId"
 */
export function toAcumaticaRows(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual',
  preCalculatedOrderQty?: Record<string, number>
): AcumaticaRow[] {
  // Use pre-calculated totals if provided, otherwise calculate from this packing list
  const orderQtyBySku = preCalculatedOrderQty || calculateOrderQtyBySku(packingList, weightType);

  return packingList.items.map((item) => {
    const weights = getWeight(item, weightType);

    // Use item-level PO if available, otherwise fall back to packing list PO
    const itemPo = item.poNumber || packingList.poNumber;
    // Strip any suffix (e.g., "-5") from PO number for the Order Number column
    const orderNumber = itemPo.replace(/-\d+$/, '');

    // Unit cost: blank by default - price data comes from invoice, not packing list
    // User can manually enter via unitCostOverride
    const unitCost = item.unitCostOverride ?? 0;

    // OrderQty: use override if set, otherwise calculated per SKU (scoped by PO)
    const orderQtyKey = `${itemPo}:${item.inventoryId}`;
    const orderQty = item.orderQtyOverride ?? orderQtyBySku[orderQtyKey] ?? 0;

    // Warehouse: use item-level override if set
    const itemWarehouse = item.warehouse || warehouse;

    // Order Line Nbr: use override if set, otherwise blank (0)
    const orderLineNbr = item.orderLineNbrOverride ?? 0;

    return {
      orderNumber,
      vendor: packingList.vendorCode,
      inventoryId: item.inventoryId,
      lotSerialNbr: item.lotSerialNbr,
      pieceCount: item.pieceCount,
      heatNumber: item.heatNumber,
      grossWeight: weights.gross,
      orderQty, // Sum of container qty for this SKU within same PO, or override
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
 * @param packingList - The packing list to export
 * @param warehouse - Default warehouse code
 * @param weightType - Whether to use actual or theoretical weights
 * @param preCalculatedOrderQty - Optional pre-calculated order quantities per SKU
 *                                (used when splitting by container to preserve full PO totals)
 */
export function exportToExcel(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual',
  preCalculatedOrderQty?: Record<string, number>
): Blob {
  // Convert to Acumatica rows
  const rows = toAcumaticaRows(packingList, warehouse, weightType, preCalculatedOrderQty);

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

  // Apply number formats
  for (let rowIdx = 1; rowIdx <= rows.length; rowIdx++) {
    // Order Qty column (H, index 7) - 2 decimal places
    const orderQtyRef = XLSX.utils.encode_cell({ r: rowIdx, c: 7 });
    if (ws[orderQtyRef] && typeof ws[orderQtyRef].v === 'number') {
      ws[orderQtyRef].z = '#,##0.00';
    }
    // Unit Cost column (J, index 9) - 4 decimal places
    const unitCostRef = XLSX.utils.encode_cell({ r: rowIdx, c: 9 });
    if (ws[unitCostRef] && typeof ws[unitCostRef].v === 'number') {
      ws[unitCostRef].z = '0.0000';
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
 * Split packing list by container (and PO for multi-PO files) and download separate files
 * Preserves full PO order quantities on each container's export
 */
export function downloadByContainer(
  packingList: ParsedPackingList,
  warehouse: string = DEFAULT_WAREHOUSE,
  weightType: WeightType = 'actual'
): void {
  // Group items by container AND PO (for multi-PO packing lists)
  const groupedItems = new Map<string, PackingListItem[]>();

  packingList.items.forEach(item => {
    const itemPo = item.poNumber || packingList.poNumber;
    const container = item.containerNumber || '';
    const key = `${itemPo}|${container}`;

    if (!groupedItems.has(key)) {
      groupedItems.set(key, []);
    }
    groupedItems.get(key)!.push(item);
  });

  if (groupedItems.size <= 1) {
    // Only one group, download as single file
    const firstGroup = groupedItems.entries().next().value;
    if (firstGroup) {
      const [key] = firstGroup;
      const [po, container] = key.split('|');
      const filename = generateFilename(po, container || undefined);
      downloadExcel(packingList, warehouse, weightType, filename);
    }
    return;
  }

  // Calculate full PO order quantities ONCE from the complete packing list
  // This ensures each container's export shows the total PO quantity, not just that container's portion
  const fullOrderQtyBySku = calculateOrderQtyBySku(packingList, weightType);

  // Multiple groups - create separate files for each PO/container combination
  groupedItems.forEach((items, key) => {
    const [po, container] = key.split('|');

    const groupPackingList: ParsedPackingList = {
      ...packingList,
      poNumber: po,
      items: items,
      totalGrossWeightLbs: items.reduce((sum, item) => sum + item.grossWeightLbs, 0),
      totalNetWeightLbs: items.reduce((sum, item) => sum + item.containerQtyLbs, 0),
    };

    // Pass the full PO order quantities to preserve totals
    const blob = exportToExcel(groupPackingList, warehouse, weightType, fullOrderQtyBySku);
    const url = URL.createObjectURL(blob);

    const filename = generateFilename(po, container || undefined);
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

    // Apply number formats
    for (let rowIdx = 1; rowIdx <= rows.length; rowIdx++) {
      // Order Qty column (H, index 7) - 2 decimal places
      const orderQtyRef = XLSX.utils.encode_cell({ r: rowIdx, c: 7 });
      if (ws[orderQtyRef] && typeof ws[orderQtyRef].v === 'number') {
        ws[orderQtyRef].z = '#,##0.00';
      }
      // Unit Cost column (J, index 9) - 4 decimal places
      const unitCostRef = XLSX.utils.encode_cell({ r: rowIdx, c: 9 });
      if (ws[unitCostRef] && typeof ws[unitCostRef].v === 'number') {
        ws[unitCostRef].z = '0.0000';
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
