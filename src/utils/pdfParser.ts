import * as pdfjsLib from 'pdfjs-dist';
import { PackingListItem, ParsedPackingList, Supplier } from '../types';
import { detectSupplier, findPackingListPage } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs } from './conversion';
import { VENDOR_CODES } from './constants';
import { extractTextWithOcr, checkOcrAccuracy, OcrProgress } from './ocr';

// Configure PDF.js worker - must match pdfjs-dist package version (4.8.69)
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs`;

/**
 * Extract text from all pages of a PDF
 */
export async function extractPdfText(file: File): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pages.push(text);
  }

  return pages;
}

/**
 * Parse packing list data from PDF text
 */
export function parsePackingListFromText(
  text: string,
  supplier: Supplier,
  poNumber: string
): PackingListItem[] {
  const lines = text.split(/\n|\s{3,}/);

  if (supplier === 'wuu-jing') {
    return parseWuuJingText(text, poNumber);
  } else if (supplier === 'yuen-chang') {
    return parseYuenChangText(text, poNumber);
  }

  // Generic parsing for unknown supplier
  return parseGenericText(lines, supplier, poNumber);
}

/**
 * Parse Wuu Jing packing list format
 * Expected columns: NO., SIZE, PC, BUNDLE NO., N'WEIGHT(MT), G'WEIGHT(MT)
 */
function parseWuuJingText(text: string, poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Pattern to match Wuu Jing data rows
  // Example: 1 4.76*1525MM*3660MM(3/16"*60"*144") 8 01 1.681 1.693
  const rowPattern = /(\d+)\s+(\d+\.?\d*\*\d+MM\*\d+MM\([^)]+\))\s+(\d+)\s+(\d+)\s+(\d+\.?\d+)\s+(\d+\.?\d+)/g;

  let match;
  let lineNum = 0;
  while ((match = rowPattern.exec(text)) !== null) {
    lineNum++;
    const [, , sizeStr, pcStr, bundleNo, netWeightMT, grossWeightMT] = match;

    const size = parseSize(sizeStr, 'wuu-jing');
    if (!size) continue;

    const grossWeightLbs = mtToLbs(parseFloat(grossWeightMT));
    const netWeightLbs = mtToLbs(parseFloat(netWeightMT));

    items.push({
      lineNumber: lineNum,
      inventoryId: buildInventoryId(size, 'wuu-jing'),
      lotSerialNbr: buildLotSerialNbr(poNumber, bundleNo),
      pieceCount: parseInt(pcStr, 10),
      heatNumber: '',
      grossWeightLbs,
      containerQtyLbs: netWeightLbs,
      rawSize: sizeStr,
    });
  }

  // If pattern didn't match, try a more flexible approach
  if (items.length === 0) {
    return parseWuuJingFlexible(text, poNumber);
  }

  return items;
}

/**
 * More flexible Wuu Jing parsing - looks for size patterns and nearby numbers
 */
function parseWuuJingFlexible(text: string, poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Split text into chunks around size patterns
  const chunks = text.split(/(?=\d+\.?\d*\*\d+MM\*\d+MM\([^)]+\))/);

  let lineNum = 0;
  for (const chunk of chunks) {
    const sizeMatch = chunk.match(/\d+\.?\d*\*\d+MM\*\d+MM\([^)]+\)/);
    if (!sizeMatch) continue;

    const sizeStr = sizeMatch[0];
    const size = parseSize(sizeStr, 'wuu-jing');
    if (!size) continue;

    // Extract numbers from the chunk
    const numbers = chunk.match(/\d+\.?\d*/g) || [];

    // Try to find piece count, bundle number, and weights
    // Typical order: lineNo, [size], pc, bundleNo, netWeight, grossWeight
    const numericValues = numbers.filter(n => !sizeStr.includes(n)).map(n => parseFloat(n));

    if (numericValues.length >= 4) {
      lineNum++;
      const pc = Math.round(numericValues[0]) || 1;
      const bundleNo = Math.round(numericValues[1]) || lineNum;
      const netWeightMT = numericValues[2] || 0;
      const grossWeightMT = numericValues[3] || netWeightMT;

      items.push({
        lineNumber: lineNum,
        inventoryId: buildInventoryId(size, 'wuu-jing'),
        lotSerialNbr: buildLotSerialNbr(poNumber, bundleNo),
        pieceCount: pc,
        heatNumber: '',
        grossWeightLbs: mtToLbs(grossWeightMT),
        containerQtyLbs: mtToLbs(netWeightMT),
        rawSize: sizeStr,
      });
    }
  }

  return items;
}

/**
 * Parse Yuen Chang packing list format
 */
function parseYuenChangText(text: string, poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Pattern for Yuen Chang: gauge*width"*length"
  const rowPattern = /(\d+)\s+(\d+GA\*?\d+"?\*?\d+"?)\s+(\d+)\s+([\d.]+)\s+([\d.]+)/g;

  let match;
  let lineNum = 0;
  while ((match = rowPattern.exec(text)) !== null) {
    lineNum++;
    const [, itemNo, sizeStr, pc, netWeight, grossWeight] = match;

    const size = parseSize(sizeStr, 'yuen-chang');
    if (!size) continue;

    items.push({
      lineNumber: lineNum,
      inventoryId: buildInventoryId(size, 'yuen-chang'),
      lotSerialNbr: buildLotSerialNbr(poNumber, itemNo),
      pieceCount: parseInt(pc, 10),
      heatNumber: '',
      grossWeightLbs: Math.round(parseFloat(grossWeight)),
      containerQtyLbs: Math.round(parseFloat(netWeight)),
      rawSize: sizeStr,
    });
  }

  return items;
}

/**
 * Generic text parsing
 */
function parseGenericText(
  lines: string[],
  supplier: Supplier,
  poNumber: string
): PackingListItem[] {
  const items: PackingListItem[] = [];
  let lineNum = 0;

  for (const line of lines) {
    // Look for size patterns in each line
    const sizeMatch = line.match(/\d+\.?\d*\*\d+[A-Z]*\*\d+[A-Z]*/i);
    if (!sizeMatch) continue;

    const size = parseSize(sizeMatch[0], supplier);
    if (!size) continue;

    lineNum++;
    const numbers = line.match(/\d+\.?\d*/g) || [];

    items.push({
      lineNumber: lineNum,
      inventoryId: buildInventoryId(size, supplier),
      lotSerialNbr: buildLotSerialNbr(poNumber, lineNum),
      pieceCount: 1,
      heatNumber: '',
      grossWeightLbs: parseFloat(numbers[numbers.length - 1] || '0'),
      containerQtyLbs: parseFloat(numbers[numbers.length - 2] || '0'),
      rawSize: sizeMatch[0],
    });
  }

  return items;
}

/**
 * Main function to parse a PDF file
 */
export async function parsePdf(file: File, poNumber: string): Promise<ParsedPackingList> {
  // Extract text from all pages
  let pages: string[];
  try {
    pages = await extractPdfText(file);
  } catch (err) {
    throw new Error(`Failed to read PDF: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  const hasText = pages.some(p => p.trim().length > 50);

  if (!hasText) {
    // Signal that OCR is needed
    throw new Error('OCR_NEEDED: PDF contains only images');
  }

  // Find the packing list page
  const packingListPage = findPackingListPage(pages);

  if (!packingListPage) {
    throw new Error('Could not identify packing list page in PDF');
  }

  // Detect supplier
  const supplier = detectSupplier(packingListPage.text);

  // Parse items from the packing list
  const items = parsePackingListFromText(packingListPage.text, supplier, poNumber);

  if (items.length === 0) {
    // Provide more context about what was found
    const preview = packingListPage.text.substring(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Could not parse items. Supplier: ${supplier}. Preview: "${preview}..."`);
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
 * Parse a PDF using OCR (for scanned/image-based PDFs)
 */
export async function parsePdfWithOcr(
  file: File,
  poNumber: string,
  onProgress?: (progress: OcrProgress) => void
): Promise<ParsedPackingList & { ocrConfidence: number; ocrWarning?: string }> {
  // Run OCR on all pages
  const ocrResults = await extractTextWithOcr(file, onProgress);

  // Check accuracy
  const accuracy = checkOcrAccuracy(ocrResults);

  // Combine all text from OCR results
  const pages = ocrResults.map((r) => r.text);

  if (pages.every((p) => !p.trim())) {
    throw new Error('OCR could not extract any text from the PDF');
  }

  // Find the packing list page
  const packingListPage = findPackingListPage(pages);

  if (!packingListPage) {
    throw new Error('Could not identify packing list page after OCR');
  }

  // Detect supplier
  const supplier = detectSupplier(packingListPage.text);

  // Parse items from the packing list
  const items = parsePackingListFromText(packingListPage.text, supplier, poNumber);

  if (items.length === 0) {
    const preview = packingListPage.text.substring(0, 300).replace(/\s+/g, ' ');
    throw new Error(
      `Could not parse items from OCR text. Supplier: ${supplier}. ` +
      `Confidence: ${Math.round(accuracy.averageConfidence)}%. ` +
      `Preview: "${preview}..."`
    );
  }

  // Calculate totals
  const totalGrossWeightLbs = items.reduce((sum, item) => sum + item.grossWeightLbs, 0);
  const totalNetWeightLbs = items.reduce((sum, item) => sum + item.containerQtyLbs, 0);

  // Build warning message if accuracy is low
  let ocrWarning: string | undefined;
  if (!accuracy.isAcceptable) {
    ocrWarning = `Low OCR confidence (${Math.round(accuracy.averageConfidence)}%). Please verify the extracted data.`;
  } else if (accuracy.lowConfidencePages.length > 0) {
    ocrWarning = `Pages ${accuracy.lowConfidencePages.join(', ')} had low OCR confidence. Please verify.`;
  }

  return {
    supplier,
    vendorCode: VENDOR_CODES[supplier] || '',
    poNumber,
    items,
    totalGrossWeightLbs,
    totalNetWeightLbs,
    ocrConfidence: accuracy.averageConfidence,
    ocrWarning,
  };
}

/**
 * Check if an error indicates OCR is needed
 */
export function needsOcr(error: Error): boolean {
  return error.message.startsWith('OCR_NEEDED:');
}

// Re-export OCR progress type for consumers
export type { OcrProgress };
