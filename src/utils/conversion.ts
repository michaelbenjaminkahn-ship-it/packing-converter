import { MT_TO_LBS } from './constants';

/**
 * Convert metric tons to pounds
 */
export function mtToLbs(metricTons: number): number {
  return Math.round(metricTons * MT_TO_LBS * 100) / 100;
}

/**
 * Convert pounds to metric tons
 */
export function lbsToMt(pounds: number): number {
  return Math.round((pounds / MT_TO_LBS) * 1000000) / 1000000;
}

/**
 * Parse a size specification string into an Inventory ID
 * Example: "3/8 x 4" -> "FB-0375X4"
 */
export function sizeToInventoryId(sizeSpec: string, productType = 'FB'): string {
  const match = sizeSpec.match(/(\d+\/\d+|\d+\.?\d*)\s*[xX×]\s*(\d+\.?\d*)/);

  if (!match) {
    return sizeSpec;
  }

  const [, thickness, width] = match;

  // Convert fraction to decimal if needed
  const thicknessDecimal = fractionToDecimal(thickness);

  // Format thickness as 4-digit decimal (e.g., 0.375 -> "0375")
  const thicknessFormatted = thicknessDecimal
    .toFixed(4)
    .replace('0.', '')
    .replace('.', '');

  // Format width
  const widthFormatted = parseFloat(width).toString();

  return `${productType}-${thicknessFormatted}X${widthFormatted}`;
}

/**
 * Convert a fraction string to decimal
 * Example: "3/8" -> 0.375
 */
export function fractionToDecimal(fraction: string): number {
  if (fraction.includes('/')) {
    const [numerator, denominator] = fraction.split('/').map(Number);
    return numerator / denominator;
  }
  return parseFloat(fraction);
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
