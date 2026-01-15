import { ParsedPackingList } from '../types';
import { parsePdf, parsePdfWithOcr, needsOcr, OcrProgress } from './pdfParser';
import { parseExcel } from './excelParser';
import { extractPoNumber } from './conversion';

export interface ParseOptions {
  poNumber?: string;
  useOcr?: boolean;
  onOcrProgress?: (progress: OcrProgress) => void;
}

export interface ParseResult {
  result?: ParsedPackingList;
  error?: string;
  needsOcr?: boolean;
  ocrConfidence?: number;
  ocrWarning?: string;
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

// Re-export types
export type { OcrProgress };
