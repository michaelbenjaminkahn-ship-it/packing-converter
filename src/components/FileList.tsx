import { UploadedFile } from '../types';

interface FileListProps {
  files: UploadedFile[];
  onRemove: (id: string) => void;
}

export function FileList({ files, onRemove }: FileListProps) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Uploaded Files</h3>
      <ul className="space-y-2">
        {files.map((file) => (
          <li
            key={file.id}
            className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200"
          >
            <div className="flex items-center gap-3">
              <FileIcon type={file.type} />
              <div>
                <p className="text-sm font-medium text-gray-700">{file.name}</p>
                <StatusBadge status={file.status} error={file.error} />
              </div>
            </div>
            <button
              onClick={() => onRemove(file.id)}
              className="p-1 text-gray-400 hover:text-red-500 transition-colors"
              title="Remove file"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileIcon({ type }: { type: 'pdf' | 'excel' }) {
  if (type === 'pdf') {
    return (
      <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center">
        <span className="text-xs font-bold text-red-600">PDF</span>
      </div>
    );
  }
  return (
    <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
      <span className="text-xs font-bold text-green-600">XLS</span>
    </div>
  );
}

function StatusBadge({ status, error }: { status: UploadedFile['status']; error?: string }) {
  const badges = {
    pending: (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
        Pending
      </span>
    ),
    processing: (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-600">
        <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" fill="none" viewBox="0 0 24 24">
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
        Processing
      </span>
    ),
    completed: (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-600">
        Completed
      </span>
    ),
    error: (
      <div className="flex flex-col">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-600">
          Error
        </span>
        {error && (
          <span className="text-xs text-red-500 mt-1 max-w-md truncate" title={error}>
            {error}
          </span>
        )}
      </div>
    ),
  };

  return badges[status];
}
