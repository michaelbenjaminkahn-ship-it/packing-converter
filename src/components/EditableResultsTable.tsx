import { useState } from 'react';
import { ParsedPackingList, PackingListItem } from '../types';
import { getLbsPerSqFt, WAREHOUSES } from '../utils/constants';

// Fallback steel density: 0.2833 lbs per cubic inch (for 304 stainless)
// Used only when thickness is not in lookup table
const STEEL_DENSITY_LBS_PER_CUBIC_INCH = 0.2833;

/**
 * Detect finish type from inventory ID
 * Returns: '#1', '#4', '2B', '#8', 'BA', or null if not detected
 */
function getFinishFromInventoryId(inventoryId: string): string | null {
  // Match finish patterns like #1, #4, #8, 2B, BA
  const match = inventoryId.match(/#1|#4|#8|2B|BA/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Check if finish is #1 (hot rolled)
 */
function isHotRolledFinish(inventoryId: string): boolean {
  const finish = getFinishFromInventoryId(inventoryId);
  return finish === '#1';
}

/**
 * Get skid weight based on length for #1 finish items
 * 96" or 120" → 40 lbs
 * > 120" → 55 lbs
 */
function getSkidWeight(lengthInches: number): number {
  if (lengthInches <= 120) {
    return 40;
  }
  return 55;
}

/**
 * Calculate theoretical weights from dimensions using Yoshi's lookup table
 * Formula: Lbs/Pc = (Width × Length / 144) × Lbs/Sq Ft
 * Returns both steel weight (for Order Qty & Container) and total weight with skid (for Gross)
 */
function calculateTheoreticalWeights(item: PackingListItem): { steelWeight: number; totalWeight: number } {
  // Parse dimensions from inventory ID: "0.188-60__-144__-304/304L-#1____"
  const match = item.inventoryId.match(/^([\d.]+)-(\d+)__-(\d+)__-/);
  if (!match) {
    // Fallback to actual weight if can't parse
    return { steelWeight: item.grossWeightLbs, totalWeight: item.grossWeightLbs };
  }

  const thickness = parseFloat(match[1]);
  const width = parseFloat(match[2]);
  const length = parseFloat(match[3]);

  // Try to use lookup table first
  const lbsPerSqFt = getLbsPerSqFt(thickness);

  let steelWeight: number;
  if (lbsPerSqFt !== null) {
    // Use lookup table: Lbs/Pc = (Width × Length / 144) × Lbs/Sq Ft × pieceCount
    const sqFt = (width * length) / 144;
    steelWeight = sqFt * lbsPerSqFt * item.pieceCount;
  } else {
    // Fallback to density calculation
    const volumePerPiece = thickness * width * length;
    const weightPerPiece = volumePerPiece * STEEL_DENSITY_LBS_PER_CUBIC_INCH;
    steelWeight = weightPerPiece * item.pieceCount;
  }

  // Add skid weight for #1 finish items (only to total, not to pure steel weight)
  let totalWeight = steelWeight;
  if (isHotRolledFinish(item.inventoryId)) {
    totalWeight += getSkidWeight(length);
  }

  // Round steelWeight to 2 decimals for Order Qty precision, totalWeight to whole number for Gross
  return { steelWeight: Math.round(steelWeight * 100) / 100, totalWeight: Math.round(totalWeight) };
}

// Common Wuu Jing sizes for dropdown
const COMMON_SIZES = [
  { label: '3/16" x 60" x 144"', value: '0.188-60__-144__-304/304L-#1___' },
  { label: '3/16" x 48" x 120"', value: '0.188-48__-120__-304/304L-#1___' },
  { label: '1/4" x 48" x 120"', value: '0.250-48__-120__-304/304L-#1___' },
  { label: '1/4" x 60" x 120"', value: '0.250-60__-120__-304/304L-#1___' },
  { label: '1/4" x 60" x 144"', value: '0.250-60__-144__-304/304L-#1___' },
  { label: '5/16" x 48" x 120"', value: '0.313-48__-120__-304/304L-#1___' },
  { label: '5/16" x 60" x 120"', value: '0.313-60__-120__-304/304L-#1___' },
  { label: '3/8" x 48" x 96"', value: '0.375-48__-96__-304/304L-#1___' },
  { label: '3/8" x 48" x 120"', value: '0.375-48__-120__-304/304L-#1___' },
  { label: '3/8" x 60" x 120"', value: '0.375-60__-120__-304/304L-#1___' },
  { label: '1/2" x 48" x 120"', value: '0.500-48__-120__-304/304L-#1___' },
  { label: '1/2" x 60" x 120"', value: '0.500-60__-120__-304/304L-#1___' },
];

type WeightType = 'actual' | 'theoretical';

interface EditableResultsTableProps {
  result: ParsedPackingList;
  warehouse?: string;
  weightType?: WeightType;
  onWeightTypeChange?: (weightType: WeightType) => void;
  onUpdate: (updatedResult: ParsedPackingList) => void;
  onExport?: () => void;
}

export function EditableResultsTable({
  result,
  warehouse = 'LA',
  weightType = 'actual',
  onWeightTypeChange,
  onUpdate,
  onExport
}: EditableResultsTableProps) {
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  const supplierNames = {
    'wuu-jing': 'Wuu Jing',
    'yuen-chang': 'Yuen Chang',
    'yeou-yih': 'Yeou Yih Steel',
    unknown: 'Unknown Supplier',
  };

  const startEdit = (rowIndex: number, field: string, currentValue: string | number) => {
    setEditingCell({ row: rowIndex, field });
    setEditValue(String(currentValue));
  };

  const saveEdit = () => {
    if (!editingCell) return;

    const { row, field } = editingCell;
    const updatedItems = [...result.items];
    const item = { ...updatedItems[row] };

    switch (field) {
      case 'inventoryId':
        item.inventoryId = editValue;
        break;
      case 'lotSerialNbr':
        item.lotSerialNbr = editValue;
        break;
      case 'pieceCount':
        item.pieceCount = parseInt(editValue, 10) || 1;
        break;
      case 'grossWeightLbs':
        item.grossWeightLbs = parseFloat(editValue) || 0;
        break;
      case 'containerQtyLbs':
        item.containerQtyLbs = parseFloat(editValue) || 0;
        break;
      case 'heatNumber':
        item.heatNumber = editValue;
        break;
      case 'orderQtyOverride':
        item.orderQtyOverride = parseFloat(editValue) || undefined;
        break;
      case 'unitCostOverride':
        item.unitCostOverride = parseFloat(editValue) || undefined;
        break;
      case 'warehouse':
        item.warehouse = editValue;
        break;
      case 'orderLineNbrOverride':
        item.orderLineNbrOverride = editValue ? parseInt(editValue, 10) : undefined;
        break;
    }

    updatedItems[row] = item;

    // Recalculate totals
    const totalGrossWeightLbs = updatedItems.reduce((sum, i) => sum + i.grossWeightLbs, 0);
    const totalNetWeightLbs = updatedItems.reduce((sum, i) => sum + i.containerQtyLbs, 0);

    onUpdate({
      ...result,
      items: updatedItems,
      totalGrossWeightLbs,
      totalNetWeightLbs,
    });

    setEditingCell(null);
    setEditValue('');
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const addRow = () => {
    const lastItem = result.items[result.items.length - 1];
    const poNumber = result.poNumber || '000000';
    const nextBundle = result.items.length + 1;

    const newItem: PackingListItem = {
      lineNumber: result.items.length + 1,
      inventoryId: lastItem?.inventoryId || '0.250-48__-120__-304/304L-#1___',
      lotSerialNbr: `${poNumber.padStart(6, '0')}-${String(nextBundle).padStart(2, '0')}`,
      pieceCount: lastItem?.pieceCount || 1,
      grossWeightLbs: 0,
      containerQtyLbs: 0,
      heatNumber: '',
      rawSize: lastItem?.rawSize || '1/4"*48"*120"',
    };

    const updatedItems = [...result.items, newItem];

    onUpdate({
      ...result,
      items: updatedItems,
    });
  };

  const deleteRow = (index: number) => {
    const updatedItems = result.items.filter((_, i) => i !== index);

    // Renumber remaining items
    updatedItems.forEach((item, i) => {
      item.lineNumber = i + 1;
    });

    // Recalculate totals
    const totalGrossWeightLbs = updatedItems.reduce((sum, i) => sum + i.grossWeightLbs, 0);
    const totalNetWeightLbs = updatedItems.reduce((sum, i) => sum + i.containerQtyLbs, 0);

    onUpdate({
      ...result,
      items: updatedItems,
      totalGrossWeightLbs,
      totalNetWeightLbs,
    });
  };

  const updateAllWarehouses = (newWarehouse: string) => {
    const updatedItems = result.items.map(item => ({
      ...item,
      warehouse: newWarehouse,
    }));

    onUpdate({
      ...result,
      items: updatedItems,
      warehouse: newWarehouse,
      warehouseDetected: true, // Mark as detected since user explicitly set it
    });
  };

  const renderEditableCell = (
    rowIndex: number,
    field: string,
    value: string | number,
    isNumeric: boolean = false,
    isMonospace: boolean = false,
    decimalPlaces?: number
  ) => {
    const isEditing = editingCell?.row === rowIndex && editingCell?.field === field;

    // Format numeric value with appropriate decimal places
    const formatValue = (val: string | number) => {
      if (val === '' || val === undefined) return <span className="text-slate-300">-</span>;
      if (!isNumeric) return val;
      const num = Number(val);
      if (decimalPlaces !== undefined) {
        return num.toFixed(decimalPlaces);
      }
      return num.toLocaleString();
    };

    if (isEditing) {
      if (field === 'inventoryId') {
        return (
          <div className="flex gap-1">
            <select
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={handleKeyDown}
              autoFocus
              className="w-full px-1 py-0.5 text-xs border border-navy-400 rounded-md focus:outline-none focus:ring-2 focus:ring-navy-400/30 focus:border-navy-500"
            >
              <option value={editValue}>{editValue}</option>
              {COMMON_SIZES.map((size) => (
                <option key={size.value} value={size.value}>
                  {size.label}
                </option>
              ))}
            </select>
          </div>
        );
      }

      return (
        <input
          type={isNumeric ? 'number' : 'text'}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={handleKeyDown}
          autoFocus
          className={`w-full px-1 py-0.5 text-xs border border-navy-400 rounded-md focus:outline-none focus:ring-2 focus:ring-navy-400/30 focus:border-navy-500 ${
            isNumeric ? 'text-right' : ''
          }`}
        />
      );
    }

    return (
      <span
        onClick={() => startEdit(rowIndex, field, value)}
        className={`cursor-pointer hover:bg-navy-50 px-1 py-0.5 rounded transition-colors duration-150 ${
          isMonospace ? 'font-mono text-[11px]' : ''
        } ${isNumeric ? 'text-right block' : ''}`}
        title="Click to edit"
      >
        {formatValue(value)}
      </span>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-soft">
      {/* Header Info */}
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <div className="flex flex-wrap gap-4 text-sm items-center justify-between">
          <div className="flex flex-wrap gap-4 items-center">
            <div>
              <span className="text-slate-500">Supplier:</span>{' '}
              <span className="font-medium text-slate-700">{supplierNames[result.supplier]}</span>
            </div>
            <div>
              <span className="text-slate-500">Vendor Code:</span>{' '}
              <span className="font-medium font-mono text-slate-700">{result.vendorCode}</span>
            </div>
            {result.poNumber && (
              <div>
                <span className="text-slate-500">PO #:</span>{' '}
                <span className="font-medium text-slate-700">{result.poNumber}</span>
              </div>
            )}
            <div>
              <span className="text-slate-500">Items:</span>{' '}
              <span className="font-medium text-slate-700">{result.items.length}</span>
            </div>
            {result.warehouseDetected === false && (
              <div className="flex items-center gap-1.5 text-amber-600 bg-amber-50 px-2 py-1 rounded-lg">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span className="text-xs font-medium">Warehouse not detected.</span>
                <select
                  value={result.warehouse || warehouse}
                  onChange={(e) => updateAllWarehouses(e.target.value)}
                  className="ml-1 px-2 py-0.5 text-xs font-medium bg-white border border-amber-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400/30 focus:border-amber-500 cursor-pointer"
                >
                  {WAREHOUSES.map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-amber-500">(applies to all)</span>
              </div>
            )}
            {onWeightTypeChange && (
              <div className="flex items-center gap-2 ml-2 pl-2 border-l border-slate-300">
                <span className="text-slate-500">Weight:</span>
                <div className="flex rounded-lg overflow-hidden border border-slate-200">
                  <button
                    type="button"
                    onClick={() => onWeightTypeChange('actual')}
                    className={`px-2.5 py-1 text-xs font-medium transition-all duration-200 ${
                      weightType === 'actual'
                        ? 'bg-navy-800 text-white'
                        : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Actual
                  </button>
                  <button
                    type="button"
                    onClick={() => onWeightTypeChange('theoretical')}
                    className={`px-2.5 py-1 text-xs font-medium border-l border-slate-200 transition-all duration-200 ${
                      weightType === 'theoretical'
                        ? 'bg-navy-800 text-white border-navy-800'
                        : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Theoretical
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onExport && (
              <button
                onClick={onExport}
                className="px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 active:bg-emerald-700 transition-all duration-200 flex items-center gap-1.5 shadow-sm"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export
              </button>
            )}
            <button
              onClick={addRow}
              className="px-3 py-1.5 text-xs font-medium bg-navy-800 text-white rounded-lg hover:bg-navy-700 active:bg-navy-900 transition-all duration-200 flex items-center gap-1.5 shadow-sm"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Row
            </button>
          </div>
        </div>
      </div>

      {/* Edit Instructions */}
      <div className="px-4 py-1.5 bg-navy-50 border-b border-navy-100 text-xs text-navy-600">
        Click any cell to edit. Press Enter to save, Escape to cancel.
      </div>

      {/* Items Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-200">
              <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Line #
              </th>
              <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Inventory ID
              </th>
              <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Lot/Serial
              </th>
              <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Pcs
              </th>
              <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Gross Wt
              </th>
              <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Order Qty
              </th>
              <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Container
              </th>
              <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Unit Cost
              </th>
              <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Heat #
              </th>
              <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                WH
              </th>
              <th className="px-2 py-2 text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                UOM
              </th>
              <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Line #
              </th>
              <th className="px-2 py-2 text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wider">

              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.items.map((item, index) => {
              // Get weight based on weight type selection
              const theoreticalWeights = calculateTheoreticalWeights(item);
              const displayGrossWeight = weightType === 'theoretical'
                ? theoreticalWeights.totalWeight  // Includes skid for #1 finish (what's on the scale)
                : item.grossWeightLbs;
              const displayContainerWeight = weightType === 'theoretical'
                ? theoreticalWeights.steelWeight  // Pure steel weight only (inventory weight)
                : item.containerQtyLbs;

              // Calculate OrderQty: sum of PURE STEEL weights (no skid) for all items with same inventoryId (SKU)
              const calculatedOrderQty = result.items
                .filter(i => i.inventoryId === item.inventoryId)
                .reduce((sum, i) => {
                  const itemWeight = weightType === 'theoretical'
                    ? calculateTheoreticalWeights(i).steelWeight  // Pure steel, no skid for Order Qty
                    : i.containerQtyLbs;
                  return sum + itemWeight;
                }, 0);
              const orderQty = item.orderQtyOverride ?? calculatedOrderQty;

              // Unit cost: use invoice price if available, otherwise blank
              // unitCostOverride can be set from invoice parsing or manual entry
              const unitCost = item.unitCostOverride ?? '';

              // Warehouse: use item-level override or default
              const itemWarehouse = item.warehouse || warehouse;

              return (
                <tr
                  key={`${item.lineNumber}-${index}`}
                  className={`hover:bg-navy-50/50 transition-colors duration-150 ${
                    index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'
                  }`}
                >
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-400">
                    {item.lineNumber}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'inventoryId', item.inventoryId, false, true)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-600">
                    {renderEditableCell(index, 'lotSerialNbr', item.lotSerialNbr, false, true)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'pieceCount', item.pieceCount, true)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'grossWeightLbs', displayGrossWeight, true)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'orderQtyOverride', orderQty, true, false, 2)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'containerQtyLbs', displayContainerWeight, true)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'unitCostOverride', unitCost, true, false, 4)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-500">
                    {renderEditableCell(index, 'heatNumber', item.heatNumber || '')}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-600">
                    {renderEditableCell(index, 'warehouse', itemWarehouse)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-400 text-center">
                    LB
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-slate-700">
                    {renderEditableCell(index, 'orderLineNbrOverride', item.orderLineNbrOverride ?? '', true)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-center">
                    <button
                      onClick={() => deleteRow(index)}
                      className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1 rounded transition-all duration-200"
                      title="Delete row"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 border-t border-slate-200">
            {(() => {
              // Calculate totals based on weight type
              // Gross: includes skid for #1 finish (what's on the scale)
              // Order Qty & Container: pure steel weight only (inventory weight)
              const totalGross = weightType === 'theoretical'
                ? result.items.reduce((sum, item) => sum + calculateTheoreticalWeights(item).totalWeight, 0)
                : result.totalGrossWeightLbs;
              const totalOrderQty = weightType === 'theoretical'
                ? result.items.reduce((sum, item) => sum + calculateTheoreticalWeights(item).steelWeight, 0)
                : result.totalNetWeightLbs;
              const totalContainer = weightType === 'theoretical'
                ? result.items.reduce((sum, item) => sum + calculateTheoreticalWeights(item).steelWeight, 0)
                : result.totalNetWeightLbs;
              return (
                <tr>
                  <td colSpan={4} className="px-2 py-2 text-xs font-semibold text-slate-600 text-right">
                    Total:
                  </td>
                  <td className="px-2 py-2 text-xs font-semibold text-slate-700 text-right">
                    {totalGross.toLocaleString()}
                  </td>
                  <td className="px-2 py-2 text-xs font-semibold text-slate-700 text-right">
                    {totalOrderQty.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-2 py-2 text-xs font-semibold text-slate-700 text-right">
                    {totalContainer.toLocaleString()}
                  </td>
                  <td colSpan={6}></td>
                </tr>
              );
            })()}
          </tfoot>
        </table>
      </div>
    </div>
  );
}
