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
 * Convert a PDF page to an image data URL with preprocessing for better OCR
 */
async function pdfPageToImage(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number = 3.0 // Higher scale = better OCR accuracy (increased from 2.0)
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

  // Set white background for better OCR contrast
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Render PDF page to canvas
  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  // Apply image preprocessing to improve OCR quality
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Increase contrast and convert to grayscale with thresholding
  for (let i = 0; i < data.length; i += 4) {
    // Convert to grayscale
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    // Apply contrast enhancement
    const contrast = 1.3; // Increase contrast
    const factor = (259 * (contrast * 100 + 255)) / (255 * (259 - contrast * 100));
    let enhanced = factor * (gray - 128) + 128;

    // Clamp values
    enhanced = Math.max(0, Math.min(255, enhanced));

    // Apply mild thresholding to sharpen text
    if (enhanced < 180) {
      enhanced = Math.max(0, enhanced - 30); // Darken dark pixels
    } else {
      enhanced = Math.min(255, enhanced + 30); // Lighten light pixels
    }

    data[i] = enhanced;     // R
    data[i + 1] = enhanced; // G
    data[i + 2] = enhanced; // B
    // Alpha stays the same
  }

  context.putImageData(imageData, 0, 0);

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
