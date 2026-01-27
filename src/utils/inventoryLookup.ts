import * as XLSX from 'xlsx';

// Store for loaded inventory IDs
let inventoryIds: Set<string> = new Set();

/**
 * Load inventory IDs from an Excel file
 * Looks for column named "Inventory ID" or first column
 */
export async function loadInventoryFromExcel(file: File): Promise<number> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  const ids: string[] = [];

  for (const row of data) {
    // Try common column names
    const id = row['Inventory ID'] || row['InventoryID'] || row['Item'] || row['SKU'] || Object.values(row)[0];
    if (id !== undefined && id !== null && String(id).trim()) {
      ids.push(String(id).trim());
    }
  }

  // Add to the set
  ids.forEach(id => inventoryIds.add(id));

  // Also save to localStorage for persistence
  saveToLocalStorage();

  return ids.length;
}

/**
 * Check if an inventory ID is valid (exists in the loaded list)
 */
export function isValidInventoryId(id: string): boolean {
  if (inventoryIds.size === 0) {
    // No inventory loaded, assume all are valid
    return true;
  }
  return inventoryIds.has(id);
}

/**
 * Find the closest matching inventory ID
 */
export function findClosestMatch(id: string): string | null {
  if (inventoryIds.size === 0) return null;

  // Parse the input ID
  const match = id.match(/^([\d.]+)-(\d+)__-(\d+)__-304\/304L-(.+)$/);
  if (!match) return null;

  const [, thickness, width, length, finish] = match;

  // Find best match by trying variations
  const variations = [
    id, // Exact match
    `${thickness}-${width}__-${length}__-304/304L-${finish}`,
  ];

  for (const variant of variations) {
    if (inventoryIds.has(variant)) {
      return variant;
    }
  }

  // Try to find one with same thickness and finish
  for (const invId of inventoryIds) {
    if (invId.startsWith(thickness) && invId.endsWith(finish)) {
      return invId;
    }
  }

  return null;
}

/**
 * Parse an inventory ID into its components
 * Handles multiple formats:
 *   - "0.090-48  -120  -304/304L-2B" (user's actual format with spaces)
 *   - "0.4375-60__-360__-304/304L-#1____" (legacy format with underscores)
 *   - ".4375-60  -360  -304/304L-#1" (leading dot without zero)
 */
function parseInventoryId(invId: string): {
  thickness: number;
  width: number;
  length: number;
  material: string;
  finish: string;
} | null {
  // Normalize: trim and collapse multiple spaces
  const normalized = invId.trim().replace(/\s+/g, ' ');

  // Try multiple regex patterns to handle different formats
  // Pattern 1: User's format with spaces: "0.090-48  -120  -304/304L-2B"
  // Pattern 2: Legacy format with underscores: "0.4375-60__-360__-304/304L-#1____"
  const patterns = [
    // User's format: thickness-width -length -material-finish (with optional spaces)
    /^(\.?\d*\.?\d+)-(\d+)\s*-(\d+)\s*-(30[46]\/30[46]L|316\/316L)-(.+)$/,
    // Legacy format with double underscores
    /^(\.?\d*\.?\d+)-(\d+)__-(\d+)__-(30[46]\/30[46]L|316\/316L)-(.+)$/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const [, thicknessStr, widthStr, lengthStr, material, finish] = match;
      // Handle thickness that starts with "." (e.g., ".4375" -> "0.4375")
      const thicknessNorm = thicknessStr.startsWith('.') ? '0' + thicknessStr : thicknessStr;
      return {
        thickness: parseFloat(thicknessNorm),
        width: parseInt(widthStr),
        length: parseInt(lengthStr),
        material,
        finish: finish.replace(/_+$/, '').trim(), // Remove trailing underscores
      };
    }
  }

  return null;
}

/**
 * Find inventory ID by size dimensions
 * Searches uploaded inventory list for an ID matching the given dimensions
 * Handles different thickness precision (e.g., finds 0.4375 when searching for 0.438)
 *
 * @param thickness - Thickness in decimal inches
 * @param width - Width in inches
 * @param length - Length in inches
 * @param finish - Optional finish code to match
 * @returns Matching inventory ID from uploaded list, or null if not found
 */
export function findInventoryIdBySize(
  thickness: number,
  width: number,
  length: number,
  finish?: string
): string | null {
  if (inventoryIds.size === 0) return null;

  // Normalize the finish for comparison (remove trailing underscores)
  const finishNorm = finish?.replace(/_+$/, '').trim();

  // Search uploaded inventory IDs for a match with this size
  // Allow for different thickness precisions (3 or 4 decimal places)
  for (const invId of inventoryIds) {
    // Parse the inventory ID using flexible parser
    const parsed = parseInventoryId(invId);
    if (!parsed) continue;

    // Check if dimensions match
    if (parsed.width !== width) continue;
    if (parsed.length !== length) continue;

    // Check thickness - allow for small precision differences
    // e.g., 0.4375 vs 0.438 (difference < 0.001)
    if (Math.abs(parsed.thickness - thickness) < 0.001) {
      // If finish specified, check it matches (case-insensitive, ignore trailing underscores)
      if (finishNorm && parsed.finish.toLowerCase() !== finishNorm.toLowerCase()) {
        // Also try starts-with for partial matches like "#1" matching "#1____"
        if (!parsed.finish.toLowerCase().startsWith(finishNorm.toLowerCase())) {
          continue;
        }
      }
      // Return the original uploaded inventory ID as-is
      return invId;
    }
  }

  return null;
}

/**
 * Get count of loaded inventory IDs
 */
export function getInventoryCount(): number {
  return inventoryIds.size;
}

/**
 * Clear all loaded inventory IDs
 */
export function clearInventory(): void {
  inventoryIds.clear();
  localStorage.removeItem('inventoryIds');
}

/**
 * Get all loaded inventory IDs
 */
export function getAllInventoryIds(): string[] {
  return Array.from(inventoryIds);
}

/**
 * Save inventory to localStorage
 */
function saveToLocalStorage(): void {
  try {
    localStorage.setItem('inventoryIds', JSON.stringify(Array.from(inventoryIds)));
  } catch (e) {
    console.warn('Failed to save inventory to localStorage:', e);
  }
}

/**
 * Load inventory from localStorage on startup
 */
export function loadFromLocalStorage(): void {
  try {
    const stored = localStorage.getItem('inventoryIds');
    if (stored) {
      const ids = JSON.parse(stored) as string[];
      ids.forEach(id => inventoryIds.add(id));
    }
  } catch (e) {
    console.warn('Failed to load inventory from localStorage:', e);
  }
}

// Auto-load from localStorage when module loads
loadFromLocalStorage();
