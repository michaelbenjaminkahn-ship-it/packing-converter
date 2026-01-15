import Tesseract from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist';

export interface OcrResult {
  text: string;
  confidence: number;
  pageNumber: number;
}

export interface OcrProgress {
  status: string;
  progress: number;
  page?: number;
  totalPages?: number;
}

/**
 * Minimum confidence threshold for OCR results
 * Below this, we warn the user about accuracy
 */
const MIN_CONFIDENCE_THRESHOLD = 70;

/**
 * Convert a PDF page to an image data URL
 */
async function pdfPageToImage(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number = 2.0 // Higher scale = better OCR accuracy
): Promise<string> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  // Create canvas
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not get canvas context');
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  // Render PDF page to canvas
  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  // Convert to image data URL
  return canvas.toDataURL('image/png');
}

/**
 * Run OCR on a single image
 */
async function ocrImage(
  imageData: string,
  onProgress?: (progress: number) => void
): Promise<{ text: string; confidence: number }> {
  const result = await Tesseract.recognize(imageData, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(m.progress * 100);
      }
    },
  });

  return {
    text: result.data.text,
    confidence: result.data.confidence,
  };
}

/**
 * Extract text from a PDF using OCR
 * This is slower but works on scanned/image-based PDFs
 */
export async function extractTextWithOcr(
  file: File,
  onProgress?: (progress: OcrProgress) => void
): Promise<OcrResult[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const results: OcrResult[] = [];

  onProgress?.({
    status: 'Starting OCR...',
    progress: 0,
    totalPages: numPages,
  });

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    onProgress?.({
      status: `Rendering page ${pageNum}/${numPages}...`,
      progress: ((pageNum - 1) / numPages) * 100,
      page: pageNum,
      totalPages: numPages,
    });

    // Convert PDF page to image
    const imageData = await pdfPageToImage(pdf, pageNum);

    onProgress?.({
      status: `Running OCR on page ${pageNum}/${numPages}...`,
      progress: ((pageNum - 0.5) / numPages) * 100,
      page: pageNum,
      totalPages: numPages,
    });

    // Run OCR
    const ocrResult = await ocrImage(imageData, (progress) => {
      onProgress?.({
        status: `OCR page ${pageNum}/${numPages}: ${Math.round(progress)}%`,
        progress: ((pageNum - 1 + progress / 100) / numPages) * 100,
        page: pageNum,
        totalPages: numPages,
      });
    });

    results.push({
      text: ocrResult.text,
      confidence: ocrResult.confidence,
      pageNumber: pageNum,
    });
  }

  onProgress?.({
    status: 'OCR complete',
    progress: 100,
    totalPages: numPages,
  });

  return results;
}

/**
 * Check if OCR results have acceptable accuracy
 */
export function checkOcrAccuracy(results: OcrResult[]): {
  isAcceptable: boolean;
  averageConfidence: number;
  lowConfidencePages: number[];
} {
  if (results.length === 0) {
    return {
      isAcceptable: false,
      averageConfidence: 0,
      lowConfidencePages: [],
    };
  }

  const totalConfidence = results.reduce((sum, r) => sum + r.confidence, 0);
  const averageConfidence = totalConfidence / results.length;
  const lowConfidencePages = results
    .filter((r) => r.confidence < MIN_CONFIDENCE_THRESHOLD)
    .map((r) => r.pageNumber);

  return {
    isAcceptable: averageConfidence >= MIN_CONFIDENCE_THRESHOLD,
    averageConfidence,
    lowConfidencePages,
  };
}

/**
 * Get best page from OCR results (highest confidence with content)
 */
export function getBestOcrPage(results: OcrResult[]): OcrResult | null {
  // Filter pages that have actual content
  const pagesWithContent = results.filter((r) => r.text.trim().length > 100);

  if (pagesWithContent.length === 0) {
    return results[0] || null;
  }

  // Sort by confidence descending
  return pagesWithContent.sort((a, b) => b.confidence - a.confidence)[0];
}
