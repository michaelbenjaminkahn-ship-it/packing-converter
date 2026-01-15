import { useState, useCallback } from 'react';
import { FileDropzone, FileList, ResultsTable } from './components';
import { UploadedFile, ParsedPackingList } from './types';
import { generateId } from './utils/conversion';

function App() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [results, setResults] = useState<ParsedPackingList[]>([]);

  const handleFilesSelected = useCallback((newFiles: File[]) => {
    const uploadedFiles: UploadedFile[] = newFiles.map((file) => {
      const ext = file.name.toLowerCase().split('.').pop();
      return {
        id: generateId(),
        name: file.name,
        type: ext === 'pdf' ? 'pdf' : 'excel',
        file,
        status: 'pending',
      };
    });

    setFiles((prev) => [...prev, ...uploadedFiles]);
  }, []);

  const handleRemoveFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleConvert = useCallback(async () => {
    // TODO: Implement actual file processing
    // For now, show a placeholder result
    const pendingFiles = files.filter((f) => f.status === 'pending');

    if (pendingFiles.length === 0) {
      return;
    }

    // Update status to processing
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'pending' ? { ...f, status: 'processing' as const } : f
      )
    );

    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Create placeholder results
    const newResults: ParsedPackingList[] = pendingFiles.map(() => ({
      supplier: 'wuu-jing' as const,
      poNumber: 'PO-2024-001',
      invoiceNumber: 'INV-12345',
      shipDate: '2024-01-15',
      items: [
        {
          lineNumber: 1,
          inventoryId: 'FB-0375X4',
          description: 'Flat Bar 3/8" x 4"',
          quantity: 10,
          weightMT: 2.5,
          weightLbs: 5511,
          heatNumber: 'H123456',
        },
        {
          lineNumber: 2,
          inventoryId: 'FB-0500X6',
          description: 'Flat Bar 1/2" x 6"',
          quantity: 8,
          weightMT: 3.2,
          weightLbs: 7055,
          heatNumber: 'H123457',
        },
      ],
      totalWeightMT: 5.7,
      totalWeightLbs: 12566,
    }));

    setResults((prev) => [...prev, ...newResults]);

    // Update status to completed
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'processing' ? { ...f, status: 'completed' as const } : f
      )
    );
  }, [files]);

  const handleExport = useCallback(() => {
    // TODO: Implement Excel export
    alert('Excel export will be implemented with the xlsx library');
  }, []);

  const handleClear = useCallback(() => {
    setFiles([]);
    setResults([]);
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

          {/* Action Buttons */}
          {files.length > 0 && (
            <div className="mt-4 flex gap-3">
              <button
                onClick={handleConvert}
                disabled={!hasPendingFiles}
                className={`
                  px-4 py-2 rounded-lg font-medium text-sm
                  ${
                    hasPendingFiles
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  }
                  transition-colors
                `}
              >
                Convert Files
              </button>
              <button
                onClick={handleClear}
                className="px-4 py-2 rounded-lg font-medium text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
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
                Conversion Results
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
                <ResultsTable key={index} result={result} />
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
