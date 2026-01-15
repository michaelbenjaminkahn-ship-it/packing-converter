import { useState, useCallback, useRef, useEffect } from 'react';
import { FileDropzone, FileList } from './components';
import { EditableResultsTable } from './components/EditableResultsTable';
import { UploadedFile, ParsedPackingList } from './types';
import { generateId, extractPoNumber } from './utils/conversion';
import { parseFile, OcrProgress } from './utils/parser';
import { downloadByContainer } from './utils/excelExport';
import { WAREHOUSES, DEFAULT_WAREHOUSE } from './utils/constants';
import { loadInventoryFromExcel, getInventoryCount, clearInventory } from './utils/inventoryLookup';

type WeightType = 'actual' | 'theoretical';

interface OcrState {
  isRunning: boolean;
  fileId: string | null;
  fileName: string;
  progress: number;
  status: string;
}

function App() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [results, setResults] = useState<ParsedPackingList[]>([]);
  const [poNumber, setPoNumber] = useState('');
  const [warehouse, setWarehouse] = useState<string>(DEFAULT_WAREHOUSE);
  const [weightType, setWeightType] = useState<WeightType>('actual');
  const [isProcessing, setIsProcessing] = useState(false);
  const [inventoryCount, setInventoryCount] = useState(0);
  const [ocrState, setOcrState] = useState<OcrState>({
    isRunning: false,
    fileId: null,
    fileName: '',
    progress: 0,
    status: '',
  });
  const [ocrWarnings, setOcrWarnings] = useState<string[]>([]);
  const [warehouseAutoDetected, setWarehouseAutoDetected] = useState(false);
  const inventoryInputRef = useRef<HTMLInputElement>(null);

  // Load inventory count on mount
  useEffect(() => {
    setInventoryCount(getInventoryCount());
  }, []);

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

  const handleOcrProgress = useCallback((progress: OcrProgress) => {
    setOcrState((prev) => ({
      ...prev,
      progress: progress.progress,
      status: progress.status,
    }));
  }, []);

  const processFileWithOcr = useCallback(async (uploadedFile: UploadedFile) => {
    setOcrState({
      isRunning: true,
      fileId: uploadedFile.id,
      fileName: uploadedFile.name,
      progress: 0,
      status: 'Starting OCR...',
    });

    try {
      const parseResult = await parseFile(uploadedFile.file, {
        poNumber: poNumber || undefined,
        useOcr: true,
        onOcrProgress: handleOcrProgress,
      });

      if (parseResult.error) {
        throw new Error(parseResult.error);
      }

      if (parseResult.result) {
        // Add warning if OCR confidence was low
        if (parseResult.ocrWarning) {
          setOcrWarnings((prev) => [...prev, `${uploadedFile.name}: ${parseResult.ocrWarning}`]);
        }

        setFiles((prev) =>
          prev.map((f) =>
            f.id === uploadedFile.id
              ? { ...f, status: 'completed' as const, result: parseResult.result }
              : f
          )
        );

        setResults((prev) => [...prev, parseResult.result!]);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setFiles((prev) =>
        prev.map((f) =>
          f.id === uploadedFile.id
            ? { ...f, status: 'error' as const, error: errorMessage }
            : f
        )
      );
    } finally {
      setOcrState({
        isRunning: false,
        fileId: null,
        fileName: '',
        progress: 0,
        status: '',
      });
    }
  }, [poNumber, handleOcrProgress]);

  const handleConvert = useCallback(async () => {
    const pendingFiles = files.filter((f) => f.status === 'pending');

    if (pendingFiles.length === 0) {
      return;
    }

    setIsProcessing(true);
    setOcrWarnings([]);

    // Update status to processing
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'pending' ? { ...f, status: 'processing' as const } : f
      )
    );

    // Process each file
    const newResults: ParsedPackingList[] = [];
    const filesNeedingOcr: UploadedFile[] = [];

    for (const uploadedFile of pendingFiles) {
      try {
        const parseResult = await parseFile(uploadedFile.file, {
          poNumber: poNumber || undefined,
        });

        if (parseResult.needsOcr) {
          // Mark as needing OCR, will process after
          filesNeedingOcr.push(uploadedFile);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === uploadedFile.id
                ? { ...f, status: 'pending' as const, error: 'Needs OCR - scanned PDF detected' }
                : f
            )
          );
        } else if (parseResult.error) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === uploadedFile.id
                ? { ...f, status: 'error' as const, error: parseResult.error }
                : f
            )
          );
        } else if (parseResult.result) {
          newResults.push(parseResult.result);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === uploadedFile.id
                ? { ...f, status: 'completed' as const, result: parseResult.result }
                : f
            )
          );

          // Pre-fill PO number from parsed result if not already set
          if (!poNumber && parseResult.result.poNumber && parseResult.result.poNumber !== 'UNKNOWN') {
            setPoNumber(parseResult.result.poNumber);
          }

          // Pre-fill warehouse from parsed result if detected
          if (parseResult.result.warehouse) {
            setWarehouse(parseResult.result.warehouse);
            setWarehouseAutoDetected(true);
          }
        }
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

    // Auto-process files needing OCR
    for (const file of filesNeedingOcr) {
      await processFileWithOcr(file);
    }
  }, [files, poNumber, processFileWithOcr]);

  const handleExport = useCallback(() => {
    if (results.length === 0) return;

    // Export each packing list, splitting by container
    // Stagger downloads to prevent browser from blocking multiple rapid downloads
    results.forEach((result, index) => {
      setTimeout(() => {
        downloadByContainer(result, warehouse, weightType);
      }, index * 500); // 500ms delay between each download
    });
  }, [results, warehouse, weightType]);

  const handleClear = useCallback(() => {
    setFiles([]);
    setResults([]);
    setPoNumber('');
    setOcrWarnings([]);
    setWarehouseAutoDetected(false);
  }, []);

  const handleInventoryUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const count = await loadInventoryFromExcel(file);
      setInventoryCount(getInventoryCount());
      alert(`Loaded ${count} inventory IDs. Total: ${getInventoryCount()}`);
    } catch {
      alert('Failed to load inventory file. Make sure it has an "Inventory ID" column.');
    }

    // Reset input
    if (inventoryInputRef.current) {
      inventoryInputRef.current.value = '';
    }
  }, []);

  const handleClearInventory = useCallback(() => {
    clearInventory();
    setInventoryCount(0);
  }, []);

  const handleResultUpdate = useCallback((index: number, updatedResult: ParsedPackingList) => {
    setResults((prev) => {
      const newResults = [...prev];
      newResults[index] = updatedResult;
      return newResults;
    });
  }, []);

  const hasPendingFiles = files.some((f) => f.status === 'pending');
  const hasResults = results.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* OCR Progress Modal */}
      {ocrState.isRunning && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Running OCR on Scanned PDF
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              {ocrState.fileName}
            </p>
            <div className="mb-2">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${ocrState.progress}%` }}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500">{ocrState.status}</p>
            <p className="text-xs text-amber-600 mt-3">
              OCR may take 10-30 seconds per page. Please wait...
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">
                Packing List Converter
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                Convert steel supplier packing lists for Acumatica import
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={inventoryInputRef}
                onChange={handleInventoryUpload}
                accept=".xlsx,.xls"
                className="hidden"
              />
              <button
                onClick={() => inventoryInputRef.current?.click()}
                className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Upload Inventory List
              </button>
              {inventoryCount > 0 && (
                <>
                  <span className="text-xs text-green-600 font-medium">
                    {inventoryCount} IDs loaded
                  </span>
                  <button
                    onClick={handleClearInventory}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        {/* OCR Warnings */}
        {ocrWarnings.length > 0 && (
          <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <h4 className="text-sm font-medium text-amber-800 mb-2">
              OCR Accuracy Warnings
            </h4>
            <ul className="text-xs text-amber-700 space-y-1">
              {ocrWarnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
            <p className="text-xs text-amber-600 mt-2">
              Please verify the extracted data before exporting.
            </p>
          </div>
        )}

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
                    {poNumber && (
                      <span className="ml-2 text-xs text-green-600 font-normal">(auto-detected)</span>
                    )}
                  </label>
                  <input
                    type="text"
                    id="poNumber"
                    value={poNumber}
                    onChange={(e) => setPoNumber(e.target.value)}
                    placeholder="Auto-detected from file"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label
                    htmlFor="warehouse"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Warehouse
                    {warehouseAutoDetected && (
                      <span className="ml-2 text-xs text-green-600 font-normal">(auto-detected)</span>
                    )}
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
                disabled={!hasPendingFiles || isProcessing || ocrState.isRunning}
                className={`
                  px-4 py-2 rounded-lg font-medium text-sm
                  ${
                    hasPendingFiles && !isProcessing && !ocrState.isRunning
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  }
                  transition-colors flex items-center gap-2
                `}
              >
                {(isProcessing || ocrState.isRunning) && (
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
                {isProcessing ? 'Processing...' : ocrState.isRunning ? 'Running OCR...' : 'Convert Files'}
              </button>
              <button
                onClick={handleClear}
                disabled={isProcessing || ocrState.isRunning}
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
                <EditableResultsTable
                  key={index}
                  result={result}
                  warehouse={warehouse}
                  onUpdate={(updatedResult) => handleResultUpdate(index, updatedResult)}
                />
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
            <p className="text-xs text-gray-400 mt-2">
              Supports text-based PDFs and scanned PDFs (via OCR)
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
