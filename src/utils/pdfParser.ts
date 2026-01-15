import * as pdfjsLib from 'pdfjs-dist';
import { PackingListItem, ParsedPackingList, Supplier } from '../types';
import { detectSupplier, findPackingListPage } from './detection';
import { parseSize, buildInventoryId, buildLotSerialNbr, mtToLbs, extractWarehouse, extractPoFromBundles, extractPoNumber } from './conversion';
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
 * Primary strategy: Use bundle numbers as anchors (more reliably detected)
 * Looks for: bundle numbers (001812-XX), imperial dimensions, and weights (X.XXX MT)
 */
function parseWuuJingOcr(text: string, poNumber: string): PackingListItem[] {
  // Extract finish and warehouse from header
  const finish = extractWuuJingFinish(text);
  const warehouse = extractWarehouse(text);

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

  // Find bundle number pattern: 001812-01, 001812-02, etc.
  // Bundle numbers are the most reliable anchor in OCR text
  const bundlePattern = /(\d{6})-(\d{2})/g;
  const bundleMatches = [...cleanText.matchAll(bundlePattern)];

  // If we have bundle numbers, use bundle-anchored parsing (primary strategy for OCR)
  if (bundleMatches.length > 0) {
    return parseWuuJingByBundles(cleanText, poNumber, finish, warehouse, bundleMatches);
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
 * Bundle numbers (001812-01) are more reliably detected by OCR than full size patterns
 */
function parseWuuJingByBundles(
  text: string,
  _poNumber: string,
  finish: string,
  warehouse: string,
  bundleMatches: RegExpMatchArray[]
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
    const bundleMatch = bundleMatches[i];
    const bundleNo = `${bundleMatch[1]}-${bundleMatch[2]}`;
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

  // Auto-detect PO if not provided or is UNKNOWN
  let finalPoNumber = poNumber;
  if (!poNumber || poNumber === 'UNKNOWN') {
    // Try to extract from bundle numbers (Wuu Jing)
    const bundlePo = extractPoFromBundles(packingListPage.text);
    if (bundlePo) {
      finalPoNumber = bundlePo;
    } else {
      // Try to extract from text (explicit PO patterns)
      const textPo = extractPoNumber(packingListPage.text);
      finalPoNumber = textPo || '';
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
    try {
      const pageItems = parsePackingListFromText(pageText, pageSupplier, poNumber);
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
    const items = parsePackingListFromText(packingListPage.text, supplier, poNumber);

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
  const warehouse = items[0]?.warehouse || extractWarehouse(packingListText);

  // Auto-detect PO if not provided or is UNKNOWN
  let finalPoNumber = poNumber;
  if (!poNumber || poNumber === 'UNKNOWN') {
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
