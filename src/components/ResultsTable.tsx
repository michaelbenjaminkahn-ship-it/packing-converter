import { ParsedPackingList } from '../types';

interface ResultsTableProps {
  result: ParsedPackingList;
}

export function ResultsTable({ result }: ResultsTableProps) {
  const supplierNames = {
    'wuu-jing': 'Wuu Jing',
    'yuen-chang': 'Yuen Chang',
    unknown: 'Unknown Supplier',
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header Info */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-gray-500">Supplier:</span>{' '}
            <span className="font-medium">{supplierNames[result.supplier]}</span>
          </div>
          {result.poNumber && (
            <div>
              <span className="text-gray-500">PO #:</span>{' '}
              <span className="font-medium">{result.poNumber}</span>
            </div>
          )}
          {result.invoiceNumber && (
            <div>
              <span className="text-gray-500">Invoice #:</span>{' '}
              <span className="font-medium">{result.invoiceNumber}</span>
            </div>
          )}
          {result.shipDate && (
            <div>
              <span className="text-gray-500">Ship Date:</span>{' '}
              <span className="font-medium">{result.shipDate}</span>
            </div>
          )}
        </div>
      </div>

      {/* Items Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                #
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Inventory ID
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Description
              </th>
              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Qty
              </th>
              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Weight (MT)
              </th>
              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Weight (lbs)
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Heat #
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {result.items.map((item) => (
              <tr key={item.lineNumber} className="hover:bg-gray-50">
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">
                  {item.lineNumber}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm font-mono text-gray-900">
                  {item.inventoryId}
                </td>
                <td className="px-4 py-2 text-sm text-gray-700">{item.description}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 text-right">
                  {item.quantity}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 text-right">
                  {item.weightMT.toFixed(3)}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 text-right">
                  {item.weightLbs.toLocaleString()}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">
                  {item.heatNumber || '-'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr>
              <td colSpan={4} className="px-4 py-2 text-sm font-medium text-gray-700 text-right">
                Total:
              </td>
              <td className="px-4 py-2 text-sm font-medium text-gray-900 text-right">
                {result.totalWeightMT.toFixed(3)}
              </td>
              <td className="px-4 py-2 text-sm font-medium text-gray-900 text-right">
                {result.totalWeightLbs.toLocaleString()}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
