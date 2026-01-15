import * as XLSX from 'xlsx';
import { PackingListItem, ParsedPackingList, Supplier } from '../types';
import { detectSupplier, scorePageAsPackingList } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs, extractWarehouse } from './conversion';
import { VENDOR_CODES } from './constants';

/**
 * Parse an Excel file and extract packing list data
 */
export async function parseExcel(file: File, poNumber: string): Promise<ParsedPackingList> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  // Search ALL sheets for PO number and warehouse (they might be on invoice sheet)
  let extractedPo = '';
  let extractedWarehouse = '';
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];

    if (!extractedPo) {
      extractedPo = extractPoFromExcel(data);
    }
    if (!extractedWarehouse) {
      extractedWarehouse = extractWarehouseFromExcel(data);
    }
    if (extractedPo && extractedWarehouse) break;
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

  // Use provided PO, or extracted from any sheet
  const finalPoNumber = poNumber || extractedPo || 'UNKNOWN';

  // Use warehouse from best sheet, or from any sheet if not found
  const sheetWarehouse = extractWarehouseFromExcel(bestSheet.data);
  const warehouse = sheetWarehouse !== 'LA' ? sheetWarehouse : (extractedWarehouse || 'LA');

  // Parse the data based on supplier
  let items: PackingListItem[];
  let detectedSupplier = supplier;

  if (supplier === 'yuen-chang') {
    items = parseYuenChangExcel(bestSheet.data, finalPoNumber);
  } else if (supplier === 'wuu-jing') {
    items = parseWuuJingExcel(bestSheet.data, finalPoNumber);
  } else {
    // Unknown supplier - try both parsers and use whichever gets more items
    const wuuJingItems = parseWuuJingExcel(bestSheet.data, finalPoNumber);
    const yuenChangItems = parseYuenChangExcel(bestSheet.data, finalPoNumber);

    if (yuenChangItems.length >= wuuJingItems.length && yuenChangItems.length > 0) {
      items = yuenChangItems;
      detectedSupplier = 'yuen-chang';
    } else if (wuuJingItems.length > 0) {
      items = wuuJingItems;
      detectedSupplier = 'wuu-jing';
    } else {
      items = [];
    }
  }

  if (items.length === 0) {
    throw new Error('Could not parse any items from packing list');
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
  // Search all rows for PO patterns
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ');

    // Pattern: "EXCEL ORDER # 001726" or "EXCEL ORDER #001726" (Yuen Chang format)
    const excelOrderMatch = rowText.match(/EXCEL\s*ORDER\s*#?\s*:?\s*0*(\d{3,6})/i);
    if (excelOrderMatch) {
      return excelOrderMatch[1];
    }

    // Pattern: "EXCEL METALS LLC ORDER NO.: 001837" (Wuu Jing format)
    const excelMetalsMatch = rowText.match(/EXCEL\s*METALS.*ORDER\s*NO\.?\s*:?\s*0*(\d{3,6})/i);
    if (excelMetalsMatch) {
      return excelMetalsMatch[1];
    }

    // Pattern: "ORDER NO.: 001772" or "ORDER NO: 001772" - but NOT "INVOICE NO"
    if (rowText.toUpperCase().includes('ORDER') && !rowText.toUpperCase().includes('INVOICE NO')) {
      const orderNoMatch = rowText.match(/ORDER\s*NO\.?\s*:?\s*#?\s*0*(\d{3,6})/i);
      if (orderNoMatch) {
        return orderNoMatch[1];
      }
    }

    // Check cell by cell - number might be in adjacent cell
    for (let j = 0; j < row.length; j++) {
      const cellText = String(row[j] ?? '').trim();
      const cellUpper = cellText.toUpperCase();

      // Check if this cell ends with ORDER NO pattern (number in next cell)
      if (cellUpper.includes('ORDER') && (cellUpper.endsWith('NO.') || cellUpper.endsWith('NO.:') ||
          cellUpper.endsWith('NO:') || cellUpper.endsWith('NO') || cellUpper.endsWith('#'))) {
        // Look at next cells for the number
        for (let k = j + 1; k < Math.min(j + 3, row.length); k++) {
          const nextCell = row[k];
          // Handle both string and number types
          const nextValue = typeof nextCell === 'number' ? nextCell : String(nextCell ?? '');
          const numStr = String(nextValue).replace(/^0+/, '');
          if (/^\d{3,6}$/.test(numStr)) {
            return numStr;
          }
        }
      }

      // Check if cell has full pattern
      if (cellUpper.includes('ORDER') && !cellUpper.includes('INVOICE')) {
        const cellMatch = cellText.match(/ORDER\s*NO\.?\s*:?\s*#?\s*0*(\d{3,6})/i);
        if (cellMatch) {
          return cellMatch[1];
        }
      }
    }
  }

  // Fallback: try to extract from bundle numbers (e.g., 001772-01 -> PO 1772)
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    for (const cell of row) {
      const cellStr = String(cell ?? '');
      // Match bundle pattern: 6 digits followed by dash and 2 digits
      const bundleMatch = cellStr.match(/(\d{6})-\d{2}/);
      if (bundleMatch) {
        // Remove leading zeros: 001772 -> 1772
        return bundleMatch[1].replace(/^0+/, '') || bundleMatch[1];
      }
    }
  }

  return '';
}

/**
 * Extract warehouse/destination from Excel header rows
 */
function extractWarehouseFromExcel(data: unknown[][]): string {
  // Search first 15 rows for destination
  for (let i = 0; i < Math.min(data.length, 15); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    const rowText = row.map(cell => String(cell ?? '')).join(' ');

    // Use the existing extractWarehouse function
    const warehouse = extractWarehouse(rowText);
    if (warehouse !== 'LA') { // LA is the default, so if we found something specific
      return warehouse;
    }
  }

  return 'LA';
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
