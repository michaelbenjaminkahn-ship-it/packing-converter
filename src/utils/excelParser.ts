import * as XLSX from 'xlsx';
import { PackingListItem, ParsedPackingList, Supplier } from '../types';
import { detectSupplier, scorePageAsPackingList } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs } from './conversion';
import { VENDOR_CODES } from './constants';

/**
 * Parse an Excel file and extract packing list data
 */
export async function parseExcel(file: File, poNumber: string): Promise<ParsedPackingList> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  // Find the sheet most likely to be a packing list
  let bestSheet: { name: string; score: number; data: unknown[][] } | null = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    const text = data.map(row => (row as unknown[]).join(' ')).join('\n');
    const score = scorePageAsPackingList(text);

    if (!bestSheet || score > bestSheet.score) {
      bestSheet = { name: sheetName, score, data: data as unknown[][] };
    }
  }

  if (!bestSheet || bestSheet.score < 30) {
    throw new Error('Could not identify packing list sheet in Excel file');
  }

  // Detect supplier from sheet content
  const sheetText = bestSheet.data.map(row => row.join(' ')).join('\n');
  const supplier = detectSupplier(sheetText);

  // Parse the data
  const items = parseExcelData(bestSheet.data, supplier, poNumber);

  if (items.length === 0) {
    throw new Error('Could not parse any items from packing list');
  }

  // Calculate totals
  const totalGrossWeightLbs = items.reduce((sum, item) => sum + item.grossWeightLbs, 0);
  const totalNetWeightLbs = items.reduce((sum, item) => sum + item.containerQtyLbs, 0);

  return {
    supplier,
    vendorCode: VENDOR_CODES[supplier] || '',
    poNumber,
    items,
    totalGrossWeightLbs,
    totalNetWeightLbs,
  };
}

/**
 * Parse Excel data rows into PackingListItems
 */
function parseExcelData(
  data: unknown[][],
  supplier: Supplier,
  poNumber: string
): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Find header row
  const headerRowIndex = findHeaderRow(data);
  if (headerRowIndex === -1) {
    return parseExcelWithoutHeaders(data, supplier, poNumber);
  }

  const headers = data[headerRowIndex].map(h => String(h || '').toLowerCase().trim());

  // Map column indices
  const colMap = {
    no: findColumnIndex(headers, ['no', 'no.', 'item', '#']),
    size: findColumnIndex(headers, ['size', 'specification', 'spec']),
    pc: findColumnIndex(headers, ['pc', 'pcs', 'pieces', 'qty', 'quantity']),
    bundleNo: findColumnIndex(headers, ['bundle no', 'bundle no.', 'bundle', 'lot']),
    netWeight: findColumnIndex(headers, ['n\'weight', 'net weight', 'net wt', 'n.weight', 'n\'wt']),
    grossWeight: findColumnIndex(headers, ['g\'weight', 'gross weight', 'gross wt', 'g.weight', 'g\'wt']),
    heatNo: findColumnIndex(headers, ['heat no', 'heat no.', 'heat', 'coil no']),
  };

  // Parse data rows
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;

    // Get size string
    const sizeStr = colMap.size >= 0 ? String(row[colMap.size] || '') : '';
    if (!sizeStr) continue;

    const size = parseSize(sizeStr, supplier);
    if (!size) continue;

    const lineNo = colMap.no >= 0 ? parseInt(String(row[colMap.no]), 10) : items.length + 1;
    const pc = colMap.pc >= 0 ? parseInt(String(row[colMap.pc]), 10) : 1;
    const bundleNo = colMap.bundleNo >= 0 ? String(row[colMap.bundleNo]) : String(lineNo);
    let netWeight = colMap.netWeight >= 0 ? parseFloat(String(row[colMap.netWeight])) : 0;
    let grossWeight = colMap.grossWeight >= 0 ? parseFloat(String(row[colMap.grossWeight])) : netWeight;
    const heatNo = colMap.heatNo >= 0 ? String(row[colMap.heatNo] || '') : '';

    // Convert weights if supplier uses MT
    if (supplier === 'wuu-jing') {
      netWeight = mtToLbs(netWeight);
      grossWeight = mtToLbs(grossWeight);
    } else {
      netWeight = Math.round(netWeight);
      grossWeight = Math.round(grossWeight);
    }

    items.push({
      lineNumber: items.length + 1,
      inventoryId: buildInventoryId(size, supplier),
      lotSerialNbr: buildLotSerialNbr(poNumber, bundleNo),
      pieceCount: pc || 1,
      heatNumber: heatNo,
      grossWeightLbs: grossWeight,
      containerQtyLbs: netWeight,
      rawSize: sizeStr,
    });
  }

  return items;
}

/**
 * Find the header row in Excel data
 */
function findHeaderRow(data: unknown[][]): number {
  const headerKeywords = ['size', 'pc', 'pcs', 'weight', 'bundle', 'item', 'no'];

  for (let i = 0; i < Math.min(data.length, 20); i++) {
    const row = data[i];
    if (!row) continue;

    const rowText = row.map(cell => String(cell || '').toLowerCase()).join(' ');
    const matches = headerKeywords.filter(kw => rowText.includes(kw)).length;

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
    const index = headers.findIndex(h => h.includes(name));
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Parse Excel data without clear headers
 */
function parseExcelWithoutHeaders(
  data: unknown[][],
  supplier: Supplier,
  poNumber: string
): PackingListItem[] {
  const items: PackingListItem[] = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 3) continue;

    // Look for size pattern in any cell
    for (let j = 0; j < row.length; j++) {
      const cellStr = String(row[j] || '');
      const size = parseSize(cellStr, supplier);

      if (size) {
        // Found a size - extract other values from row
        const numbers = row
          .filter((cell, idx) => idx !== j && !isNaN(parseFloat(String(cell))))
          .map(cell => parseFloat(String(cell)));

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
