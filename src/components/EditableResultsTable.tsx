import { useState } from 'react';
import { ParsedPackingList, PackingListItem } from '../types';

// Steel density: 0.2833 lbs per cubic inch (for 304 stainless)
const STEEL_DENSITY_LBS_PER_CUBIC_INCH = 0.2833;

/**
 * Calculate theoretical weight from dimensions
 */
function calculateTheoreticalWeight(item: PackingListItem): number {
  // Parse dimensions from inventory ID: "0.188-60__-144__-304/304L-#1____"
  const match = item.inventoryId.match(/^([\d.]+)-(\d+)__-(\d+)__-/);
  if (!match) {
    // Fallback to actual weight if can't parse
    return item.grossWeightLbs;
  }

  const thickness = parseFloat(match[1]);
  const width = parseFloat(match[2]);
  const length = parseFloat(match[3]);

  // Volume in cubic inches * density * piece count
  const volumePerPiece = thickness * width * length;
  const weightPerPiece = volumePerPiece * STEEL_DENSITY_LBS_PER_CUBIC_INCH;
  const totalWeight = weightPerPiece * item.pieceCount;

  return Math.round(totalWeight);
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
}

export function EditableResultsTable({
  result,
  warehouse = 'LA',
  weightType = 'actual',
  onWeightTypeChange,
  onUpdate
}: EditableResultsTableProps) {
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');

  const supplierNames = {
    'wuu-jing': 'Wuu Jing',
    'yuen-chang': 'Yuen Chang',
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

  const renderEditableCell = (
    rowIndex: number,
    field: string,
    value: string | number,
    isNumeric: boolean = false,
    isMonospace: boolean = false
  ) => {
    const isEditing = editingCell?.row === rowIndex && editingCell?.field === field;

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
              className="w-full px-1 py-0.5 text-sm border border-blue-500 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          className={`w-full px-1 py-0.5 text-sm border border-blue-500 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${
            isNumeric ? 'text-right' : ''
          }`}
        />
      );
    }

    return (
      <span
        onClick={() => startEdit(rowIndex, field, value)}
        className={`cursor-pointer hover:bg-blue-50 px-1 py-0.5 rounded ${
          isMonospace ? 'font-mono' : ''
        } ${isNumeric ? 'text-right block' : ''}`}
        title="Click to edit"
      >
        {value === '' || value === undefined ? '-' : isNumeric ? Number(value).toLocaleString() : value}
      </span>
    );
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header Info */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <div className="flex flex-wrap gap-4 text-sm items-center justify-between">
          <div className="flex flex-wrap gap-4 items-center">
            <div>
              <span className="text-gray-500">Supplier:</span>{' '}
              <span className="font-medium">{supplierNames[result.supplier]}</span>
            </div>
            <div>
              <span className="text-gray-500">Vendor Code:</span>{' '}
              <span className="font-medium font-mono">{result.vendorCode}</span>
            </div>
            {result.poNumber && (
              <div>
                <span className="text-gray-500">PO #:</span>{' '}
                <span className="font-medium">{result.poNumber}</span>
              </div>
            )}
            <div>
              <span className="text-gray-500">Items:</span>{' '}
              <span className="font-medium">{result.items.length}</span>
            </div>
            {onWeightTypeChange && (
              <div className="flex items-center gap-2 ml-2 pl-2 border-l border-gray-300">
                <span className="text-gray-500">Weight:</span>
                <div className="flex rounded-md shadow-sm">
                  <button
                    type="button"
                    onClick={() => onWeightTypeChange('actual')}
                    className={`px-2 py-1 text-xs font-medium rounded-l-md border ${
                      weightType === 'actual'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Actual
                  </button>
                  <button
                    type="button"
                    onClick={() => onWeightTypeChange('theoretical')}
                    className={`px-2 py-1 text-xs font-medium rounded-r-md border-t border-r border-b ${
                      weightType === 'theoretical'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Theoretical
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={addRow}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Row
          </button>
        </div>
      </div>

      {/* Edit Instructions */}
      <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 text-sm text-blue-700">
        Click any cell to edit. Press Enter to save, Escape to cancel.
      </div>

      {/* Items Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Line #
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Inventory ID
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Lot/Serial
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Piece Count
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Gross Weight
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                OrderQty
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Container
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Unit Cost
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Heat #
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Warehouse
              </th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                UOM
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Order Line #
              </th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {result.items.map((item, index) => {
              // Get weight based on weight type selection
              const displayGrossWeight = weightType === 'theoretical'
                ? calculateTheoreticalWeight(item)
                : item.grossWeightLbs;
              const displayContainerWeight = weightType === 'theoretical'
                ? calculateTheoreticalWeight(item)
                : item.containerQtyLbs;

              // Calculate OrderQty: sum of weights for all items with same inventoryId (SKU)
              const calculatedOrderQty = result.items
                .filter(i => i.inventoryId === item.inventoryId)
                .reduce((sum, i) => {
                  const itemWeight = weightType === 'theoretical'
                    ? calculateTheoreticalWeight(i)
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
                <tr key={`${item.lineNumber}-${index}`} className="hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                    {item.lineNumber}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'inventoryId', item.inventoryId, false, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                    {renderEditableCell(index, 'lotSerialNbr', item.lotSerialNbr, false, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'pieceCount', item.pieceCount, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'grossWeightLbs', displayGrossWeight, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'orderQtyOverride', orderQty, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'containerQtyLbs', displayContainerWeight, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'unitCostOverride', unitCost, true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                    {renderEditableCell(index, 'heatNumber', item.heatNumber || '')}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                    {renderEditableCell(index, 'warehouse', itemWarehouse)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500 text-center">
                    LB
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900">
                    {renderEditableCell(index, 'orderLineNbrOverride', item.orderLineNbrOverride ?? '', true)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm text-center">
                    <button
                      onClick={() => deleteRow(index)}
                      className="text-red-600 hover:text-red-800 p-1"
                      title="Delete row"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-gray-50">
            {(() => {
              // Calculate totals based on weight type
              const totalGross = weightType === 'theoretical'
                ? result.items.reduce((sum, item) => sum + calculateTheoreticalWeight(item), 0)
                : result.totalGrossWeightLbs;
              const totalNet = weightType === 'theoretical'
                ? result.items.reduce((sum, item) => sum + calculateTheoreticalWeight(item), 0)
                : result.totalNetWeightLbs;
              return (
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-sm font-medium text-gray-700 text-right">
                    Total:
                  </td>
                  <td className="px-3 py-2 text-sm font-medium text-gray-900 text-right">
                    {totalGross.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-sm font-medium text-gray-900 text-right">
                    {totalNet.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-sm font-medium text-gray-900 text-right">
                    {totalNet.toLocaleString()}
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
