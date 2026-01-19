import { Supplier, PageScore } from '../types';
import {
  SUPPLIER_KEYWORDS,
  PACKING_LIST_INDICATORS,
  PACKING_LIST_TITLE_KEYWORDS,
  INVOICE_KEYWORDS,
  MILL_CERT_KEYWORDS,
} from './constants';

/**
 * Score a page/sheet to determine if it's a packing list
 * Returns a score - higher is more likely to be a packing list
 */
export function scorePageAsPackingList(text: string): number {
  const lowerText = text.toLowerCase();
  let score = 0;

  // Check for packing list title (+30 points)
  for (const keyword of PACKING_LIST_TITLE_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      score += 30;
      break;
    }
  }

  // Check for packing list indicators (+10 points each)
  for (const indicator of PACKING_LIST_INDICATORS) {
    if (lowerText.includes(indicator.toLowerCase())) {
      score += 10;
    }
  }

  // Check for invoice keywords (-15 points each)
  for (const keyword of INVOICE_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      score -= 15;
    }
  }

  // Check for mill cert keywords (-15 points each)
  for (const keyword of MILL_CERT_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      score -= 15;
    }
  }

  // Count data rows (lines with numbers) - bonus if 3-100 rows
  const dataRowPattern = /^\s*\d+\s+.*\d+/gm;
  const dataRows = (text.match(dataRowPattern) || []).length;
  if (dataRows >= 3 && dataRows <= 100) {
    score += 15;
  }

  // Wuu Jing specific patterns (+20 points each)
  // Bundle number pattern: 001812-01, 001837-02, etc.
  const bundlePattern = /\d{6}-\d{2}/g;
  const bundleMatches = text.match(bundlePattern);
  if (bundleMatches && bundleMatches.length >= 3) {
    score += 30; // Multiple bundle numbers strongly indicates packing list
  } else if (bundleMatches && bundleMatches.length >= 1) {
    score += 15;
  }

  // Size format pattern: 4.76*1525MM*3660MM or similar
  const sizePattern = /\d+\.?\d*\s*\*\s*\d+\s*MM\s*\*\s*\d+\s*MM/gi;
  const sizeMatches = text.match(sizePattern);
  if (sizeMatches && sizeMatches.length >= 3) {
    score += 30; // Multiple size patterns strongly indicates packing list
  } else if (sizeMatches && sizeMatches.length >= 1) {
    score += 15;
  }

  // Imperial dimensions in parentheses: (3/16"*60"*144")
  const imperialPattern = /\(\d+\/\d+[""']?\s*\*\s*\d+[""']?\s*\*\s*\d+[""']?\)/g;
  const imperialMatches = text.match(imperialPattern);
  if (imperialMatches && imperialMatches.length >= 1) {
    score += 20;
  }

  // Weight patterns (X.XXX format typical of MT weights)
  const weightPattern = /\b\d+\.\d{3}\b/g;
  const weightMatches = text.match(weightPattern);
  if (weightMatches && weightMatches.length >= 5) {
    score += 15;
  }

  // Yeou Yih specific patterns
  // Decimal inch format: 0.750" X 60" X 120"
  const yysDecimalPattern = /\d+\.\d+[""']?\s*[xX]\s*\d+[""']?\s*[xX]\s*\d+/g;
  const yysMatches = text.match(yysDecimalPattern);
  if (yysMatches && yysMatches.length >= 3) {
    score += 30;
  } else if (yysMatches && yysMatches.length >= 1) {
    score += 15;
  }

  // YYS sales order + PO pattern: S2509021 001715
  const yysSalesOrderPattern = /S\d{7}\s+\d{6}/g;
  const yysOrderMatches = text.match(yysSalesOrderPattern);
  if (yysOrderMatches && yysOrderMatches.length >= 1) {
    score += 20;
  }

  return score;
}

/**
 * Detect supplier from text content
 */
export function detectSupplier(text: string): Supplier {
  const lowerText = text.toLowerCase();

  for (const [supplier, keywords] of Object.entries(SUPPLIER_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        return supplier as Supplier;
      }
    }
  }

  // Additional heuristics
  // Wuu Jing uses metric (MM) and "BUNDLE NO."
  if (lowerText.includes('bundle no') || lowerText.includes('mm*')) {
    return 'wuu-jing';
  }

  // Yuen Chang uses gauge (GA) and "ITEM"
  // Check for GA followed by any separator (*, (, x, space)
  if (lowerText.includes('ga*') || lowerText.includes('ga(') ||
      lowerText.includes('ga x') || /\d+ga\s+x?\s*\d+/.test(lowerText)) {
    return 'yuen-chang';
  }

  // Yeou Yih uses decimal inch format (0.750" X 60" X 120") and "HOT ROLLED STAINLESS STEEL PLATE"
  // Also look for their sales order pattern: S#######
  if (lowerText.includes('hot rolled stainless steel plate') ||
      /\d+\.\d+"\s*x\s*\d+"\s*x\s*\d+/i.test(text) ||
      /s\d{7}\s+\d{6}/.test(lowerText)) {
    return 'yeou-yih';
  }

  return 'unknown';
}

/**
 * Score multiple pages and return sorted results
 */
export function scorePages(pages: string[]): PageScore[] {
  return pages
    .map((text, index) => ({
      pageNumber: index + 1,
      score: scorePageAsPackingList(text),
      isPackingList: scorePageAsPackingList(text) >= 30,
      text,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Find the best packing list page from multiple pages
 */
export function findPackingListPage(pages: string[]): PageScore | null {
  const scored = scorePages(pages);
  const best = scored[0];

  // If only one page, use it regardless of score
  if (pages.length === 1 && best) {
    return best;
  }

  // If score is decent (30+), use it
  if (best && best.score >= 30) {
    return best;
  }

  // If best score is still reasonable (10+), try it anyway
  if (best && best.score >= 10) {
    return best;
  }

  // Last resort: if there are pages, return the best one
  if (best) {
    return best;
  }

  return null;
}

/**
 * Check if text looks like it contains tabular data
 */
export function hasTabularData(text: string): boolean {
  // Look for patterns like:
  // - Multiple columns separated by whitespace
  // - Repeated numeric patterns
  // - Header-like rows
  const lines = text.split('\n').filter(line => line.trim());

  // Check if multiple lines have similar structure (numbers + text)
  let numericLineCount = 0;
  for (const line of lines) {
    if (/\d+.*\d+.*\d+/.test(line)) {
      numericLineCount++;
    }
  }

  return numericLineCount >= 3;
}
