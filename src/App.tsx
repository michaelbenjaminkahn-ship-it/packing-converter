import { useState, useCallback } from 'react';
import { FileDropzone, FileList, ResultsTable } from './components';
import { UploadedFile, ParsedPackingList } from './types';
import { generateId, extractPoNumber } from './utils/conversion';
import { parseFile } from './utils/parser';
import { downloadExcel, exportMultipleToExcel } from './utils/excelExport';
import { WAREHOUSES, DEFAULT_WAREHOUSE } from './utils/constants';

type WeightType = 'actual' | 'theoretical';

function App() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [results, setResults] = useState<ParsedPackingList[]>([]);
  const [poNumber, setPoNumber] = useState('');
  const [warehouse, setWarehouse] = useState<string>(DEFAULT_WAREHOUSE);
  const [weightType, setWeightType] = useState<WeightType>('actual');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFilesSelected = useCallback((newFiles: File[]) => {
    const uploadedFiles: UploadedFile[] = newFiles.map((file) => {
      const ext = file.name.toLowerCase().split('.').pop();

      // Try to extract PO number from filename
      if (!poNumber) {
        const extractedPo = extractPoNumber(file.name);
        if (extractedPo) {
          setPoNumber(extractedPo);
        }
      }

      return {
        id: generateId(),
        name: file.name,
        type: ext === 'pdf' ? 'pdf' : 'excel',
        file,
        status: 'pending',
      };
    });

    setFiles((prev) => [...prev, ...uploadedFiles]);
  }, [poNumber]);

  const handleRemoveFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setResults((prev) => {
      const file = files.find((f) => f.id === id);
      if (file?.result) {
        return prev.filter((r) => r !== file.result);
      }
      return prev;
    });
  }, [files]);

  const handleConvert = useCallback(async () => {
    const pendingFiles = files.filter((f) => f.status === 'pending');

    if (pendingFiles.length === 0) {
      return;
    }

    setIsProcessing(true);

    // Update status to processing
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'pending' ? { ...f, status: 'processing' as const } : f
      )
    );

    // Process each file
    const newResults: ParsedPackingList[] = [];

    for (const uploadedFile of pendingFiles) {
      try {
        const result = await parseFile(uploadedFile.file, poNumber || undefined);
        newResults.push(result);

        // Update file with result
        setFiles((prev) =>
          prev.map((f) =>
            f.id === uploadedFile.id
              ? { ...f, status: 'completed' as const, result }
              : f
          )
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        setFiles((prev) =>
          prev.map((f) =>
            f.id === uploadedFile.id
              ? { ...f, status: 'error' as const, error: errorMessage }
              : f
          )
        );
      }
    }

    setResults((prev) => [...prev, ...newResults]);
    setIsProcessing(false);
  }, [files, poNumber]);

  const handleExport = useCallback(() => {
    if (results.length === 0) return;

    if (results.length === 1) {
      downloadExcel(results[0], warehouse, weightType);
    } else {
      // Multiple results - combine into one file
      const blob = exportMultipleToExcel(results, warehouse, weightType);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `PackingLists_converted.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }, [results, warehouse, weightType]);

  const handleClear = useCallback(() => {
    setFiles([]);
    setResults([]);
    setPoNumber('');
  }, []);

  const hasPendingFiles = files.some((f) => f.status === 'pending');
  const hasResults = results.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold text-gray-900">
            Packing List Converter
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Convert steel supplier packing lists for Acumatica import
          </p>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        {/* Upload Section */}
        <section className="mb-8">
          <FileDropzone onFilesSelected={handleFilesSelected} />
          <FileList files={files} onRemove={handleRemoveFile} />

          {/* Settings */}
          {files.length > 0 && (
            <div className="mt-4 p-4 bg-white rounded-lg border border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label
                    htmlFor="poNumber"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    PO Number
                  </label>
                  <input
                    type="text"
                    id="poNumber"
                    value={poNumber}
                    onChange={(e) => setPoNumber(e.target.value)}
                    placeholder="e.g., 1812"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label
                    htmlFor="warehouse"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Warehouse
                  </label>
                  <select
                    id="warehouse"
                    value={warehouse}
                    onChange={(e) => setWarehouse(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  >
                    {WAREHOUSES.map((wh) => (
                      <option key={wh} value={wh}>
                        {wh}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Weight Type
                  </label>
                  <div className="flex rounded-md shadow-sm">
                    <button
                      type="button"
                      onClick={() => setWeightType('actual')}
                      className={`flex-1 px-3 py-2 text-sm font-medium rounded-l-md border ${
                        weightType === 'actual'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      Actual
                    </button>
                    <button
                      type="button"
                      onClick={() => setWeightType('theoretical')}
                      className={`flex-1 px-3 py-2 text-sm font-medium rounded-r-md border-t border-r border-b ${
                        weightType === 'theoretical'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      Theoretical
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          {files.length > 0 && (
            <div className="mt-4 flex gap-3">
              <button
                onClick={handleConvert}
                disabled={!hasPendingFiles || isProcessing}
                className={`
                  px-4 py-2 rounded-lg font-medium text-sm
                  ${
                    hasPendingFiles && !isProcessing
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  }
                  transition-colors flex items-center gap-2
                `}
              >
                {isProcessing && (
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
                {isProcessing ? 'Processing...' : 'Convert Files'}
              </button>
              <button
                onClick={handleClear}
                disabled={isProcessing}
                className="px-4 py-2 rounded-lg font-medium text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Clear All
              </button>
            </div>
          )}
        </section>

        {/* Results Section */}
        {hasResults && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium text-gray-900">
                Conversion Results ({results.reduce((sum, r) => sum + r.items.length, 0)} items)
              </h2>
              <button
                onClick={handleExport}
                className="px-4 py-2 rounded-lg font-medium text-sm bg-green-600 text-white hover:bg-green-700 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                Export to Excel
              </button>
            </div>

            <div className="space-y-6">
              {results.map((result, index) => (
                <ResultsTable key={index} result={result} warehouse={warehouse} />
              ))}
            </div>
          </section>
        )}

        {/* Empty State */}
        {files.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">
              Upload packing list files from Wuu Jing or Yuen Chang to get started.
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto py-4 text-center text-sm text-gray-400">
        <p>Supports Wuu Jing and Yuen Chang packing list formats</p>
      </footer>
    </div>
  );
}

export default App;
