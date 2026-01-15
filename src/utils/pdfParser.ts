import * as pdfjsLib from 'pdfjs-dist';
import { PackingListItem, ParsedPackingList, Supplier } from '../types';
import { detectSupplier, findPackingListPage } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs, extractWarehouse } from './conversion';
import { VENDOR_CODES, GAUGE_TO_DECIMAL } from './constants';
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
 * Extract finish code from Wuu Jing header text
 * e.g., "NO.1 FINISH" -> "#1____"
 */
function extractWuuJingFinish(text: string): string {
  const finishMatch = text.match(/NO\.?\s*(\d)\s*FINISH/i);
  if (finishMatch) {
    return `#${finishMatch[1]}___`;
  }
  return '#1___'; // Default
}

/**
 * Parse Wuu Jing packing list format
 * Expected columns: NO., SIZE, PC, BUNDLE NO., PRODUCT NO., CONTAINER NO., N'WEIGHT(MT), G'WEIGHT(MT)
 * Example row: 1 | 9.53*1525MM*3050MM(3/8"*60"*120") | 6 | 001837-01 | | EITU3156602 | 2.112 | 2.125
 */
function parseWuuJingText(text: string, poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Extract finish and warehouse from header
  const finish = extractWuuJingFinish(text);
  const warehouse = extractWarehouse(text);

  // Find all size patterns with imperial dimensions
  // Pattern: thickness*widthMM*lengthMM(imperial) followed by PC and bundle
  const sizePattern = /(\d+\.?\d*)\s*\*\s*(\d+)\s*MM\s*\*\s*(\d+)\s*MM\s*\(([^)]+)\)/gi;

  // Find all bundle patterns: 001837-01, 001772-02, etc.
  const bundlePattern = /(\d{6})-(\d{2})/g;

  // Find all weight patterns (decimal numbers between 0.5 and 50 MT)
  const weightPattern = /\b(\d{1,2}\.\d{3})\b/g;

  // Extract all matches
  const sizeMatches = [...text.matchAll(sizePattern)];
  const bundleMatches = [...text.matchAll(bundlePattern)];
  const weightMatches = [...text.matchAll(weightPattern)]
    .map(m => ({ value: parseFloat(m[1]), index: m.index! }))
    .filter(w => w.value >= 0.5 && w.value <= 50);

  // Process each size match
  for (let i = 0; i < sizeMatches.length; i++) {
    const sizeMatch = sizeMatches[i];
    const fullSizeStr = sizeMatch[0];
    const imperialPart = sizeMatch[4];

    // Parse imperial: 3/8"*60"*120"
    const imperialMatch = imperialPart.match(/(\d+\/\d+|\d+\.?\d*)[""']?\s*\*\s*(\d+)[""']?\s*\*\s*(\d+)/);
    if (!imperialMatch) continue;

    const thicknessStr = imperialMatch[1];
    let thickness: number;
    if (thicknessStr.includes('/')) {
      const [num, denom] = thicknessStr.split('/').map(Number);
      thickness = num / denom;
    } else {
      thickness = parseFloat(thicknessStr);
    }
    const width = parseFloat(imperialMatch[2]);
    const length = parseFloat(imperialMatch[3]);

    if (isNaN(thickness) || isNaN(width) || isNaN(length)) continue;

    const size = {
      thickness,
      width,
      length,
      thicknessFormatted: thickness.toFixed(3),
    };

    // Find corresponding bundle number (look for bundles after this size in the text)
    const matchIndex = sizeMatch.index!;
    const bundleMatch = bundleMatches.find(b =>
      b.index! > matchIndex && b.index! < matchIndex + 300
    );
    const bundleNo = bundleMatch ? `${bundleMatch[1]}-${bundleMatch[2]}` : `${poNumber.padStart(6, '0')}-${String(i + 1).padStart(2, '0')}`;

    // Find PC (piece count) - typically a small number (1-20) before the bundle
    // Look for pattern: ) PC BUNDLE
    const pcMatch = text.substring(matchIndex, matchIndex + 150).match(/\)\s*(\d{1,2})\s+\d{6}/);
    const pc = pcMatch ? parseInt(pcMatch[1], 10) : 1;

    // Find weights after the bundle number
    const weightsAfter = weightMatches.filter(w =>
      w.index > (bundleMatch?.index || matchIndex) &&
      w.index < (bundleMatch?.index || matchIndex) + 100
    );

    // Weights come in pairs: net, gross
    const netWeightMT = weightsAfter.length >= 1 ? weightsAfter[0].value : 0;
    const grossWeightMT = weightsAfter.length >= 2 ? weightsAfter[1].value : netWeightMT;

    items.push({
      lineNumber: i + 1,
      inventoryId: buildInventoryId(size, 'wuu-jing', finish),
      lotSerialNbr: bundleNo,
      pieceCount: pc,
      heatNumber: '',
      grossWeightLbs: mtToLbs(grossWeightMT),
      containerQtyLbs: mtToLbs(netWeightMT),
      rawSize: fullSizeStr,
      warehouse,
      finish,
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

  // Extract finish and warehouse from header
  const finish = extractWuuJingFinish(text);
  const warehouse = extractWarehouse(text);

  // Try OCR-optimized parsing first
  const ocrItems = parseWuuJingOcr(text, poNumber);
  if (ocrItems.length > 0) {
    return ocrItems;
  }

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
        inventoryId: buildInventoryId(size, 'wuu-jing', finish),
        lotSerialNbr: buildLotSerialNbr(poNumber, bundleNo),
        pieceCount: pc,
        heatNumber: '',
        grossWeightLbs: mtToLbs(grossWeightMT),
        containerQtyLbs: mtToLbs(netWeightMT),
        rawSize: sizeStr,
        warehouse,
        finish,
      });
    }
  }

  return items;
}

/**
 * OCR-optimized Wuu Jing parsing - handles imperfect text
 * Looks for: size patterns, bundle numbers (001812-XX), and weights (X.XXX MT)
 */
function parseWuuJingOcr(text: string, poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Extract finish and warehouse from header
  const finish = extractWuuJingFinish(text);
  const warehouse = extractWarehouse(text);

  // Clean OCR artifacts - common misreads
  const cleanText = text
    .replace(/[oO](?=\d)/g, '0') // O before digit -> 0
    .replace(/(?<=\d)[lI]/g, '1') // l or I after digit -> 1
    .replace(/\s+/g, ' '); // normalize whitespace

  // Find all size patterns - more flexible matching for OCR
  // Pattern: thickness*widthMM*lengthMM(imperial)
  const sizePatterns = [
    // Standard format: 4.76*1525MM*3660MM(3/16"*60"*144")
    /(\d+\.?\d*)\s*[*×xX]\s*(\d+)\s*MM\s*[*×xX]\s*(\d+)\s*MM\s*\(([^)]+)\)/gi,
    // Without MM labels: 4.76*1525*3660(3/16"*60"*144")
    /(\d+\.?\d*)\s*[*×xX]\s*(\d{3,4})\s*[*×xX]\s*(\d{3,4})\s*\(([^)]+)\)/gi,
  ];

  // Find bundle number pattern: 001812-01, 001812-02, etc.
  const bundlePattern = /(\d{6})-(\d{2})/g;
  const bundleMatches = [...cleanText.matchAll(bundlePattern)];

  // Find weight patterns: decimal numbers like 1.680, 1.693 (between 0.5 and 10)
  const weightPattern = /(\d+\.\d{2,3})/g;
  const weightMatches = [...cleanText.matchAll(weightPattern)]
    .map(m => ({ value: parseFloat(m[1]), index: m.index! }))
    .filter(w => w.value >= 0.5 && w.value <= 50); // Reasonable MT weights

  // Find piece count patterns: small integers (1-20) that appear alone
  // Look for pattern like: size) 8 001812 or size) 10 001812
  const pcPattern = /\)\s*(\d{1,2})\s+\d{6}/g;
  const pcMatches = [...cleanText.matchAll(pcPattern)];

  let lineNum = 0;
  for (const sizePattern of sizePatterns) {
    const sizeMatches = [...cleanText.matchAll(sizePattern)];

    for (const match of sizeMatches) {
      const fullMatch = match[0];
      const matchIndex = match.index!;
      // Note: metric values (match[1-3]) not used - we parse imperial from parentheses
      const imperialPart = match[4];

      // Parse imperial dimensions from parentheses
      const imperialMatch = imperialPart.match(/(\d+\/\d+|\d+\.?\d*)[""']?\s*[*×xX]\s*(\d+)[""']?\s*[*×xX]\s*(\d+)/);
      if (!imperialMatch) continue;

      const thicknessStr = imperialMatch[1];
      let thickness: number;
      if (thicknessStr.includes('/')) {
        const [num, denom] = thicknessStr.split('/').map(Number);
        thickness = num / denom;
      } else {
        thickness = parseFloat(thicknessStr);
      }
      const widthIn = parseFloat(imperialMatch[2]);
      const lengthIn = parseFloat(imperialMatch[3]);

      if (isNaN(thickness) || isNaN(widthIn) || isNaN(lengthIn)) continue;

      const size = {
        thickness,
        width: widthIn,
        length: lengthIn,
        thicknessFormatted: formatThickness(thickness),
      };

      // Find the bundle number closest to this size match
      const nearestBundle = bundleMatches.find(b =>
        b.index! > matchIndex && b.index! < matchIndex + 200
      );

      // Find piece count before the bundle number
      const nearestPc = pcMatches.find(p =>
        p.index! > matchIndex && p.index! < (nearestBundle?.index || matchIndex + 100)
      );

      // Find weights after the bundle number
      const weightsAfter = weightMatches.filter(w =>
        w.index > (nearestBundle?.index || matchIndex) &&
        w.index < (nearestBundle?.index || matchIndex) + 150
      );

      lineNum++;
      const bundleNo = nearestBundle ? `${nearestBundle[1]}-${nearestBundle[2]}` : `${poNumber.padStart(6, '0')}-${String(lineNum).padStart(2, '0')}`;
      const pc = nearestPc ? parseInt(nearestPc[1], 10) : 1;

      // Get the last two weights (net and gross) - they're usually at the end
      const netWeightMT = weightsAfter.length >= 2 ? weightsAfter[weightsAfter.length - 2].value : 0;
      const grossWeightMT = weightsAfter.length >= 1 ? weightsAfter[weightsAfter.length - 1].value : netWeightMT;

      items.push({
        lineNumber: lineNum,
        inventoryId: buildInventoryId(size, 'wuu-jing', finish),
        lotSerialNbr: bundleNo,
        pieceCount: pc,
        heatNumber: '',
        grossWeightLbs: mtToLbs(grossWeightMT),
        containerQtyLbs: mtToLbs(netWeightMT),
        rawSize: fullMatch,
        warehouse,
        finish,
      });
    }

    if (items.length > 0) break; // Found matches with this pattern
  }

  return items;
}

/**
 * Format thickness helper for OCR parser
 */
function formatThickness(thickness: number): string {
  return thickness.toFixed(3);
}

/**
 * Extract finish from Yuen Chang section headers
 * e.g., "304/304L 2B Finish" -> "2B", "304/304L #4 Finish" -> "#4"
 */
function extractYuenChangFinish(text: string): string {
  // Look for finish pattern in headers
  const finishMatch = text.match(/304\/304L\s*(2B|#\d|BA)\s*Finish/i);
  if (finishMatch) {
    return finishMatch[1];
  }
  return '2B'; // Default
}

/**
 * Parse Yuen Chang packing list format
 * Columns: NO. | Item | SIZE (GA) | COIL NO. | Heat NO. | PCS | NET WEIGHT (LBS) | GROSS WEIGHT (LBS)
 * Example: 1 | WM006 | 26GA x 48" x 120" | 43S02543-035 | S92HB05C | 128 | 3,730.22 | 3,884.54
 */
function parseYuenChangText(text: string, _poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Extract warehouse from destination
  const warehouse = extractWarehouse(text);

  // Track current finish (can change between sections)
  let currentFinish = extractYuenChangFinish(text);

  // Find section headers to track finish changes
  const sectionPattern = /304\/304L\s*(2B|#\d|BA)\s*Finish/gi;
  const sections: { finish: string; index: number }[] = [];
  let sectionMatch;
  while ((sectionMatch = sectionPattern.exec(text)) !== null) {
    sections.push({ finish: sectionMatch[1], index: sectionMatch.index });
  }

  // Pattern to match Yuen Chang rows
  // Format: WM006 | 26GA x 48" x 120" | coil | heat | pcs | net | gross
  // Item pattern: WM followed by 3 digits
  const itemPattern = /\b(WM\d{3})\b/g;
  const itemMatches = [...text.matchAll(itemPattern)];

  // Size pattern: ##GA x ##" x ###"
  const sizePattern = /(\d{1,2})GA\s*[x×*]\s*(\d{2,3})[""']?\s*[x×*]\s*(\d{2,3})[""']?/gi;
  const sizeMatches = [...text.matchAll(sizePattern)];

  // Heat number pattern: alphanumeric like S92HB05C, YU107349, etc.
  const heatPattern = /\b([A-Z]{1,2}\d{2}[A-Z0-9]{3,6})\b/g;
  const heatMatches = [...text.matchAll(heatPattern)];

  // Weight pattern: numbers with commas like 3,730.22 or just 3730.22
  const weightPattern = /\b(\d{1,2},?\d{3}\.?\d{0,2})\b/g;
  const weightMatches = [...text.matchAll(weightPattern)]
    .map(m => ({
      value: parseFloat(m[1].replace(',', '')),
      index: m.index!
    }))
    .filter(w => w.value >= 100 && w.value <= 100000); // Reasonable LBS range

  // Process each size match
  for (let i = 0; i < sizeMatches.length; i++) {
    const sizeMatch = sizeMatches[i];
    const matchIndex = sizeMatch.index!;
    const gauge = parseInt(sizeMatch[1], 10);
    const width = parseInt(sizeMatch[2], 10);
    const length = parseInt(sizeMatch[3], 10);

    // Find the current finish based on section
    const activeSection = sections.filter(s => s.index < matchIndex).pop();
    const finish = activeSection?.finish || currentFinish;

    // Convert gauge to decimal
    const gaugeKey = `${gauge}GA`;
    const thickness = GAUGE_TO_DECIMAL[gaugeKey] || GAUGE_TO_DECIMAL[String(gauge)] || gauge / 1000;

    const size = {
      thickness,
      width,
      length,
      thicknessFormatted: thickness.toFixed(3),
    };

    // Find the nearest item (WM###) before this size
    const nearestItem = itemMatches
      .filter(m => m.index! < matchIndex && m.index! > matchIndex - 100)
      .pop();
    const itemCode = nearestItem ? nearestItem[1] : `WM${String(i + 1).padStart(3, '0')}`;

    // Find the nearest heat number after the size
    const nearestHeat = heatMatches.find(m =>
      m.index! > matchIndex && m.index! < matchIndex + 200
    );
    const heatNumber = nearestHeat ? nearestHeat[1] : '';

    // Find piece count near this row
    // Look for a small number (1-999) near the heat number
    const contextText = text.substring(matchIndex, matchIndex + 300);
    const pcsMatch = contextText.match(/\b(\d{1,3})\b.*?\b(\d{1,2},?\d{3}\.?\d*)\b/);
    const pc = pcsMatch ? parseInt(pcsMatch[1], 10) : 1;

    // Find weights - look for two consecutive weight values after the size
    const weightsAfter = weightMatches.filter(w =>
      w.index > matchIndex && w.index < matchIndex + 300
    ).slice(0, 2);

    // Yuen Chang weights are already in LBS
    const netWeightLbs = weightsAfter.length >= 1 ? Math.round(weightsAfter[0].value) : 0;
    const grossWeightLbs = weightsAfter.length >= 2 ? Math.round(weightsAfter[1].value) : netWeightLbs;

    items.push({
      lineNumber: i + 1,
      inventoryId: buildInventoryId(size, 'yuen-chang', finish),
      lotSerialNbr: itemCode,
      pieceCount: pc,
      heatNumber,
      grossWeightLbs,
      containerQtyLbs: netWeightLbs,
      rawSize: sizeMatch[0],
      warehouse,
      finish,
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

  // Get warehouse from first item or extract from text
  const warehouse = items[0]?.warehouse || extractWarehouse(packingListPage.text);

  return {
    supplier,
    vendorCode: VENDOR_CODES[supplier] || '',
    poNumber,
    items,
    totalGrossWeightLbs,
    totalNetWeightLbs,
    warehouse,
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

  // Get warehouse from first item or extract from text
  const warehouse = items[0]?.warehouse || extractWarehouse(packingListPage.text);

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
    warehouse,
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
