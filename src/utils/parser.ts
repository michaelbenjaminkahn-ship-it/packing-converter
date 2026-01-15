import { ParsedPackingList, ParsedInvoice } from '../types';
import { parsePdf, parsePdfWithOcr, needsOcr, OcrProgress, parseInvoicePdf, parseInvoicePdfWithOcr, applyInvoicePrices, extractPdfText, isInvoicePage } from './pdfParser';
import { parseExcel } from './excelParser';
import { extractPoNumber } from './conversion';

export interface ParseOptions {
  poNumber?: string;
  useOcr?: boolean;
  onOcrProgress?: (progress: OcrProgress) => void;
}

export interface ParseResult {
  result?: ParsedPackingList;
  invoice?: ParsedInvoice;
  error?: string;
  needsOcr?: boolean;
  ocrConfidence?: number;
  ocrWarning?: string;
  isInvoice?: boolean;
}

/**
 * Parse a file (PDF or Excel) and extract packing list data
 */
export async function parseFile(
  file: File,
  options: ParseOptions = {}
): Promise<ParseResult> {
  const { poNumber, useOcr, onOcrProgress } = options;
  const extension = file.name.toLowerCase().split('.').pop();

  // Try to extract PO number from filename if not provided
  const po = poNumber || extractPoNumber(file.name) || 'UNKNOWN';

  try {
    if (extension === 'pdf') {
      // First, check if this PDF is an invoice (not a packing list)
      let pages: string[];
      try {
        pages = await extractPdfText(file);
      } catch {
        pages = [];
      }

      const hasText = pages.some(p => p.trim().length > 50);
      const looksLikeInvoice = pages.some(p => isInvoicePage(p));

      if (looksLikeInvoice) {
        // This is an invoice - parse it as such
        if (useOcr || !hasText) {
          const invoice = await parseInvoicePdfWithOcr(file, onOcrProgress);
          if (invoice) {
            return { invoice, isInvoice: true };
          }
        } else {
          const invoice = await parseInvoicePdf(file);
          if (invoice) {
            return { invoice, isInvoice: true };
          }
        }
        // If invoice parsing failed, fall through to try as packing list
      }

      if (useOcr) {
        // Use OCR directly
        const result = await parsePdfWithOcr(file, po, onOcrProgress);
        return {
          result,
          ocrConfidence: result.ocrConfidence,
          ocrWarning: result.ocrWarning,
        };
      }

      // Try normal PDF parsing first
      try {
        const result = await parsePdf(file, po);
        return { result };
      } catch (err) {
        if (err instanceof Error && needsOcr(err)) {
          // Signal that OCR is needed
          return { needsOcr: true };
        }
        throw err;
      }
    } else if (extension === 'xlsx' || extension === 'xls') {
      const result = await parseExcel(file, po);
      return { result };
    } else {
      throw new Error(`Unsupported file type: ${extension}`);
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Parse multiple files
 */
export async function parseFiles(
  files: File[],
  poNumber?: string
): Promise<{ file: File; result?: ParsedPackingList; error?: string }[]> {
  const results = await Promise.all(
    files.map(async (file) => {
      const parseResult = await parseFile(file, { poNumber });
      return {
        file,
        result: parseResult.result,
        error: parseResult.error,
      };
    })
  );

  return results;
}

// Re-export types and functions
export type { OcrProgress };
export { applyInvoicePrices };
