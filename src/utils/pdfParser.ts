import * as pdfjsLib from 'pdfjs-dist';
import { PackingListItem, ParsedPackingList, ParsedInvoice, InvoiceLineItem, Supplier } from '../types';
import { detectSupplier, findPackingListPage } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs, extractWarehouse, extractPoFromBundles, extractPoNumber, extractYeouYihPos } from './conversion';
import { VENDOR_CODES, GAUGE_TO_DECIMAL, getLbsPerSqFt } from './constants';
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
  } else if (supplier === 'yeou-yih') {
    return parseYeouYihText(text, poNumber);
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

  // Extract finish and warehouse from header - only set warehouse if detected
  const finish = extractWuuJingFinish(text);
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);

  // Find all size patterns with imperial dimensions
  // Pattern: thickness*widthMM*lengthMM(imperial) followed by PC and bundle
  const sizePattern = /(\d+\.?\d*)\s*\*\s*(\d+)\s*MM\s*\*\s*(\d+)\s*MM\s*\(([^)]+)\)/gi;

  // Find all bundle patterns: 001837-01, 001772-02, or 001739-4-01 (3-part format)
  // 3-part format: PPPPPP-X-NN where P=PO, X=order/section, N=bundle
  // 2-part format: PPPPPP-NN where P=PO, N=bundle
  const bundlePattern3 = /(\d{6})-(\d+)-(\d{2})/g;
  const bundlePattern2 = /(\d{6})-(\d{2})(?!-\d)/g; // Negative lookahead to avoid matching start of 3-part

  // Find all weight patterns (decimal numbers between 0.5 and 50 MT)
  const weightPattern = /\b(\d{1,2}\.\d{3})\b/g;

  // Extract all matches - collect both formats and merge by position
  const sizeMatches = [...text.matchAll(sizePattern)];
  const bundleMatches3 = [...text.matchAll(bundlePattern3)].map(m => ({ match: m, format: 3 as const }));
  const bundleMatches2 = [...text.matchAll(bundlePattern2)].map(m => ({ match: m, format: 2 as const }));

  // Merge and sort by position in text
  const bundleMatches = [...bundleMatches3, ...bundleMatches2]
    .sort((a, b) => (a.match.index || 0) - (b.match.index || 0));
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
      thicknessFormatted: thickness.toFixed(4),
    };

    // Find corresponding bundle number (look for bundles after this size in the text)
    const matchIndex = sizeMatch.index!;
    const bundleMatchObj = bundleMatches.find(b =>
      b.match.index! > matchIndex && b.match.index! < matchIndex + 300
    );
    let bundleNo: string;
    if (bundleMatchObj) {
      if (bundleMatchObj.format === 3) {
        // 3-part format: 001739-4-01
        bundleNo = `${bundleMatchObj.match[1]}-${bundleMatchObj.match[2]}-${bundleMatchObj.match[3]}`;
      } else {
        // 2-part format: 001739-01
        bundleNo = `${bundleMatchObj.match[1]}-${bundleMatchObj.match[2]}`;
      }
    } else {
      bundleNo = `${poNumber.padStart(6, '0')}-${String(i + 1).padStart(2, '0')}`;
    }

    // Find PC (piece count) - typically a small number (1-20) before the bundle
    // Look for pattern: ) PC BUNDLE
    const pcMatch = text.substring(matchIndex, matchIndex + 150).match(/\)\s*(\d{1,2})\s+\d{6}/);
    const pc = pcMatch ? parseInt(pcMatch[1], 10) : 1;

    // Find weights after the bundle number
    const bundleIndex = bundleMatchObj?.match.index || matchIndex;
    const weightsAfter = weightMatches.filter(w =>
      w.index > bundleIndex &&
      w.index < bundleIndex + 100
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
      warehouse: warehouseDetected ? warehouse : undefined,
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

  // Extract finish and warehouse from header - only set warehouse if detected
  const finish = extractWuuJingFinish(text);
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);

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
        warehouse: warehouseDetected ? warehouse : undefined,
        finish,
        noPaper: size.noPaper,
      });
    }
  }

  return items;
}

/**
 * OCR-optimized Wuu Jing parsing - handles imperfect text
 * Primary strategy: Use bundle numbers as anchors (more reliably detected)
 * Looks for: bundle numbers (001812-XX), imperial dimensions, and weights (X.XXX MT)
 */
function parseWuuJingOcr(text: string, poNumber: string): PackingListItem[] {
  // Extract finish and warehouse from header - only set warehouse if detected
  const finish = extractWuuJingFinish(text);
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);

  // Clean OCR artifacts - common misreads
  const cleanText = text
    .replace(/[oO](?=\d)/g, '0') // O before digit -> 0
    .replace(/(?<=\d)[lI]/g, '1') // l or I after digit -> 1
    .replace(/(?<=\d)[sS](?=\d)/g, '5') // S between digits -> 5
    .replace(/(?<=\d)[Bb](?=\d)/g, '8') // B between digits -> 8
    .replace(/[|](?=\d)/g, '1') // | before digit -> 1
    .replace(/(?<=\d)[|]/g, '1') // | after digit -> 1
    .replace(/MM[^A-Za-z0-9]/gi, 'MM ') // Fix MM followed by punctuation
    .replace(/\bMlvl\b/gi, 'MM') // Common OCR for MM
    .replace(/\bMIVI\b/gi, 'MM') // Another common OCR for MM
    .replace(/\s+/g, ' '); // normalize whitespace

  // Find bundle number patterns: 001812-01, 001812-02, or 001739-4-01 (3-part format)
  // Bundle numbers are the most reliable anchor in OCR text
  // 2-part uses negative lookahead to avoid matching start of 3-part bundles
  const bundlePattern3 = /(\d{6})-(\d+)-(\d{2})/g;
  const bundlePattern2 = /(\d{6})-(\d{2})(?!-\d)/g;
  const bundleMatches3 = [...cleanText.matchAll(bundlePattern3)].map(m => ({ match: m, format: 3 as const }));
  const bundleMatches2 = [...cleanText.matchAll(bundlePattern2)].map(m => ({ match: m, format: 2 as const }));

  // Merge both formats and sort by position
  const bundleMatches = [...bundleMatches3, ...bundleMatches2]
    .sort((a, b) => (a.match.index || 0) - (b.match.index || 0));

  // If we have bundle numbers, use bundle-anchored parsing (primary strategy for OCR)
  if (bundleMatches.length > 0) {
    return parseWuuJingByBundles(cleanText, poNumber, finish, warehouseDetected ? warehouse : undefined, bundleMatches);
  }

  // Fallback: Try size-pattern based parsing
  const items: PackingListItem[] = [];

  // Find all size patterns - more flexible matching for OCR
  // Pattern: thickness*widthMM*lengthMM(imperial)
  const sizePatterns = [
    // Standard format: 4.76*1525MM*3660MM(3/16"*60"*144")
    /(\d+\.?\d*)\s*[*×xX]\s*(\d+)\s*MM\s*[*×xX]\s*(\d+)\s*MM\s*\(([^)]+)\)/gi,
    // Without MM labels: 4.76*1525*3660(3/16"*60"*144")
    /(\d+\.?\d*)\s*[*×xX]\s*(\d{3,4})\s*[*×xX]\s*(\d{3,4})\s*\(([^)]+)\)/gi,
    // OCR may add spaces: 4.76 * 1525 MM * 3660 MM ( 3/16" * 60" * 144" )
    /(\d+\.?\d*)\s*[*×xX]\s*(\d+)\s*M\s*M\s*[*×xX]\s*(\d+)\s*M\s*M\s*\(\s*([^)]+)\s*\)/gi,
    // OCR friendly - MM might be misread as MN, NN, etc.
    /(\d+\.?\d*)\s*[*×xX]\s*(\d+)\s*[MN][MN]\s*[*×xX]\s*(\d+)\s*[MN][MN]\s*\(([^)]+)\)/gi,
  ];

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
      const nearestBundleObj = bundleMatches.find(b =>
        b.match.index! > matchIndex && b.match.index! < matchIndex + 200
      );

      // Find piece count before the bundle number
      const nearestPc = pcMatches.find(p =>
        p.index! > matchIndex && p.index! < (nearestBundleObj?.match.index || matchIndex + 100)
      );

      // Find weights after the bundle number
      const nearestBundleIndex = nearestBundleObj?.match.index || matchIndex;
      const weightsAfter = weightMatches.filter(w =>
        w.index > nearestBundleIndex &&
        w.index < nearestBundleIndex + 150
      );

      lineNum++;
      let bundleNo: string;
      if (nearestBundleObj) {
        bundleNo = nearestBundleObj.format === 3
          ? `${nearestBundleObj.match[1]}-${nearestBundleObj.match[2]}-${nearestBundleObj.match[3]}`
          : `${nearestBundleObj.match[1]}-${nearestBundleObj.match[2]}`;
      } else {
        bundleNo = `${poNumber.padStart(6, '0')}-${String(lineNum).padStart(2, '0')}`;
      }
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
        warehouse: warehouseDetected ? warehouse : undefined,
        finish,
      });
    }

    if (items.length > 0) break; // Found matches with this pattern
  }

  return items;
}

/**
 * Fix common OCR errors in thickness values
 * OCR often drops the "1/" from fractions like "1/4" -> "4"
 */
function fixOcrThickness(thicknessStr: string): number {
  // If it's already a proper fraction, parse it
  if (thicknessStr.includes('/')) {
    const [num, denom] = thicknessStr.split('/').map(Number);
    if (!isNaN(num) && !isNaN(denom) && denom !== 0) {
      return num / denom;
    }
  }

  // If it's a decimal, parse it
  const decimal = parseFloat(thicknessStr);

  // Common OCR error: "1/4" becomes just "4", "3/8" becomes "8", etc.
  // Steel sheet thickness is always < 1 inch, so if we see a whole number >= 2,
  // it's likely an OCR error where the numerator was dropped
  if (!isNaN(decimal) && decimal >= 2 && decimal <= 16) {
    // Assume OCR dropped "1/" - treat as 1/N
    // Common fractions: 1/4 (4), 3/8 (8), 1/2 (2), 5/8 (8), 3/4 (4)
    // But for 8, it could be 3/8 or 5/8 - default to 3/8 (more common)
    const commonFractions: Record<number, number> = {
      2: 0.500,   // 1/2"
      4: 0.250,   // 1/4"
      8: 0.375,   // 3/8" (most common for 8)
      16: 0.188,  // 3/16"
    };
    if (commonFractions[decimal]) {
      return commonFractions[decimal];
    }
    // Otherwise assume it's 1/N
    return 1 / decimal;
  }

  return decimal;
}

/**
 * Validate if a size is reasonable for steel sheet
 * Returns true if valid, false if likely OCR error
 */
function isValidSheetSize(thickness: number, width: number, length: number): boolean {
  // Thickness: 0.018" (26GA) to 1" (common range for sheet steel)
  if (thickness <= 0 || thickness > 1) return false;

  // Width: 36" to 72" (standard sheet widths)
  if (width < 36 || width > 72) return false;

  // Length: 96" to 180" (standard sheet lengths: 96", 120", 144")
  if (length < 96 || length > 180) return false;

  return true;
}

/**
 * Primary Wuu Jing parsing for OCR - uses bundle numbers as anchors
 * Bundle numbers (001812-01 or 001739-4-01) are more reliably detected by OCR than full size patterns
 */
function parseWuuJingByBundles(
  text: string,
  _poNumber: string,
  finish: string,
  warehouse: string | undefined,
  bundleMatches: Array<{ match: RegExpMatchArray; format: 2 | 3 }>
): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Find ALL imperial dimension patterns in the text
  // Multiple patterns for OCR flexibility
  const imperialPatterns = [
    // Standard: 3/16"*60"*144" or 1/4"*48"*120"
    /(\d+\/\d+)[""']?\s*[*×xX]\s*(\d+)[""']?\s*[*×xX]\s*(\d+)/g,
    // Decimal thickness: 0.188"*60"*144"
    /(\d+\.\d+)[""']?\s*[*×xX]\s*(\d+)[""']?\s*[*×xX]\s*(\d+)/g,
    // Without quotes: 3/16 * 60 * 144
    /(\d+\/\d+)\s*[*×xX]\s*(\d+)\s*[*×xX]\s*(\d+)/g,
    // OCR error: single digit thickness (4 instead of 1/4): 4"*48"*120"
    /\b([2-8])[""']?\s*[*×xX]\s*(\d{2})[""']?\s*[*×xX]\s*(\d{2,3})[""']?/g,
  ];

  // Collect all imperial matches from all patterns
  const allImperialMatches: Array<{match: RegExpMatchArray, index: number}> = [];
  for (const pattern of imperialPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const thickness = fixOcrThickness(m[1]);
      const width = parseFloat(m[2]);
      const length = parseFloat(m[3]);

      // Validate dimensions
      if (isValidSheetSize(thickness, width, length)) {
        allImperialMatches.push({ match: m, index: m.index! });
      }
    }
  }

  // Sort by index
  allImperialMatches.sort((a, b) => a.index - b.index);

  // Find weight patterns (MT weights: 0.500 to 50.000)
  const weightPattern = /(\d{1,2}\.\d{2,3})/g;
  const weightMatches = [...text.matchAll(weightPattern)]
    .map(m => ({ value: parseFloat(m[1]), index: m.index! }))
    .filter(w => w.value >= 0.3 && w.value <= 50);

  // Track the last valid size (for carry-forward when OCR misses a size)
  let lastValidSize: { thickness: number; width: number; length: number; thicknessFormatted: string } | null = null;

  // Process each bundle number as an anchor
  for (let i = 0; i < bundleMatches.length; i++) {
    const bundleMatchObj = bundleMatches[i];
    const bundleMatch = bundleMatchObj.match;
    // Construct bundle number based on format (2-part or 3-part)
    const bundleNo = bundleMatchObj.format === 3
      ? `${bundleMatch[1]}-${bundleMatch[2]}-${bundleMatch[3]}`
      : `${bundleMatch[1]}-${bundleMatch[2]}`;
    const bundleIndex = bundleMatch.index!;

    // Look for imperial dimension before this bundle (within 400 chars)
    const lookbackStart = Math.max(0, bundleIndex - 400);
    const lookbackRange = { start: lookbackStart, end: bundleIndex };

    // Find the closest imperial match before this bundle
    const matchesBeforeBundle = allImperialMatches.filter(m =>
      m.index >= lookbackRange.start && m.index < lookbackRange.end
    );

    let size = null;

    if (matchesBeforeBundle.length > 0) {
      // Use the closest one (last in the list)
      const nearest = matchesBeforeBundle[matchesBeforeBundle.length - 1];
      const thickness = fixOcrThickness(nearest.match[1]);
      const width = parseFloat(nearest.match[2]);
      const length = parseFloat(nearest.match[3]);

      // Double-check validity (already filtered, but be safe)
      if (isValidSheetSize(thickness, width, length)) {
        size = {
          thickness,
          width,
          length,
          thicknessFormatted: formatThickness(thickness),
        };
        lastValidSize = size; // Save for carry-forward
      }
    }

    // If no size found, use carry-forward from previous bundle
    if (!size && lastValidSize) {
      size = lastValidSize;
    }

    // If still no size, skip this bundle
    if (!size) continue;

    // Find piece count - look for small number (1-20) near the bundle
    // Piece count usually appears just before the bundle number
    const lookbackText = text.substring(lookbackStart, bundleIndex);
    const pcPatterns = [
      /\b(\d{1,2})\s+\d{6}-\d{2}/,  // "8 001812-01"
      /\)\s*(\d{1,2})\s+\d{6}/,      // ") 8 001812"
      /\b(\d{1,2})\s*$/,             // ends with small number
    ];

    let pc = 1;
    for (const pcPattern of pcPatterns) {
      const pcMatch = lookbackText.match(pcPattern);
      if (pcMatch) {
        const foundPc = parseInt(pcMatch[1], 10);
        if (foundPc > 0 && foundPc <= 20) {
          pc = foundPc;
          break;
        }
      }
    }

    // Find weights after the bundle number (within 150 chars)
    const weightsAfter = weightMatches.filter(w =>
      w.index > bundleIndex && w.index < bundleIndex + 150
    );

    // Take first two weights after bundle (net, gross)
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
      rawSize: `${size.thicknessFormatted}"*${size.width}"*${size.length}"`,
      warehouse,
      finish,
    });
  }

  return items;
}

/**
 * Format thickness helper for OCR parser
 */
function formatThickness(thickness: number): string {
  return thickness.toFixed(4);
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
 * Extract PO number from Yuen Chang document
 * Looks for "EXCEL ORDER # 001836" pattern
 */
function extractYuenChangPoNumber(text: string): string {
  const match = text.match(/EXCEL\s+ORDER\s*#\s*0*(\d{3,6})/i);
  if (match) {
    return match[1];
  }
  return '';
}

/**
 * Extract container number from Yuen Chang section header
 * Looks for "CONTAINER NUMBER : HMMU2202248" pattern
 */
function extractYuenChangContainerNumber(text: string): string {
  const match = text.match(/CONTAINER\s+(?:NUMBER|NO\.?)\s*[:\.]?\s*([A-Z]{4}\d{6,7})/i);
  if (match) {
    return match[1];
  }
  return '';
}

/**
 * Parse a single Yuen Chang data row
 * Returns parsed item or null if not a valid data row
 */
interface YuenChangRowData {
  lineNo: number;
  itemCode: string;
  gauge: number;
  width: number;
  length: number;
  coilNo: string;
  heatNumber: string;
  pieceCount: number;
  netWeightLbs: number;
  grossWeightLbs: number;
}

function parseYuenChangRow(rowText: string): YuenChangRowData | null {
  // Row format: NO | Item | SIZE (GA) | COIL NO. | Heat NO. | PCS | NET WEIGHT | GROSS WEIGHT
  // Example: 1 YV034 20GA x 48" x 120" 49S14451A-017 YU107664 65 3,877.93 4,003.59

  // Find item code: 2 uppercase letters + 3 digits (YV034, WM006, XL007)
  const itemMatch = rowText.match(/\b([A-Z]{2}\d{3})\b/);
  if (!itemMatch) return null;

  // Find size: ##GA x ##" x ###"
  const sizeMatch = rowText.match(/(\d{1,2})GA\s*[x×*]\s*(\d{2,3})[""']?\s*[x×*]\s*(\d{2,3})[""']?/i);
  if (!sizeMatch) return null;

  // Find coil number: alphanumeric pattern like 49S14451A-017, 4CS75060-021, F9244-025
  const coilMatch = rowText.match(/\b(\d{1,2}[A-Z]{1,2}\d{4,5}[A-Z]?-\d{2,3}|[A-Z]\d{4}-\d{2,3})\b/);

  // Find heat number: patterns like YU107664, ZU407, S97UE10C, 50909G10B2, S999G03B
  // Must come after the coil number in the text
  const coilEnd = coilMatch ? (coilMatch.index! + coilMatch[0].length) : sizeMatch.index! + sizeMatch[0].length;
  const afterCoilText = rowText.substring(coilEnd);
  const heatMatch = afterCoilText.match(/\b([A-Z]{1,2}\d{1,2}[A-Z0-9]{2,6}|\d{5}[A-Z]\d{2}[A-Z]\d?)\b/);

  // Find weights: comma-formatted numbers like 3,877.93 or 4,003.59
  // These should be at the end of the row after all other data
  const weightMatches = [...rowText.matchAll(/\b(\d{1,2},?\d{3}\.\d{2})\b/g)]
    .map(m => ({
      value: parseFloat(m[1].replace(',', '')),
      index: m.index!
    }))
    .filter(w => w.value >= 100 && w.value <= 100000);

  // Find piece count: small number (1-500) that appears AFTER the heat number and BEFORE the weights
  // It should be between heat and first weight
  let pieceCount = 1;
  if (heatMatch && weightMatches.length >= 1) {
    const heatEnd = coilEnd + heatMatch.index! + heatMatch[0].length;
    const firstWeightStart = weightMatches[0].index;
    const betweenText = rowText.substring(heatEnd, firstWeightStart);
    const pcsMatch = betweenText.match(/\b(\d{1,3})\b/);
    if (pcsMatch) {
      const pcs = parseInt(pcsMatch[1], 10);
      if (pcs > 0 && pcs <= 500) {
        pieceCount = pcs;
      }
    }
  }

  // Try to extract line number from the beginning
  const lineNoMatch = rowText.match(/^\s*(\d{1,2})\s+[A-Z]{2}\d{3}/);
  const lineNo = lineNoMatch ? parseInt(lineNoMatch[1], 10) : 0;

  // Get weights - last two weight values are net and gross
  const netWeightLbs = weightMatches.length >= 2
    ? Math.round(weightMatches[weightMatches.length - 2].value)
    : (weightMatches.length === 1 ? Math.round(weightMatches[0].value) : 0);
  const grossWeightLbs = weightMatches.length >= 1
    ? Math.round(weightMatches[weightMatches.length - 1].value)
    : netWeightLbs;

  return {
    lineNo,
    itemCode: itemMatch[1],
    gauge: parseInt(sizeMatch[1], 10),
    width: parseInt(sizeMatch[2], 10),
    length: parseInt(sizeMatch[3], 10),
    coilNo: coilMatch ? coilMatch[1] : '',
    heatNumber: heatMatch ? heatMatch[1] : '',
    pieceCount,
    netWeightLbs,
    grossWeightLbs,
  };
}

/**
 * Parse Yuen Chang packing list format
 * Handles multi-container documents with section headers
 * Columns: NO. | Item | SIZE (GA) | COIL NO. | Heat NO. | PCS | NET WEIGHT (LBS) | GROSS WEIGHT (LBS)
 */
function parseYuenChangText(text: string, _poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Extract warehouse from destination - only set on items if actually detected
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);

  // Split text by container sections
  // Pattern: "CONTAINER NUMBER : XXXX" or "CONTAINER NUMBER: XXXX"
  const containerSections = text.split(/(?=CONTAINER\s+(?:NUMBER|NO\.?)\s*[:\.]?\s*[A-Z]{4}\d{6,7})/i);

  let globalLineNumber = 0;

  for (const section of containerSections) {
    if (!section.trim()) continue;

    // Extract container number for this section
    const containerNumber = extractYuenChangContainerNumber(section);

    // Extract finish for this section (can change between sections)
    const finish = extractYuenChangFinish(section);

    // Find all item codes in this section to identify data rows
    const itemPattern = /\b([A-Z]{2}\d{3})\b/g;
    let itemMatch;

    while ((itemMatch = itemPattern.exec(section)) !== null) {
      // Extract a window around this item code to parse as a row
      // Look backwards for line number, forwards for size, coil, heat, pcs, weights
      // Use larger window (350 chars) to ensure weights are captured for all row formats
      const windowStart = Math.max(0, itemMatch.index - 20);
      const windowEnd = Math.min(section.length, itemMatch.index + 350);
      const rowText = section.substring(windowStart, windowEnd);

      const rowData = parseYuenChangRow(rowText);
      if (!rowData) continue;

      // Skip if this looks like a duplicate (same item code within 50 chars)
      const lastItem = items[items.length - 1];
      if (lastItem && lastItem.lotSerialNbr === rowData.itemCode) {
        continue;
      }

      globalLineNumber++;

      // Convert gauge to decimal thickness
      const gaugeKey = `${rowData.gauge}GA`;
      const thickness = GAUGE_TO_DECIMAL[gaugeKey] || GAUGE_TO_DECIMAL[String(rowData.gauge)] || rowData.gauge / 1000;

      const size = {
        thickness,
        width: rowData.width,
        length: rowData.length,
        thicknessFormatted: thickness.toFixed(4),
      };

      items.push({
        lineNumber: globalLineNumber,
        inventoryId: buildInventoryId(size, 'yuen-chang', finish),
        lotSerialNbr: rowData.itemCode,
        pieceCount: rowData.pieceCount,
        heatNumber: rowData.heatNumber,
        grossWeightLbs: rowData.grossWeightLbs,
        containerQtyLbs: rowData.netWeightLbs,
        rawSize: `${rowData.gauge}GA x ${rowData.width}" x ${rowData.length}"`,
        warehouse: warehouseDetected ? warehouse : undefined,
        finish,
        containerNumber,
      });
    }
  }

  // If no items found with section-based parsing, try the legacy approach
  if (items.length === 0) {
    return parseYuenChangTextLegacy(text, _poNumber);
  }

  return items;
}

/**
 * Legacy Yuen Chang parsing - fallback for older format documents
 * Restores item code, heat number, and piece count extraction
 */
function parseYuenChangTextLegacy(text: string, _poNumber: string): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Extract warehouse from destination - only set on items if actually detected
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);
  const containerNumber = extractYuenChangContainerNumber(text);

  // Track current finish
  let currentFinish = extractYuenChangFinish(text);

  // Find section headers to track finish changes
  const sectionPattern = /304\/304L\s*(2B|#\d|BA)\s*Finish/gi;
  const sections: { finish: string; index: number }[] = [];
  let sectionMatch;
  while ((sectionMatch = sectionPattern.exec(text)) !== null) {
    sections.push({ finish: sectionMatch[1], index: sectionMatch.index });
  }

  // Item pattern: 2 uppercase letters + 3 digits (e.g., WM006, XL007, YF002, YN005)
  const itemPattern = /\b([A-Z]{2}\d{3})\b/g;
  const itemMatches = [...text.matchAll(itemPattern)];

  // Size pattern: ##GA x ##" x ###"
  const sizePattern = /(\d{1,2})GA\s*[x×*]\s*(\d{2,3})[""']?\s*[x×*]\s*(\d{2,3})[""']?/gi;
  const sizeMatches = [...text.matchAll(sizePattern)];

  // Heat number pattern: various formats
  // Standard: YU107343, ZU407, S97PG13C, S98GA07D, ZT636, ZU195
  // With hyphen: B6381-2000
  const heatPattern = /\b([A-Z]{1,2}\d{1,2}[A-Z0-9]{2,6}|[A-Z]\d{4}-\d{3,4})\b/g;
  const heatMatches = [...text.matchAll(heatPattern)];

  // Weight pattern: numbers with commas like 3,730.22 or just 3730.22
  // Also match without decimal for flexibility
  const weightPattern = /\b(\d{1,2},?\d{3}\.?\d{0,2})\b/g;
  const weightMatches = [...text.matchAll(weightPattern)]
    .map(m => ({
      value: parseFloat(m[1].replace(',', '')),
      index: m.index!
    }))
    .filter(w => w.value >= 100 && w.value <= 100000);

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
      thicknessFormatted: thickness.toFixed(4),
    };

    // Find the nearest item code (WM###, XL###, YF###, YN###, etc.) before this size
    // Items appear in the row before the size, typically within 50 chars
    const nearestItem = itemMatches
      .filter(m => m.index! < matchIndex && m.index! > matchIndex - 50)
      .pop();
    const itemCode = nearestItem ? nearestItem[1] : `IT${String(i + 1).padStart(3, '0')}`;

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
      warehouse: warehouseDetected ? warehouse : undefined,
      finish,
      containerNumber,
    });
  }

  return items;
}

/**
 * Extract container number from YYS packing list
 */
function extractYeouYihContainer(text: string): string {
  const match = text.match(/CONTAINER\s*NO\.?\s*[:\.]?\s*([A-Z]{4}\d{6,7})/i);
  return match ? match[1] : '';
}

/**
 * Clean OCR artifacts from YYS text
 * Handles common OCR misreads for YYS documents
 */
function cleanYeouYihOcrText(text: string): string {
  return text
    // Fix common digit misreads
    .replace(/[oO](?=\d)/g, '0')     // O before digit -> 0
    .replace(/(?<=\d)[oO]/g, '0')    // O after digit -> 0
    .replace(/(?<=\d)[lI]/g, '1')    // l or I after digit -> 1
    .replace(/[|](?=\d)/g, '1')      // | before digit -> 1
    .replace(/(?<=\d)[|]/g, '1')     // | after digit -> 1
    .replace(/(?<=\d)[sS](?=\d)/g, '5') // S between digits -> 5
    .replace(/(?<=\d)[Bb](?=\d)/g, '8') // B between digits -> 8
    // Fix common unit misreads
    .replace(/\bKG5\b/gi, 'KGS')     // KG5 -> KGS
    .replace(/\bKG\$/gi, 'KGS')      // KG$ -> KGS
    .replace(/\bK6S\b/gi, 'KGS')     // K6S -> KGS
    .replace(/\bPC5\b/gi, 'PCS')     // PC5 -> PCS
    .replace(/\bPG5\b/gi, 'PCS')     // PG5 -> PCS
    .replace(/\bMI\b/gi, 'MT')       // MI -> MT (metric ton)
    // Fix X separator misreads
    .replace(/\s*[xX×]\s*/g, ' X ')  // Normalize X separator
    .replace(/\s*[Xx]\s*(?=\d)/g, ' X ') // x before digit
    // Fix quote misreads
    .replace(/[''`]/g, '"')          // Various quotes -> "
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate YYS plate dimensions
 * Returns true if dimensions are reasonable for steel plate
 */
function isValidYeouYihDimensions(thickness: number, width: number, length: number): boolean {
  // YYS sells heavier plate: 1/2" to 2" (0.375 to 2.0)
  if (thickness < 0.375 || thickness > 2.5) return false;

  // Common widths: 48", 60", rarely others
  if (width < 36 || width > 72) return false;

  // Common lengths: 96", 120", 144", 240"
  if (length < 72 || length > 300) return false;

  // Width should be less than length
  if (width > length) return false;

  return true;
}

/**
 * Calculate theoretical weight for validation
 * Uses Chatham pounds per square foot
 */
function calculateTheoreticalWeight(thickness: number, width: number, length: number, pieceCount: number): number {
  const lbsPerSqFt = getLbsPerSqFt(thickness);
  if (!lbsPerSqFt) return 0;

  const sqFt = (width * length) / 144;
  return Math.round(sqFt * lbsPerSqFt * pieceCount);
}

/**
 * Validate extracted weight against theoretical weight
 * Returns confidence level: 'high', 'medium', 'low'
 */
function validateYeouYihWeight(
  extractedWeightLbs: number,
  thickness: number,
  width: number,
  length: number,
  pieceCount: number
): 'high' | 'medium' | 'low' {
  const theoreticalWeight = calculateTheoreticalWeight(thickness, width, length, pieceCount);
  if (theoreticalWeight === 0) return 'medium'; // Can't validate

  const ratio = extractedWeightLbs / theoreticalWeight;

  // Within 10% = high confidence
  if (ratio >= 0.9 && ratio <= 1.1) return 'high';

  // Within 25% = medium confidence (could be skid weight, etc.)
  if (ratio >= 0.75 && ratio <= 1.25) return 'medium';

  // Outside 25% = low confidence
  return 'low';
}

/**
 * Parse Yeou Yih Steel packing list format
 * Description format: "304/304L 0.750" X 60" X 120"" with piece count like "3PCS"
 * Weights: Quantity in MT, weights in KGS
 */
function parseYeouYihText(text: string, poNumber: string): PackingListItem[] {
  // Clean OCR artifacts first
  const cleanText = cleanYeouYihOcrText(text);

  // Extract warehouse from destination - only set on items if actually detected
  const { warehouse, detected: warehouseDetected } = extractWarehouse(cleanText);
  const effectiveWarehouse = warehouseDetected ? warehouse : undefined;

  // Extract container number
  const containerNumber = extractYeouYihContainer(cleanText);

  // Default finish for YYS is #1 (hot rolled)
  const finish = '#1';

  // Try standard parsing first
  let parsedItems = parseYeouYihTextStandard(cleanText, poNumber, effectiveWarehouse, containerNumber, finish);

  // If standard parsing failed or got few items, try OCR-optimized parsing
  if (parsedItems.length === 0) {
    parsedItems = parseYeouYihTextOcr(cleanText, poNumber, effectiveWarehouse, containerNumber, finish);
  }

  return parsedItems;
}

/**
 * Standard YYS parsing for clean text
 */
function parseYeouYihTextStandard(
  text: string,
  poNumber: string,
  warehouse: string | undefined,
  containerNumber: string,
  finish: string
): PackingListItem[] {
  const items: PackingListItem[] = [];

  // Find all size patterns with decimal inch format
  // Pattern: 0.750" X 60" X 120" (with optional 304/304L prefix)
  const sizePattern = /(\d+\.\d+)[""']?\s*X\s*(\d+)[""']?\s*X\s*(\d+)[""']?/gi;
  const sizeMatches = [...text.matchAll(sizePattern)];

  // Find KGS weight patterns: 2,106KGS or 2106KGS or 2,106 KGS
  const kgsPattern = /([\d,]+)\s*KGS/gi;
  const kgsMatches = [...text.matchAll(kgsPattern)]
    .map(m => ({ value: parseFloat(m[1].replace(/,/g, '')), index: m.index! }));

  // Process each size match
  for (let i = 0; i < sizeMatches.length; i++) {
    const sizeMatch = sizeMatches[i];
    const matchIndex = sizeMatch.index!;

    const thickness = parseFloat(sizeMatch[1]);
    const width = parseFloat(sizeMatch[2]);
    const length = parseFloat(sizeMatch[3]);

    // Validate dimensions
    if (isNaN(thickness) || isNaN(width) || isNaN(length)) continue;
    if (!isValidYeouYihDimensions(thickness, width, length)) continue;

    const size = {
      thickness,
      width,
      length,
      thicknessFormatted: thickness.toFixed(4),
    };

    // Find piece count near this size (within 100 chars after)
    const contextText = text.substring(matchIndex, matchIndex + 100);
    const pcMatch = contextText.match(/(\d+)\s*PCS?/i);
    let pc = pcMatch ? parseInt(pcMatch[1], 10) : 1;

    // Validate piece count (reasonable range for steel bundles)
    if (pc < 1 || pc > 50) pc = 1;

    // Find KGS weights after this size (net and gross)
    const kgsAfter = kgsMatches.filter(m =>
      m.index > matchIndex && m.index < matchIndex + 200
    );

    // Convert KGS to LBS (1 kg = 2.20462 lbs)
    const netWeightKgs = kgsAfter.length >= 1 ? kgsAfter[0].value : 0;
    const grossWeightKgs = kgsAfter.length >= 2 ? kgsAfter[1].value : netWeightKgs;
    let netWeightLbs = Math.round(netWeightKgs * 2.20462);
    let grossWeightLbs = Math.round(grossWeightKgs * 2.20462);

    // Validate weights against theoretical
    const weightConfidence = validateYeouYihWeight(netWeightLbs, thickness, width, length, pc);

    // If weight validation is low, try to use theoretical weight as fallback
    if (weightConfidence === 'low' && netWeightLbs > 0) {
      const theoreticalWeight = calculateTheoreticalWeight(thickness, width, length, pc);
      if (theoreticalWeight > 0) {
        // Log warning but use extracted weight (user can verify)
        console.warn(`YYS OCR: Weight mismatch for ${thickness}"x${width}"x${length}" - extracted: ${netWeightLbs} lbs, theoretical: ${theoreticalWeight} lbs`);
      }
    }

    // If no weights found, calculate theoretical
    if (netWeightLbs === 0) {
      netWeightLbs = calculateTheoreticalWeight(thickness, width, length, pc);
      grossWeightLbs = Math.round(netWeightLbs * 1.01); // Add ~1% for skid
    }

    // Build lot serial number from PO and line number
    const lotSerial = buildLotSerialNbr(poNumber, i + 1);

    items.push({
      lineNumber: i + 1,
      inventoryId: buildInventoryId(size, 'yeou-yih', finish),
      lotSerialNbr: lotSerial,
      pieceCount: pc,
      heatNumber: '',
      grossWeightLbs,
      containerQtyLbs: netWeightLbs,
      rawSize: sizeMatch[0],
      warehouse,
      finish,
      containerNumber,
    });
  }

  return items;
}

/**
 * OCR-optimized YYS parsing - more flexible patterns for noisy text
 */
function parseYeouYihTextOcr(
  text: string,
  poNumber: string,
  warehouse: string | undefined,
  containerNumber: string,
  finish: string
): PackingListItem[] {
  const items: PackingListItem[] = [];

  // More flexible size patterns for OCR
  const sizePatterns = [
    // Standard: 0.750" X 60" X 120"
    /(\d+\.\d+)[""']?\s*X\s*(\d+)[""']?\s*X\s*(\d+)/gi,
    // Without quotes: 0.750 X 60 X 120
    /(\d+\.\d{2,3})\s*X\s*(\d{2})\s*X\s*(\d{2,3})/gi,
    // With spaces around X: 0.750 " X 60 " X 120
    /(\d+\.\d+)\s*"?\s*X\s*(\d+)\s*"?\s*X\s*(\d+)/gi,
    // OCR might split: 0 . 750 X 60 X 120
    /(\d+)\s*\.\s*(\d{2,3})\s*X\s*(\d{2})\s*X\s*(\d{2,3})/gi,
  ];

  // Weight patterns - more flexible for OCR
  const weightPatterns = [
    /([\d,]+)\s*KGS/gi,           // 2,106KGS
    /([\d,]+)\s*KG/gi,            // 2,106KG
    /([\d,]+)\s*K\s*G\s*S/gi,     // 2,106 K G S (OCR spacing)
    /(\d+,\d{3})/g,               // Just numbers with comma (likely KGS)
  ];

  // Try each size pattern
  for (const sizePattern of sizePatterns) {
    const sizeMatches = [...text.matchAll(sizePattern)];

    for (let i = 0; i < sizeMatches.length; i++) {
      const sizeMatch = sizeMatches[i];
      const matchIndex = sizeMatch.index!;

      let thickness: number;
      let width: number;
      let length: number;

      // Handle split decimal pattern (0 . 750 format)
      if (sizeMatch.length === 5) {
        thickness = parseFloat(`${sizeMatch[1]}.${sizeMatch[2]}`);
        width = parseFloat(sizeMatch[3]);
        length = parseFloat(sizeMatch[4]);
      } else {
        thickness = parseFloat(sizeMatch[1]);
        width = parseFloat(sizeMatch[2]);
        length = parseFloat(sizeMatch[3]);
      }

      // Validate dimensions
      if (isNaN(thickness) || isNaN(width) || isNaN(length)) continue;
      if (!isValidYeouYihDimensions(thickness, width, length)) continue;

      // Check if we already have this size (avoid duplicates from multiple patterns)
      const isDuplicate = items.some(item => {
        const existingSize = item.rawSize;
        return Math.abs(parseFloat(existingSize.split('X')[0]) - thickness) < 0.01;
      });
      if (isDuplicate) continue;

      const size = {
        thickness,
        width,
        length,
        thicknessFormatted: thickness.toFixed(4),
      };

      // Find piece count
      const contextText = text.substring(matchIndex, matchIndex + 150);
      const pcMatch = contextText.match(/(\d+)\s*PCS?/i);
      let pc = pcMatch ? parseInt(pcMatch[1], 10) : 1;
      if (pc < 1 || pc > 50) pc = 1;

      // Find weights using multiple patterns
      let netWeightKgs = 0;
      let grossWeightKgs = 0;

      for (const weightPattern of weightPatterns) {
        const afterText = text.substring(matchIndex, matchIndex + 250);
        const weightMatches = [...afterText.matchAll(weightPattern)]
          .map(m => parseFloat(m[1].replace(/,/g, '')))
          .filter(w => w > 100 && w < 50000); // Reasonable KGS range

        if (weightMatches.length >= 2) {
          netWeightKgs = weightMatches[0];
          grossWeightKgs = weightMatches[1];
          break;
        } else if (weightMatches.length === 1) {
          netWeightKgs = weightMatches[0];
          grossWeightKgs = weightMatches[0];
          break;
        }
      }

      // Convert KGS to LBS
      let netWeightLbs = Math.round(netWeightKgs * 2.20462);
      let grossWeightLbs = Math.round(grossWeightKgs * 2.20462);

      // If no weights found, use theoretical
      if (netWeightLbs === 0) {
        netWeightLbs = calculateTheoreticalWeight(thickness, width, length, pc);
        grossWeightLbs = Math.round(netWeightLbs * 1.01);
      }

      const lotSerial = buildLotSerialNbr(poNumber, items.length + 1);

      items.push({
        lineNumber: items.length + 1,
        inventoryId: buildInventoryId(size, 'yeou-yih', finish),
        lotSerialNbr: lotSerial,
        pieceCount: pc,
        heatNumber: '',
        grossWeightLbs,
        containerQtyLbs: netWeightLbs,
        rawSize: `${thickness.toFixed(4)}" X ${width}" X ${length}"`,
        warehouse,
        finish,
        containerNumber,
      });
    }

    // If we found items with this pattern, stop trying other patterns
    if (items.length > 0) break;
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
      noPaper: size.noPaper,
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

  // For Yuen Chang, extract PO from document content (EXCEL ORDER # pattern)
  // This takes priority over filename-based extraction
  let effectivePoNumber = poNumber;
  if (supplier === 'yuen-chang') {
    const ycPo = extractYuenChangPoNumber(packingListPage.text);
    if (ycPo) {
      effectivePoNumber = ycPo;
    }
  }

  // Parse items from the packing list
  const items = parsePackingListFromText(packingListPage.text, supplier, effectivePoNumber);

  if (items.length === 0) {
    // Provide more context about what was found
    const preview = packingListPage.text.substring(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Could not parse items. Supplier: ${supplier}. Preview: "${preview}..."`);
  }

  // Calculate totals
  const totalGrossWeightLbs = items.reduce((sum, item) => sum + item.grossWeightLbs, 0);
  const totalNetWeightLbs = items.reduce((sum, item) => sum + item.containerQtyLbs, 0);

  // Get warehouse from first item or extract from text
  let warehouse: string;
  let warehouseDetected: boolean;
  if (items[0]?.warehouse) {
    warehouse = items[0].warehouse;
    warehouseDetected = true; // Item-level warehouse was set during parsing
  } else {
    const result = extractWarehouse(packingListPage.text);
    warehouse = result.warehouse;
    warehouseDetected = result.detected;
  }

  // Auto-detect PO if not provided or is UNKNOWN
  let finalPoNumber = effectivePoNumber;
  if (!effectivePoNumber || effectivePoNumber === 'UNKNOWN') {
    // Try to extract from bundle numbers (Wuu Jing)
    const bundlePo = extractPoFromBundles(packingListPage.text);
    if (bundlePo) {
      finalPoNumber = bundlePo;
    } else {
      // Try Yeou Yih pattern: S####### ######
      const yysPos = extractYeouYihPos(packingListPage.text);
      if (yysPos.length > 0) {
        finalPoNumber = yysPos[0];
      } else {
        // Try to extract from text (explicit PO patterns)
        const textPo = extractPoNumber(packingListPage.text);
        finalPoNumber = textPo || '';
      }
    }
  }

  return {
    supplier,
    vendorCode: VENDOR_CODES[supplier] || '',
    poNumber: finalPoNumber,
    items,
    totalGrossWeightLbs,
    totalNetWeightLbs,
    warehouse,
    warehouseDetected,
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

  // NEW APPROACH: Try parsing each page and use the one with most items
  // This is more reliable than keyword-based page detection when OCR quality is low
  let bestResult: { pageNum: number; items: PackingListItem[]; supplier: Supplier; text: string } | null = null;

  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i];
    if (!pageText.trim()) continue;

    const pageSupplier = detectSupplier(pageText);

    // For Yuen Chang, extract PO from document content
    let effectivePoNumber = poNumber;
    if (pageSupplier === 'yuen-chang') {
      const ycPo = extractYuenChangPoNumber(pageText);
      if (ycPo) {
        effectivePoNumber = ycPo;
      }
    }

    try {
      const pageItems = parsePackingListFromText(pageText, pageSupplier, effectivePoNumber);
      if (pageItems.length > 0) {
        if (!bestResult || pageItems.length > bestResult.items.length) {
          bestResult = {
            pageNum: i + 1,
            items: pageItems,
            supplier: pageSupplier,
            text: pageText,
          };
        }
      }
    } catch {
      // Page couldn't be parsed, continue to next
    }
  }

  // Fallback to keyword-based page detection if no items found
  if (!bestResult) {
    const packingListPage = findPackingListPage(pages);
    if (!packingListPage) {
      throw new Error('Could not identify packing list page after OCR');
    }

    const supplier = detectSupplier(packingListPage.text);

    // For Yuen Chang, extract PO from document content
    let effectivePoNumber = poNumber;
    if (supplier === 'yuen-chang') {
      const ycPo = extractYuenChangPoNumber(packingListPage.text);
      if (ycPo) {
        effectivePoNumber = ycPo;
      }
    }

    const items = parsePackingListFromText(packingListPage.text, supplier, effectivePoNumber);

    if (items.length === 0) {
      const preview = packingListPage.text.substring(0, 300).replace(/\s+/g, ' ');
      throw new Error(
        `Could not parse items from OCR text. Supplier: ${supplier}. ` +
        `Confidence: ${Math.round(accuracy.averageConfidence)}%. ` +
        `Preview: "${preview}..."`
      );
    }

    bestResult = {
      pageNum: packingListPage.pageNumber,
      items,
      supplier,
      text: packingListPage.text,
    };
  }

  const { items, supplier, text: packingListText } = bestResult;

  // Calculate totals
  const totalGrossWeightLbs = items.reduce((sum, item) => sum + item.grossWeightLbs, 0);
  const totalNetWeightLbs = items.reduce((sum, item) => sum + item.containerQtyLbs, 0);

  // Get warehouse from first item or extract from text
  let warehouse: string;
  let warehouseDetected: boolean;
  if (items[0]?.warehouse) {
    warehouse = items[0].warehouse;
    warehouseDetected = true;
  } else {
    const result = extractWarehouse(packingListText);
    warehouse = result.warehouse;
    warehouseDetected = result.detected;
  }

  // Auto-detect PO if not provided or is UNKNOWN
  let finalPoNumber = poNumber;
  if (!poNumber || poNumber === 'UNKNOWN') {
    // For Yuen Chang, try EXCEL ORDER # pattern first
    if (supplier === 'yuen-chang') {
      const ycPo = extractYuenChangPoNumber(packingListText);
      if (ycPo) {
        finalPoNumber = ycPo;
      }
    }

    // If still not found, try other patterns
    if (!finalPoNumber || finalPoNumber === 'UNKNOWN') {
      // Try to extract from bundle numbers (Wuu Jing)
      const bundlePo = extractPoFromBundles(packingListText);
      if (bundlePo) {
        finalPoNumber = bundlePo;
      } else {
        // Try to extract from text (explicit PO patterns)
        const textPo = extractPoNumber(packingListText);
        finalPoNumber = textPo || '';
      }
    }
  } else if (supplier === 'yuen-chang') {
    // Even if PO was provided (from filename), prefer document content for Yuen Chang
    const ycPo = extractYuenChangPoNumber(packingListText);
    if (ycPo) {
      finalPoNumber = ycPo;
    }
  }

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
    poNumber: finalPoNumber,
    items,
    totalGrossWeightLbs,
    totalNetWeightLbs,
    warehouse,
    warehouseDetected,
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

/**
 * Detect if a PDF page is a commercial invoice (vs packing list)
 */
export function isInvoicePage(text: string): boolean {
  const invoiceIndicators = [
    /COMMERCIAL\s+INVOICE/i,
    /PRICE\s*\(USD\/(?:PCS|MT)\)/i,  // Matches both USD/PCS and USD/MT
    /PRICE\s+US\$\/(?:PC|MT)/i,
    /UNIT\s+PRICE/i,
    /TOTAL\s+INVOICE\s+VALUE/i,
    /VALUE\s*\(USD\)/i,              // YC invoice column header
    /FOB\s+Cost/i,                   // YC invoice field
    /Documentary\s+Credit/i,         // YC invoice field
    /Ocean\s+Freight/i,              // YC invoice field
    /Issuing\s+Bank/i,               // YC invoice field
  ];

  const packingIndicators = [
    /PACKING\s+LIST/i,
    /CONTAINER\s+NO(?:MBER)?\.?\s*:/i,  // Matches "CONTAINER NO." and "CONTAINER NUMBER :"
    /BUNDLE\s+NO\./i,
    /G['']?WEIGHT/i,
    /N['']?WEIGHT/i,
    /COIL\s+NO\./i,                  // YC packing list column
    /Heat\s+NO\./i,                  // YC packing list column
  ];

  const invoiceScore = invoiceIndicators.filter(p => p.test(text)).length;
  const packingScore = packingIndicators.filter(p => p.test(text)).length;

  return invoiceScore > packingScore && invoiceScore >= 1;
}

/**
 * Extract PO number from YC invoice text
 * Looks for: "EXCEL ORDER # 001852" or "EXCEL METALS LLC ORDER NO.: 001772"
 */
function extractInvoicePoNumber(text: string): string {
  // EXCEL ORDER # 001852
  const ycMatch = text.match(/EXCEL\s+ORDER\s*#\s*0*(\d{3,6})/i);
  if (ycMatch) return ycMatch[1];

  // EXCEL METALS LLC ORDER NO.: 001772
  const wjMatch = text.match(/ORDER\s*(?:NO\.?)?\s*[#:]?\s*:?\s*0*(\d{3,6})/i);
  if (wjMatch) return wjMatch[1];

  return '';
}

/**
 * Extract invoice number from YC invoice
 * Looks for: "Invoice NO. QEP996/25"
 */
function extractInvoiceNumber(text: string): string {
  const match = text.match(/Invoice\s*NO\.?\s*:?\s*([A-Z0-9\/\-]+)/i);
  return match ? match[1] : '';
}

/**
 * Parse Yuen Chang invoice from PDF text
 * Extracts price data for matching with packing lists
 *
 * YC invoice can have two formats:
 * Format 1 (USD/MT): SIZE (GA) | PCS | QTY (LBS) | QTY (MT) | PRICE (USD/MT) | VALUE (USD)
 * Format 2 (USD/PCS): SIZE (GA) | PCS | QTY (LBS) | QTY (MT) | PRICE (USD/PCS) | VALUE (USD)
 *
 * The function auto-detects which format by checking if price * MT ≈ value (per MT)
 * or if price * PCS ≈ value (per piece)
 */
function parseYuenChangInvoice(text: string): ParsedInvoice | null {
  const poNumber = extractInvoicePoNumber(text);
  const invoiceNumber = extractInvoiceNumber(text);

  if (!poNumber) {
    return null;
  }

  const items: InvoiceLineItem[] = [];
  const MT_TO_LBS = 2204.62;

  // Detect pricing format from header
  const isPricePerMT = /PRICE\s*\(USD\/MT\)/i.test(text) || /PER\s+MT/i.test(text);
  const isPricePerPCS = /PRICE\s*\(USD\/PCS\)/i.test(text) || /USD\/PC/i.test(text);

  // Find all size patterns (both GA format and fraction format)
  // GA format: "26GA x 48" x 120"" or "3/16" x 48" x 120""
  const sizePatterns = [
    // GA format: 26GA x 48" x 120"
    /(\d{1,2})GA\s*x\s*(\d{2,3})[""']?\s*x\s*(\d{2,3})[""']?/gi,
    // Fraction format: 3/16" x 48" x 120"
    /(\d+\/\d+)[""']?\s*x\s*(\d{2,3})[""']?\s*x\s*(\d{2,3})[""']?/gi,
  ];

  for (const sizePattern of sizePatterns) {
    const sizeMatches = [...text.matchAll(sizePattern)];

    for (const sizeMatch of sizeMatches) {
      const thickness = sizeMatch[1];  // e.g., "26" (GA) or "3/16" (fraction)
      const width = sizeMatch[2];      // e.g., "48"
      const length = sizeMatch[3];     // e.g., "120"
      const matchIndex = sizeMatch.index!;

      // Look for numbers after this size (within 250 chars)
      const afterText = text.substring(matchIndex + sizeMatch[0].length, matchIndex + 250);
      const numbers = afterText.match(/[\d,]+\.?\d*/g) || [];
      const numericValues = numbers
        .map(n => parseFloat(n.replace(/,/g, '')))
        .filter(n => !isNaN(n) && n > 0);

      // Expected order: PCS, QTY(LBS), QTY(MT), PRICE, VALUE(USD)
      // We need at least 5 values
      if (numericValues.length >= 5) {
        const pcs = Math.round(numericValues[0]);
        const qtyLbs = numericValues[1];
        const qtyMT = numericValues[2];
        const price = numericValues[3];
        const value = numericValues[4];

        // Validate basic data
        if (pcs <= 0 || pcs >= 1000 || qtyLbs <= 100 || qtyMT <= 0 || qtyMT >= 100) {
          continue;
        }

        // Auto-detect pricing format by checking which formula produces the value
        const valueIfPerMT = qtyMT * price;
        const valueIfPerPCS = pcs * price;
        const ratioMT = value / valueIfPerMT;
        const ratioPCS = value / valueIfPerPCS;

        let pricePerLb: number;
        let detectedFormat: 'MT' | 'PCS' | null = null;

        // Check if header explicitly indicates format
        if (isPricePerMT && !isPricePerPCS) {
          detectedFormat = 'MT';
        } else if (isPricePerPCS && !isPricePerMT) {
          detectedFormat = 'PCS';
        } else {
          // Auto-detect: which ratio is closer to 1.0?
          if (Math.abs(ratioMT - 1.0) < Math.abs(ratioPCS - 1.0) && ratioMT > 0.8 && ratioMT < 1.2) {
            detectedFormat = 'MT';
          } else if (ratioPCS > 0.8 && ratioPCS < 1.2) {
            detectedFormat = 'PCS';
          }
        }

        if (!detectedFormat) {
          continue;
        }

        if (detectedFormat === 'MT') {
          // Price is per metric ton: pricePerLb = pricePerMT / 2204.62
          pricePerLb = Math.round((price / MT_TO_LBS) * 10000) / 10000;
        } else {
          // Price is per piece: pricePerLb = pricePerPiece / weightPerPiece
          const weightPerPiece = qtyLbs / pcs;
          pricePerLb = Math.round((price / weightPerPiece) * 10000) / 10000;
        }

        // Format size string based on input type
        const sizeStr = thickness.includes('/')
          ? `${thickness}" x ${width}" x ${length}"`
          : `${thickness}GA x ${width}" x ${length}"`;

        items.push({
          size: sizeStr,
          pcs,
          qtyLbs,
          pricePerPiece: value / pcs,
          pricePerLb,
        });
      }
    }

    // If we found items with this pattern, stop trying other patterns
    if (items.length > 0) break;
  }

  if (items.length === 0) {
    return null;
  }

  // Calculate total value
  const totalValue = items.reduce((sum, item) => sum + (item.pricePerPiece * item.pcs), 0);

  // Extract warehouse from invoice destination (e.g., "To: Houston, TX")
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);

  return {
    supplier: 'yuen-chang',
    poNumber,
    invoiceNumber,
    items,
    totalValue,
    warehouse: warehouseDetected ? warehouse : undefined,
  };
}

/**
 * Parse Yeou Yih Steel invoice from PDF text
 * Extracts price data for matching with packing lists
 */
function parseYeouYihInvoice(text: string): ParsedInvoice | null {
  // Extract PO numbers from section C: "EXCEL METALS LLC PURCHASE ORDER NUMBERS 001715,001857"
  const poMatch = text.match(/PURCHASE\s+ORDER\s+NUMBERS?\s*:?\s*([\d,\s]+)/i);
  let poNumbers: string[] = [];
  if (poMatch) {
    poNumbers = poMatch[1].split(/[,\s]+/).filter(p => /^\d{3,6}$/.test(p));
  }

  // If no PO found, try YYS pattern S####### ######
  if (poNumbers.length === 0) {
    const yysPos = extractYeouYihPos(text);
    poNumbers = yysPos;
  }

  const poNumber = poNumbers.length > 0 ? poNumbers[0].replace(/^0+/, '') : '';

  // Extract invoice number
  const invoiceMatch = text.match(/INVOICE\s*NO\.?\s*:?\s*([A-Z0-9+\-]+)/i);
  const invoiceNumber = invoiceMatch ? invoiceMatch[1] : '';

  if (!poNumber) {
    return null;
  }

  const items: InvoiceLineItem[] = [];

  // YYS invoice format:
  // Description with size | Quantity (MT) | Unit Price (USD/MT) | Amount
  // 304/304L 0.750" X 60" X 120" | 4.212MT | USD2,540 | USD10,698.48

  // Find size patterns with pricing
  const sizePattern = /(\d+\.\d+)[""']?\s*[xX]\s*(\d+)[""']?\s*[xX]\s*(\d+)[""']?/g;
  const sizeMatches = [...text.matchAll(sizePattern)];

  for (const sizeMatch of sizeMatches) {
    const thickness = sizeMatch[1];
    const width = sizeMatch[2];
    const length = sizeMatch[3];
    const matchIndex = sizeMatch.index!;

    // Look for MT quantity and USD price after this size (within 200 chars)
    const afterText = text.substring(matchIndex, matchIndex + 200);

    // Quantity pattern: 4.212MT or 4.212 MT
    const qtyMatch = afterText.match(/(\d+\.\d+)\s*MT/i);
    const qtyMT = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

    // Price pattern: USD2,540 or USD 2,540 or US$2,540
    const priceMatches = afterText.match(/USD?\$?\s*([\d,]+)/gi);

    if (qtyMT > 0 && priceMatches && priceMatches.length >= 1) {
      // First USD match is typically the unit price
      const unitPriceStr = priceMatches[0].replace(/USD?\$?\s*/i, '').replace(/,/g, '');
      const unitPricePerMT = parseFloat(unitPriceStr);

      if (unitPricePerMT > 0) {
        // Convert to price per lb
        // 1 MT = 2204.62 lbs
        const qtyLbs = qtyMT * 2204.62;
        const totalPrice = unitPricePerMT * qtyMT;
        const pricePerLb = Math.round((totalPrice / qtyLbs) * 10000) / 10000;

        // Estimate pieces (we don't have exact count in invoice, will match by size)
        const pcs = 1;

        items.push({
          size: `${thickness}" x ${width}" x ${length}"`,
          pcs,
          qtyLbs: Math.round(qtyLbs),
          pricePerPiece: totalPrice,
          pricePerLb,
        });
      }
    }
  }

  if (items.length === 0) {
    return null;
  }

  const totalValue = items.reduce((sum, item) => sum + item.pricePerPiece, 0);

  // Extract warehouse from invoice destination
  const { warehouse, detected: warehouseDetected } = extractWarehouse(text);

  return {
    supplier: 'yeou-yih',
    poNumber,
    invoiceNumber,
    items,
    totalValue,
    warehouse: warehouseDetected ? warehouse : undefined,
  };
}

/**
 * Parse invoice from PDF file
 * Returns parsed invoice data if it's an invoice, null if it's a packing list
 */
export async function parseInvoicePdf(file: File): Promise<ParsedInvoice | null> {
  // Extract text from all pages
  let pages: string[];
  try {
    pages = await extractPdfText(file);
  } catch {
    return null;
  }

  // Check if any page is an invoice
  for (const pageText of pages) {
    if (isInvoicePage(pageText)) {
      // Detect supplier
      const supplier = detectSupplier(pageText);

      if (supplier === 'yuen-chang') {
        return parseYuenChangInvoice(pageText);
      }

      if (supplier === 'yeou-yih') {
        return parseYeouYihInvoice(pageText);
      }

      // Could add Wuu Jing invoice parsing here if needed
      // (WJ invoices come as Excel tabs, not separate PDFs)
    }
  }

  return null;
}

/**
 * Parse invoice from PDF using OCR (for scanned invoices)
 */
export async function parseInvoicePdfWithOcr(
  file: File,
  onProgress?: (progress: OcrProgress) => void
): Promise<ParsedInvoice | null> {
  const ocrResults = await extractTextWithOcr(file, onProgress);
  const pages = ocrResults.map(r => r.text);

  for (const pageText of pages) {
    if (isInvoicePage(pageText)) {
      const supplier = detectSupplier(pageText);

      if (supplier === 'yuen-chang') {
        return parseYuenChangInvoice(pageText);
      }

      if (supplier === 'yeou-yih') {
        return parseYeouYihInvoice(pageText);
      }
    }
  }

  return null;
}

/**
 * Apply invoice prices to packing list items
 * Matches by size and sets unitCostOverride
 */
export function applyInvoicePrices(
  packingList: ParsedPackingList,
  invoice: ParsedInvoice
): ParsedPackingList {
  // Build a map of prices by normalized size
  const priceMap = new Map<string, number>();

  for (const item of invoice.items) {
    // Normalize size: "3/16" x 48" x 120"" -> "3/16-48-120"
    const normalized = normalizeSize(item.size);
    priceMap.set(normalized, item.pricePerLb);
  }

  // Apply prices to packing list items
  const updatedItems = packingList.items.map(item => {
    // Extract dimensions from inventoryId or rawSize
    const normalized = normalizeInventorySize(item.inventoryId, item.rawSize);
    const pricePerLb = priceMap.get(normalized);

    if (pricePerLb !== undefined && !item.unitCostOverride) {
      return { ...item, unitCostOverride: pricePerLb };
    }
    return item;
  });

  // Apply warehouse from invoice if packing list doesn't have one detected
  let warehouse = packingList.warehouse;
  let warehouseDetected = packingList.warehouseDetected;
  if (!warehouseDetected && invoice.warehouse) {
    warehouse = invoice.warehouse;
    warehouseDetected = true;
  }

  return { ...packingList, items: updatedItems, warehouse, warehouseDetected };
}

/**
 * Normalize invoice size for matching
 * "3/16" x 48" x 120"" -> "0.188-48-120"
 */
function normalizeSize(size: string): string {
  const match = size.match(/(\d+\/\d+|\d+\.?\d*)[""']?\s*x\s*(\d+)[""']?\s*x\s*(\d+)/i);
  if (!match) return size;

  let thickness: number;
  if (match[1].includes('/')) {
    const [num, denom] = match[1].split('/').map(Number);
    thickness = num / denom;
  } else {
    thickness = parseFloat(match[1]);
  }

  const width = parseInt(match[2], 10);
  const length = parseInt(match[3], 10);

  return `${thickness.toFixed(4)}-${width}-${length}`;
}

/**
 * Normalize inventory ID or rawSize for matching
 * "0.1875-48__-120__-304/304L-#1___" -> "0.1875-48-120"
 */
function normalizeInventorySize(inventoryId: string, rawSize: string): string {
  // Try inventory ID first: "0.1875-48__-120__-304/304L-#1___"
  const invMatch = inventoryId.match(/^([\d.]+)-(\d+)__-(\d+)__-/);
  if (invMatch) {
    return `${parseFloat(invMatch[1]).toFixed(4)}-${invMatch[2]}-${invMatch[3]}`;
  }

  // Try rawSize: "3/16"*48"*120"" or similar
  const sizeMatch = rawSize.match(/(\d+\/\d+|\d+\.?\d*)[""']?\s*[*x×]\s*(\d+)[""']?\s*[*x×]\s*(\d+)/i);
  if (sizeMatch) {
    let thickness: number;
    if (sizeMatch[1].includes('/')) {
      const [num, denom] = sizeMatch[1].split('/').map(Number);
      thickness = num / denom;
    } else {
      thickness = parseFloat(sizeMatch[1]);
    }
    return `${thickness.toFixed(4)}-${sizeMatch[2]}-${sizeMatch[3]}`;
  }

  return '';
}
