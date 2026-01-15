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
