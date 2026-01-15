import { ParsedPackingList } from '../types';
import { parsePdf } from './pdfParser';
import { parseExcel } from './excelParser';
import { extractPoNumber } from './conversion';

/**
 * Parse a file (PDF or Excel) and extract packing list data
 */
export async function parseFile(file: File, poNumber?: string): Promise<ParsedPackingList> {
  const extension = file.name.toLowerCase().split('.').pop();

  // Try to extract PO number from filename if not provided
  const po = poNumber || extractPoNumber(file.name) || 'UNKNOWN';

  if (extension === 'pdf') {
    return parsePdf(file, po);
  } else if (extension === 'xlsx' || extension === 'xls') {
    return parseExcel(file, po);
  } else {
    throw new Error(`Unsupported file type: ${extension}`);
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
      try {
        const result = await parseFile(file, poNumber);
        return { file, result };
      } catch (error) {
        return {
          file,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    })
  );

  return results;
}
