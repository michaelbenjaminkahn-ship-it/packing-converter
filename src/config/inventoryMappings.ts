/**
 * Manual Inventory ID Mappings
 *
 * Use this file to specify exact inventory ID formats for specific products.
 * When a product matches a mapping, the exact inventory ID will be used instead
 * of the auto-generated one.
 *
 * Format:
 *   key: "thickness-width-length" (e.g., "0.4375-60-360")
 *   value: { inventoryId: "exact ID to use", lbsPerSqFt?: optional weight override }
 *
 * The thickness should be the exact decimal value (e.g., 0.4375 for 7/16")
 */

export interface InventoryMapping {
  inventoryId: string;
  lbsPerSqFt?: number; // Optional weight override in Lbs/Sq Ft
  notes?: string;      // Optional notes about this mapping
}

/**
 * Manual inventory ID mappings
 * Key format: "thickness-width-length" using decimal thickness
 *
 * Examples:
 *   "0.4375-60-360": 7/16" x 60" x 360"
 *   "0.1875-48-120": 3/16" x 48" x 120"
 */
export const INVENTORY_MAPPINGS: Record<string, InventoryMapping> = {
  // Example mappings - add your custom mappings here
  // "0.4375-60-360": {
  //   inventoryId: "0.4375-60__-360__-304/304L-#1____",
  //   lbsPerSqFt: 19.08,
  //   notes: "7/16\" hot rolled plate"
  // },
};

/**
 * Thickness display overrides
 * Maps calculated decimal thickness to exact display format
 *
 * Example: If 7/16" calculates to 0.4375 but you want it displayed as "0.4375"
 * (not rounded to 0.438), add it here.
 */
export const THICKNESS_DISPLAY_OVERRIDES: Record<string, string> = {
  // Common fractions with their exact decimal representations
  '0.1875': '0.1875',  // 3/16"
  '0.3125': '0.3125',  // 5/16"
  '0.4375': '0.4375',  // 7/16"
  '0.5625': '0.5625',  // 9/16"
  '0.6875': '0.6875',  // 11/16"
  '0.8125': '0.8125',  // 13/16"
  '0.9375': '0.9375',  // 15/16"
};

/**
 * Get mapped inventory ID for a given size
 * @param thickness - Decimal thickness (e.g., 0.4375)
 * @param width - Width in inches
 * @param length - Length in inches
 * @returns The mapped inventory ID, or null if no mapping exists
 */
export function getMappedInventoryId(
  thickness: number,
  width: number,
  length: number
): InventoryMapping | null {
  const key = `${thickness.toFixed(4)}-${width}-${length}`;
  return INVENTORY_MAPPINGS[key] || null;
}

/**
 * Get thickness display format
 * @param thickness - Calculated decimal thickness
 * @returns Exact display format, or null to use default formatting
 */
export function getThicknessDisplay(thickness: number): string | null {
  // Round to 4 decimal places for lookup
  const key = thickness.toFixed(4);
  return THICKNESS_DISPLAY_OVERRIDES[key] || null;
}
