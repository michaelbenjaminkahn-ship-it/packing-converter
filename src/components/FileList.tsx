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
    <div className="mt-4">
      <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
        Uploaded Files
      </h3>
      <ul className="space-y-2">
        {files.map((file) => (
          <li
            key={file.id}
            className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-200 shadow-soft hover:shadow transition-shadow duration-200"
          >
            <div className="flex items-center gap-3">
              <FileIcon type={file.type} />
              <div>
                <p className="text-sm font-medium text-slate-700">{file.name}</p>
                <StatusBadge status={file.status} error={file.error} />
              </div>
            </div>
            <button
              onClick={() => onRemove(file.id)}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all duration-200"
              title="Remove file"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <div className="w-9 h-9 bg-red-50 rounded-lg flex items-center justify-center border border-red-100">
        <span className="text-[10px] font-bold text-red-600">PDF</span>
      </div>
    );
  }
  return (
    <div className="w-9 h-9 bg-emerald-50 rounded-lg flex items-center justify-center border border-emerald-100">
      <span className="text-[10px] font-bold text-emerald-600">XLS</span>
    </div>
  );
}

function StatusBadge({ status, error }: { status: UploadedFile['status']; error?: string }) {
  const badges = {
    pending: (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600">
        Pending
      </span>
    ),
    processing: (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-navy-100 text-navy-700">
        <svg className="animate-spin -ml-0.5 mr-1 h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
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
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-700">
        <svg className="w-2.5 h-2.5 mr-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        Completed
      </span>
    ),
    error: (
      <div className="flex flex-col">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700">
          Error
        </span>
        {error && (
          <span className="text-[10px] text-red-500 mt-0.5 max-w-xs truncate" title={error}>
            {error}
          </span>
        )}
      </div>
    ),
  };

  return badges[status];
}
