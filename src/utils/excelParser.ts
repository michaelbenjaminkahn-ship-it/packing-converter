import * as XLSX from 'xlsx';
import { PackingListItem, ParsedPackingList, Supplier } from '../types';
import { detectSupplier, scorePageAsPackingList } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs, extractWarehouse, parseYeouYihSize } from './conversion';
import { VENDOR_CODES } from './constants';

/**
 * Invoice price data from WJ INVOICE tab
 */
interface InvoicePriceData {
  size: string;           // Size string (e.g., "3/16"*48"*96")
  pricePerPiece: number;  // USD per piece
  weightPerPieceLbs: number; // Weight per piece in lbs
  pricePerLb: number;     // Calculated: pricePerPiece / weightPerPieceLbs
}

/**
 * Parse an Excel file and extract packing list data
 */
export async function parseExcel(file: File, poNumber: string): Promise<ParsedPackingList> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  // Search ALL sheets for PO number and warehouse (they might be on invoice sheet)
  let extractedPo = '';
  let extractedWarehouse = '';
  let warehouseDetected = false;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];

    if (!extractedPo) {
      extractedPo = extractPoFromExcel(data);
    }
    if (!warehouseDetected) {
      const result = extractWarehouseFromExcel(data);
      if (result.detected) {
        extractedWarehouse = result.warehouse;
        warehouseDetected = true;
      }
    }
    if (extractedPo && warehouseDetected) break;
  }

  // Try to parse INVOICE sheet for price data (Wuu Jing only)
  let invoicePrices: Map<string, InvoicePriceData> = new Map();
  const invoiceSheet = workbook.SheetNames.find(name => name.toLowerCase() === 'invoice');
  if (invoiceSheet) {
    const sheet = workbook.Sheets[invoiceSheet];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
    invoicePrices = parseWuuJingInvoice(data);
  }

  // Find the sheet most likely to be a packing list
  const bestSheet = findPackingListSheet(workbook);

  if (!bestSheet) {
    throw new Error('Could not identify packing list sheet in Excel file');
  }

  // Convert sheet to text for detection
  const sheetText = bestSheet.data.map(row => (row || []).join(' ')).join('\n');

  // Detect supplier from sheet content
  const supplier = detectSupplier(sheetText);

  // Use provided PO (if valid), or extracted from any sheet
  const validPoNumber = poNumber && poNumber !== 'UNKNOWN' ? poNumber : '';
  const finalPoNumber = validPoNumber || extractedPo || 'UNKNOWN';

  // Use warehouse from best sheet, or from any sheet if not found
  const sheetWarehouseResult = extractWarehouseFromExcel(bestSheet.data);
  let warehouse: string;
  let finalWarehouseDetected: boolean;
  if (sheetWarehouseResult.detected) {
    warehouse = sheetWarehouseResult.warehouse;
    finalWarehouseDetected = true;
  } else if (warehouseDetected) {
    warehouse = extractedWarehouse;
    finalWarehouseDetected = true;
  } else {
    warehouse = 'LA';
    finalWarehouseDetected = false;
  }

  // Parse the data based on supplier
  let items: PackingListItem[];
  let detectedSupplier = supplier;

  if (supplier === 'yuen-chang') {
    items = parseYuenChangExcel(bestSheet.data, finalPoNumber);
  } else if (supplier === 'wuu-jing') {
    items = parseWuuJingExcel(bestSheet.data, finalPoNumber);
  } else if (supplier === 'yeou-yih') {
    items = parseYeouYihExcel(bestSheet.data, finalPoNumber);
  } else {
    // Unknown supplier - try all parsers and use whichever gets most items
    const wuuJingItems = parseWuuJingExcel(bestSheet.data, finalPoNumber);
    const yuenChangItems = parseYuenChangExcel(bestSheet.data, finalPoNumber);
    const yeouYihItems = parseYeouYihExcel(bestSheet.data, finalPoNumber);

    // Find the parser with most items
    const results = [
      { items: wuuJingItems, supplier: 'wuu-jing' as Supplier },
      { items: yuenChangItems, supplier: 'yuen-chang' as Supplier },
      { items: yeouYihItems, supplier: 'yeou-yih' as Supplier },
    ];
    const best = results.reduce((a, b) => a.items.length >= b.items.length ? a : b);

    if (best.items.length > 0) {
      items = best.items;
      detectedSupplier = best.supplier;
    } else {
      items = [];
    }
  }

  if (items.length === 0) {
    throw new Error('Could not parse any items from packing list');
  }

  // Apply invoice prices to items (Wuu Jing only)
  if (detectedSupplier === 'wuu-jing' && invoicePrices.size > 0) {
    items.forEach(item => {
      // Try to find matching price by rawSize
      const priceData = findMatchingPrice(item.rawSize, invoicePrices);
      if (priceData) {
        item.unitCostOverride = priceData.pricePerLb;
      }
    });
  }

  // Calculate totals
  const totalGrossWeightLbs = items.reduce((sum, item) => sum + item.grossWeightLbs, 0);
  const totalNetWeightLbs = items.reduce((sum, item) => sum + item.containerQtyLbs, 0);

  // Get unique container numbers
  const containers = [...new Set(items.map(item => item.containerNumber).filter(Boolean))] as string[];

  return {
    supplier: detectedSupplier,
    vendorCode: VENDOR_CODES[detectedSupplier] || '',
    poNumber: finalPoNumber,
    items,
    totalGrossWeightLbs,
    totalNetWeightLbs,
    warehouse,
    warehouseDetected: finalWarehouseDetected,
    containers,
  };
}

/**
 * Find the best sheet for packing list data
 * Prioritizes sheets named "PACKING" or similar
 */
function findPackingListSheet(workbook: XLSX.WorkBook): { name: string; data: unknown[][] } | null {
  // Priority 1: Look for sheet named "PACKING" or "PACKING LIST"
  const packingSheetNames = ['packing', 'packing list', 'packing lists', 'packinglist'];
  for (const sheetName of workbook.SheetNames) {
    if (packingSheetNames.includes(sheetName.toLowerCase().trim())) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
      return { name: sheetName, data };
    }
  }

  // Priority 2: Score each sheet and pick the best
  let bestSheet: { name: string; score: number; data: unknown[][] } | null = null;

  for (const sheetName of workbook.SheetNames) {
    // Skip obvious non-packing sheets
    const lowerName = sheetName.toLowerCase();
    if (lowerName === 'invoice' || lowerName === 'mark' || lowerName === 'marks') {
      continue;
    }

    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
    const text = data.map(row => row ? (row as unknown[]).join(' ') : '').join('\n');
    const score = scorePageAsPackingList(text);

    if (!bestSheet || score > bestSheet.score) {
      bestSheet = { name: sheetName, score, data };
    }
  }

  if (bestSheet && bestSheet.score >= 20) {
    return { name: bestSheet.name, data: bestSheet.data };
  }

  // Fallback: return first sheet
  if (workbook.SheetNames.length > 0) {
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
    return { name: sheetName, data };
  }

  return null;
}

/**
 * Extract PO number from Excel header rows
 * Looks for patterns like "ORDER NO.: 001772" or "EXCEL ORDER # 001726"
 */
function extractPoFromExcel(data: unknown[][]): string {
  // Search all rows for ORDER patterns
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    // Check each cell individually first (more reliable than joining)
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const cellStr = String(cell ?? '').trim();
      const cellUpper = cellStr.toUpperCase();

      // Skip empty cells
      if (!cellStr) continue;

      // Check if cell contains ORDER-related text
      if (cellUpper.includes('ORDER')) {
        // Comprehensive regex that handles:
        // - "EXCEL METALS LLC ORDER NO.: 001772" (Wuu Jing)
        // - "EXCEL ORDER # 001726" (Yuen Chang)
        // - "ORDER NO.: 001772"
        // - "ORDER # 1726"
        const fullMatch = cellStr.match(/ORDER\s*(?:NO\.?)?\s*[#:]?\s*:?\s*0*(\d{3,6})/i);
        if (fullMatch) {
          return fullMatch[1];
        }

        // Cell has ORDER but no number - check adjacent cells
        for (let k = j + 1; k < Math.min(j + 5, row.length); k++) {
          const nextCell = row[k];
          let numValue: string;

          if (typeof nextCell === 'number') {
            // Excel stores "001772" as number 1772
            numValue = String(nextCell);
          } else {
            // Strip leading zeros from string
            numValue = String(nextCell ?? '').trim().replace(/^0+/, '');
          }

          // Check if it's a valid PO number (3-6 digits)
          if (/^\d{3,6}$/.test(numValue)) {
            return numValue;
          }
        }
      }
    }

    // Also try joining the row and matching (backup approach)
    const rowText = row.map(cell => String(cell ?? '')).join(' ');

    // Flexible pattern that handles various formats
    const flexMatch = rowText.match(/ORDER\s*(?:NO\.?)?\s*[#:]?\s*:?\s*0*(\d{3,6})/i);
    if (flexMatch) {
      return flexMatch[1];
    }
  }

  // SECOND: Try to extract from bundle numbers in data rows (e.g., 001772-01 -> PO 1772)
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    for (const cell of row) {
      const cellStr = String(cell ?? '');
      // Match bundle pattern: 6 digits followed by dash and 2 digits
      const bundleMatch = cellStr.match(/(\d{6})-\d{2}/);
      if (bundleMatch) {
        const po = bundleMatch[1].replace(/^0+/, '') || bundleMatch[1];
        return po;
      }
    }
  }

  return '';
}

/**
 * Extract warehouse/destination from Excel header rows
 * Returns { warehouse, detected } where detected indicates if found in data
 */
function extractWarehouseFromExcel(data: unknown[][]): { warehouse: string; detected: boolean } {
  // Search first 15 rows for destination
  for (let i = 0; i < Math.min(data.length, 15); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ');

    // Use the existing extractWarehouse function
    const result = extractWarehouse(rowText);
    if (result.detected) {
      return result;
    }
  }

  return { warehouse: 'LA', detected: false };
}

/**
 * Parse Wuu Jing Excel format
 * Columns: NO, SIZE, PC, BUNDLE NO., PRODUCT NO., CONTAINER NO., N'WEIGHT (MT), G'WEIGHT (MT)
 */
function parseWuuJingExcel(data: unknown[][], poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Find header row
  const headerRowIndex = findHeaderRow(data, ['size', 'bundle', 'weight']);
  if (headerRowIndex === -1) {
    return parseExcelWithoutHeaders(data, 'wuu-jing', poNumber);
  }

  const headerRow = data[headerRowIndex] || [];
  const headers = headerRow.map(h => String(h ?? '').toLowerCase().trim());

  // Map column indices for Wuu Jing
  const colMap = {
    no: findColumnIndex(headers, ['no', 'no.']),
    size: findColumnIndex(headers, ['size', 'specification']),
    pc: findColumnIndex(headers, ['pc', 'pcs']),
    bundleNo: findColumnIndex(headers, ['bundle no', 'bundle no.', 'bundle']),
    containerNo: findColumnIndex(headers, ['container no', 'container no.', 'container']),
    netWeight: findColumnIndex(headers, ['n\'weight', 'nweight', 'n weight', 'net']),
    grossWeight: findColumnIndex(headers, ['g\'weight', 'gweight', 'g weight', 'gross']),
  };

  // Extract finish from header area (before the data table)
  const finish = extractFinishFromExcel(data, headerRowIndex);

  // Parse data rows
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    // Skip total rows
    const firstCell = String(row[0] ?? '').toLowerCase();
    if (firstCell.includes('total') || firstCell.includes('subtotal')) continue;

    // Get size string
    const sizeStr = colMap.size >= 0 ? String(row[colMap.size] || '') : '';
    if (!sizeStr || !sizeStr.includes('*')) continue;

    const size = parseSize(sizeStr, 'wuu-jing');
    if (!size) continue;

    const lineNo = colMap.no >= 0 ? parseInt(String(row[colMap.no]), 10) : items.length + 1;
    const pc = colMap.pc >= 0 ? parseInt(String(row[colMap.pc]), 10) : 1;
    const bundleNo = colMap.bundleNo >= 0 ? String(row[colMap.bundleNo] || '') : '';
    const containerNo = colMap.containerNo >= 0 ? String(row[colMap.containerNo] || '') : '';
    let netWeight = colMap.netWeight >= 0 ? parseFloat(String(row[colMap.netWeight])) : 0;
    let grossWeight = colMap.grossWeight >= 0 ? parseFloat(String(row[colMap.grossWeight])) : netWeight;

    // Skip if no valid data
    if (isNaN(lineNo) && !bundleNo) continue;

    // Convert MT to LBS
    netWeight = mtToLbs(netWeight);
    grossWeight = mtToLbs(grossWeight);

    // Use bundle number directly if it's in correct format, otherwise build it
    const lotSerial = bundleNo.match(/^\d{6}-\d{2}$/)
      ? bundleNo
      : buildLotSerialNbr(poNumber, bundleNo || String(lineNo));

    items.push({
      lineNumber: items.length + 1,
      inventoryId: buildInventoryId(size, 'wuu-jing', finish),
      lotSerialNbr: lotSerial,
      pieceCount: pc || 1,
      heatNumber: '',
      grossWeightLbs: grossWeight,
      containerQtyLbs: netWeight,
      rawSize: sizeStr,
      finish,
      containerNumber: containerNo,
    });
  }

  return items;
}

/**
 * Parse Yuen Chang Excel format
 * Columns: NO., Item, SIZE (GA), COIL NO., Heat NO., PCS, NETWEIGHT (lbs), GROSSWEIGHT (lbs)
 */
function parseYuenChangExcel(data: unknown[][], poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Find header row
  const headerRowIndex = findHeaderRow(data, ['size', 'item', 'heat', 'pcs']);
  if (headerRowIndex === -1) {
    return parseExcelWithoutHeaders(data, 'yuen-chang', poNumber);
  }

  const headerRow = data[headerRowIndex] || [];
  const headers = headerRow.map(h => String(h ?? '').toLowerCase().trim());

  // Map column indices for Yuen Chang
  const colMap = {
    no: findColumnIndex(headers, ['no', 'no.']),
    item: findColumnIndex(headers, ['item']),
    size: findColumnIndex(headers, ['size']),
    coilNo: findColumnIndex(headers, ['coil no', 'coil no.']),
    heatNo: findColumnIndex(headers, ['heat no', 'heat no.', 'heat']),
    pcs: findColumnIndex(headers, ['pcs', 'pc', 'qty']),
    netWeight: findColumnIndex(headers, ['netweight', 'net weight', 'net']),
    grossWeight: findColumnIndex(headers, ['grossweight', 'gross weight', 'gross']),
  };

  // Track current finish (can change with section headers)
  let currentFinish = '2B';
  // Track current container number
  let currentContainer = '';

  // Parse data rows
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ');
    const rowTextLower = rowText.toLowerCase();

    // Check for container number header (e.g., "CONTAINER NO. FFAU2098727")
    const containerMatch = rowText.match(/CONTAINER\s*NO\.?\s*:?\s*([A-Z]{4}\d{6,7}|\w+\d+)/i);
    if (containerMatch) {
      currentContainer = containerMatch[1].toUpperCase();
      continue; // Skip container header rows
    }

    // Check for section headers that indicate finish changes
    if (rowText.includes('304/304L')) {
      if (rowText.includes('#4') || rowText.includes('# 4')) {
        currentFinish = '#4';
      } else if (rowText.includes('2B')) {
        currentFinish = '2B';
      } else if (rowText.includes('BA')) {
        currentFinish = 'BA';
      }
      continue; // Skip section header rows
    }

    // Skip subtotal/order rows - check entire row text since column A might be empty
    if (rowTextLower.includes('total') || rowTextLower.includes('subtotal') ||
        rowTextLower.includes('excel order') || rowTextLower.includes('yc reference')) continue;

    // Get size string
    const sizeStr = colMap.size >= 0 ? String(row[colMap.size] || '') : '';
    if (!sizeStr || !sizeStr.toLowerCase().includes('ga')) continue;

    const size = parseSize(sizeStr, 'yuen-chang');
    if (!size) continue;

    const lineNo = colMap.no >= 0 ? parseInt(String(row[colMap.no]), 10) : items.length + 1;
    const itemCode = colMap.item >= 0 ? String(row[colMap.item] || '') : '';
    const coilNo = colMap.coilNo >= 0 ? String(row[colMap.coilNo] || '') : '';
    const heatNo = colMap.heatNo >= 0 ? String(row[colMap.heatNo] || '') : '';
    const pcs = colMap.pcs >= 0 ? parseInt(String(row[colMap.pcs]), 10) : 1;

    // Yuen Chang weights are already in LBS
    let netWeight = colMap.netWeight >= 0 ? parseFloat(String(row[colMap.netWeight]).replace(/,/g, '')) : 0;
    let grossWeight = colMap.grossWeight >= 0 ? parseFloat(String(row[colMap.grossWeight]).replace(/,/g, '')) : netWeight;

    // Skip if no valid data
    if (isNaN(pcs) || pcs <= 0) continue;

    // Round weights
    netWeight = Math.round(netWeight);
    grossWeight = Math.round(grossWeight);

    // Use item code as lot/serial (e.g., XL007)
    const lotSerial = itemCode.match(/^[A-Z]{2}\d{3}$/i)
      ? itemCode.toUpperCase()
      : buildLotSerialNbr(poNumber, itemCode || String(lineNo));

    items.push({
      lineNumber: items.length + 1,
      inventoryId: buildInventoryId(size, 'yuen-chang', currentFinish),
      lotSerialNbr: lotSerial,
      pieceCount: pcs || 1,
      heatNumber: heatNo || coilNo,
      grossWeightLbs: grossWeight,
      containerQtyLbs: netWeight,
      rawSize: sizeStr,
      finish: currentFinish,
      containerNumber: currentContainer,
    });
  }

  return items;
}

/**
 * Extract finish from Excel header area
 */
function extractFinishFromExcel(data: unknown[][], beforeRow: number): string {
  for (let i = 0; i < beforeRow; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ').toUpperCase();

    if (rowText.includes('NO.1') || rowText.includes('NO 1') || rowText.includes('#1')) {
      return '#1';
    }
    if (rowText.includes('2B')) {
      return '2B';
    }
    if (rowText.includes('#4') || rowText.includes('NO.4')) {
      return '#4';
    }
  }
  return '#1'; // Default for Wuu Jing
}

/**
 * Find the header row in Excel data
 */
function findHeaderRow(data: unknown[][], requiredKeywords: string[]): number {
  for (let i = 0; i < Math.min(data.length, 25); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const rowText = row.map(cell => String(cell ?? '').toLowerCase()).join(' ');
    const matches = requiredKeywords.filter(kw => rowText.includes(kw)).length;

    if (matches >= 2) {
      return i;
    }
  }

  return -1;
}

/**
 * Find column index by matching against possible header names
 */
function findColumnIndex(headers: string[], possibleNames: string[]): number {
  for (const name of possibleNames) {
    const index = headers.findIndex(h => h && h.includes(name));
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Parse Excel data without clear headers (fallback)
 */
function parseExcelWithoutHeaders(
  data: unknown[][],
  supplier: Supplier,
  poNumber: string
): PackingListItem[] {
  const items: PackingListItem[] = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row) || row.length < 3) continue;

    // Look for size pattern in any cell
    for (let j = 0; j < row.length; j++) {
      const cellStr = String(row[j] || '');
      const size = parseSize(cellStr, supplier);

      if (size) {
        // Found a size - extract other values from row
        const numbers = row
          .filter((cell, idx) => idx !== j && !isNaN(parseFloat(String(cell).replace(/,/g, ''))))
          .map(cell => parseFloat(String(cell).replace(/,/g, '')));

        if (numbers.length >= 2) {
          const pc = Math.round(numbers[0]) || 1;
          let netWeight = numbers[numbers.length - 2] || 0;
          let grossWeight = numbers[numbers.length - 1] || netWeight;

          if (supplier === 'wuu-jing') {
            netWeight = mtToLbs(netWeight);
            grossWeight = mtToLbs(grossWeight);
          }

          items.push({
            lineNumber: items.length + 1,
            inventoryId: buildInventoryId(size, supplier),
            lotSerialNbr: buildLotSerialNbr(poNumber, items.length + 1),
            pieceCount: pc,
            heatNumber: '',
            grossWeightLbs: Math.round(grossWeight),
            containerQtyLbs: Math.round(netWeight),
            rawSize: cellStr,
          });
        }
        break;
      }
    }
  }

  return items;
}

/**
 * Parse Wuu Jing INVOICE sheet for price data
 * Columns: NO, SIZE, PC, NET WEIGHT MT, PRICE US$/PC, PRICE US$/MT, AMOUNT USD$
 */
function parseWuuJingInvoice(data: unknown[][]): Map<string, InvoicePriceData> {
  const prices = new Map<string, InvoicePriceData>();

  // Find header row
  const headerRowIndex = findHeaderRow(data, ['size', 'price', 'pc']);
  if (headerRowIndex === -1) return prices;

  const headerRow = data[headerRowIndex] || [];
  const headers = headerRow.map(h => String(h ?? '').toLowerCase().trim());

  // Map column indices
  const colMap = {
    size: findColumnIndex(headers, ['size']),
    pc: findColumnIndex(headers, ['pc', 'pcs']),
    netWeight: findColumnIndex(headers, ['net weight', 'net']),
    pricePerPc: findColumnIndex(headers, ['price us$/pc', 'price', 'us$/pc']),
  };

  // Parse data rows
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    // Skip total rows
    const firstCell = String(row[0] ?? '').toLowerCase();
    if (firstCell.includes('total')) continue;

    // Get size string - format: "4.76*1220MM*2440MM(3/16"*48"*96")"
    const sizeStr = colMap.size >= 0 ? String(row[colMap.size] || '') : '';
    if (!sizeStr || !sizeStr.includes('*')) continue;

    // Extract the size in parentheses (e.g., "3/16"*48"*96")
    const sizeMatch = sizeStr.match(/\(([^)]+)\)/);
    const normalizedSize = sizeMatch ? sizeMatch[1] : sizeStr;

    const pc = colMap.pc >= 0 ? parseInt(String(row[colMap.pc]), 10) : 0;
    const netWeightMT = colMap.netWeight >= 0 ? parseFloat(String(row[colMap.netWeight])) : 0;
    const pricePerPc = colMap.pricePerPc >= 0 ? parseFloat(String(row[colMap.pricePerPc])) : 0;

    if (pc <= 0 || pricePerPc <= 0 || netWeightMT <= 0) continue;

    // Calculate weight per piece in lbs (MT * 2204.62 / pieces)
    const totalWeightLbs = mtToLbs(netWeightMT);
    const weightPerPieceLbs = totalWeightLbs / pc;

    // Calculate price per lb
    const pricePerLb = pricePerPc / weightPerPieceLbs;

    prices.set(normalizedSize, {
      size: normalizedSize,
      pricePerPiece: pricePerPc,
      weightPerPieceLbs,
      pricePerLb: Math.round(pricePerLb * 10000) / 10000, // Round to 4 decimal places
    });
  }

  return prices;
}

/**
 * Parse Yeou Yih Steel Excel format
 * Columns: Packing No., Description, Quantity, Net Weight, Gross Weight, Meas.
 * Description format: "304/304L 0.750" X 60" X 120"" with pieces like "3PCS" on separate line
 */
function parseYeouYihExcel(data: unknown[][], poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Find header row - look for keywords typical of YYS format
  const headerRowIndex = findHeaderRow(data, ['description', 'quantity', 'weight']);
  if (headerRowIndex === -1) {
    // Try alternate detection by looking for the YYS format directly
    return parseYeouYihExcelFlexible(data, poNumber);
  }

  const headerRow = data[headerRowIndex] || [];
  const headers = headerRow.map(h => String(h ?? '').toLowerCase().trim());

  // Map column indices for YYS
  const colMap = {
    packingNo: findColumnIndex(headers, ['packing no', 'packing', 'no', 'no.']),
    description: findColumnIndex(headers, ['description', 'desc']),
    quantity: findColumnIndex(headers, ['quantity', 'qty']),
    netWeight: findColumnIndex(headers, ['net weight', 'net', 'netweight']),
    grossWeight: findColumnIndex(headers, ['gross weight', 'gross', 'grossweight']),
  };

  // Extract container number from header area
  const containerNumber = extractYeouYihContainerFromExcel(data, headerRowIndex);

  // Extract warehouse from header area
  const warehouseResult = extractWarehouseFromExcel(data);

  // Default finish for YYS
  const finish = '#1';

  // Parse data rows
  let lineNumber = 0;
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ');

    // Skip total rows and empty rows
    if (rowText.toLowerCase().includes('total') || rowText.toLowerCase().includes('bundles')) continue;

    // Get description - may contain size and pieces
    const description = colMap.description >= 0 ? String(row[colMap.description] || '') : '';

    // Try to parse size from description
    const size = parseYeouYihSize(description);
    if (!size) continue;

    // Extract piece count from description or row
    const pcMatch = rowText.match(/(\d+)\s*PCS?/i);
    const pc = pcMatch ? parseInt(pcMatch[1], 10) : 1;

    // Get weights - YYS Excel shows weights in various formats
    let netWeight = 0;
    let grossWeight = 0;

    if (colMap.netWeight >= 0) {
      const netStr = String(row[colMap.netWeight] || '').replace(/[,\s]/g, '');
      netWeight = parseFloat(netStr) || 0;
    }

    if (colMap.grossWeight >= 0) {
      const grossStr = String(row[colMap.grossWeight] || '').replace(/[,\s]/g, '');
      grossWeight = parseFloat(grossStr) || 0;
    }

    // Determine unit and convert if needed
    // YYS shows weights in KGS or with unit suffix
    const netText = colMap.netWeight >= 0 ? String(row[colMap.netWeight] || '') : '';
    const isKgs = /kg/i.test(netText) || /gs$/i.test(netText) || netWeight > 1000;
    const isMT = /mt/i.test(netText) || (netWeight > 0 && netWeight < 100);

    if (isKgs) {
      // Convert KGS to LBS
      netWeight = Math.round(netWeight * 2.20462);
      grossWeight = Math.round(grossWeight * 2.20462);
    } else if (isMT) {
      // Convert MT to LBS
      netWeight = mtToLbs(netWeight);
      grossWeight = mtToLbs(grossWeight);
    }
    // If weights look like they're already in LBS (100-50000 range), keep as-is

    if (grossWeight === 0) grossWeight = netWeight;

    lineNumber++;
    const lotSerial = buildLotSerialNbr(poNumber, lineNumber);

    items.push({
      lineNumber,
      inventoryId: buildInventoryId(size, 'yeou-yih', finish),
      lotSerialNbr: lotSerial,
      pieceCount: pc,
      heatNumber: '',
      grossWeightLbs: Math.round(grossWeight),
      containerQtyLbs: Math.round(netWeight),
      rawSize: description,
      finish,
      containerNumber,
      warehouse: warehouseResult.detected ? warehouseResult.warehouse : undefined,
    });
  }

  return items;
}

/**
 * Extract container number from YYS Excel header area
 */
function extractYeouYihContainerFromExcel(data: unknown[][], beforeRow: number): string {
  for (let i = 0; i < Math.min(data.length, beforeRow + 5); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ');
    const match = rowText.match(/CONTAINER\s*NO\.?\s*[:\.]?\s*([A-Z]{4}\d{6,7})/i);
    if (match) return match[1];
  }
  return '';
}

/**
 * Flexible YYS Excel parsing when headers aren't clearly detected
 */
function parseYeouYihExcelFlexible(data: unknown[][], poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Look for rows containing YYS size patterns
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row) || row.length < 3) continue;

    // Look for size pattern in any cell
    for (let j = 0; j < row.length; j++) {
      const cellStr = String(row[j] || '');
      const size = parseYeouYihSize(cellStr);

      if (size) {
        // Found a size - extract other values from row
        const rowText = row.map(cell => String(cell ?? '')).join(' ');

        // Extract piece count
        const pcMatch = rowText.match(/(\d+)\s*PCS?/i);
        const pc = pcMatch ? parseInt(pcMatch[1], 10) : 1;

        // Look for numbers in the row that could be weights
        const numbers = row
          .filter((cell, idx) => idx !== j && !isNaN(parseFloat(String(cell).replace(/,/g, ''))))
          .map(cell => parseFloat(String(cell).replace(/,/g, '')))
          .filter(n => n > 0);

        // Assume last two numbers are weights
        let netWeight = 0;
        let grossWeight = 0;

        if (numbers.length >= 2) {
          // Check if these are MT (small numbers) or KGS (larger numbers)
          const lastNum = numbers[numbers.length - 1];
          const secondLastNum = numbers[numbers.length - 2];

          if (lastNum < 50 && secondLastNum < 50) {
            // Likely MT
            netWeight = mtToLbs(secondLastNum);
            grossWeight = mtToLbs(lastNum);
          } else if (lastNum > 500) {
            // Likely KGS
            netWeight = Math.round(secondLastNum * 2.20462);
            grossWeight = Math.round(lastNum * 2.20462);
          } else {
            // Assume LBS
            netWeight = Math.round(secondLastNum);
            grossWeight = Math.round(lastNum);
          }
        }

        items.push({
          lineNumber: items.length + 1,
          inventoryId: buildInventoryId(size, 'yeou-yih', '#1'),
          lotSerialNbr: buildLotSerialNbr(poNumber, items.length + 1),
          pieceCount: pc,
          heatNumber: '',
          grossWeightLbs: grossWeight || netWeight,
          containerQtyLbs: netWeight,
          rawSize: cellStr,
          finish: '#1',
        });
        break; // Only one size per row
      }
    }
  }

  return items;
}

/**
 * Find matching price data for a packing list item
 * Tries to match by normalizing size strings
 */
function findMatchingPrice(rawSize: string, prices: Map<string, InvoicePriceData>): InvoicePriceData | null {
  // Direct match
  if (prices.has(rawSize)) {
    return prices.get(rawSize)!;
  }

  // Normalize the raw size for comparison
  // rawSize from packing: "4.76*1220MM*3050MM(3/16"*48"*120")"
  const sizeMatch = rawSize.match(/\(([^)]+)\)/);
  const normalizedRawSize = sizeMatch ? sizeMatch[1] : rawSize;

  if (prices.has(normalizedRawSize)) {
    return prices.get(normalizedRawSize)!;
  }

  // Try fuzzy matching by extracting dimensions
  // Format: thickness"*width"*length" (e.g., "3/16"*48"*120")
  const dimMatch = normalizedRawSize.match(/(\d+\/\d+|\d+(?:\.\d+)?)[""']\s*\*\s*(\d+)[""']\s*\*\s*(\d+)/);
  if (dimMatch) {
    const [, thickness, width, length] = dimMatch;

    // Try to find a matching key in prices
    for (const [key, value] of prices.entries()) {
      const keyMatch = key.match(/(\d+\/\d+|\d+(?:\.\d+)?)[""']\s*\*\s*(\d+)[""']\s*\*\s*(\d+)/);
      if (keyMatch) {
        const [, keyThickness, keyWidth, keyLength] = keyMatch;
        if (thickness === keyThickness && width === keyWidth && length === keyLength) {
          return value;
        }
      }
    }
  }

  return null;
}
