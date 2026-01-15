import { useCallback, useState, DragEvent, ChangeEvent } from 'react';

interface FileDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
}

export function FileDropzone({
  onFilesSelected,
  accept = '.pdf,.xlsx,.xls',
  multiple = true,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const droppedFiles = Array.from(e.dataTransfer.files).filter((file) => {
        const ext = file.name.toLowerCase().split('.').pop();
        return ext === 'pdf' || ext === 'xlsx' || ext === 'xls';
      });

      if (droppedFiles.length > 0) {
        onFilesSelected(droppedFiles);
      }
    },
    [onFilesSelected]
  );

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onFilesSelected(Array.from(files));
      }
      // Reset the input so the same file can be selected again
      e.target.value = '';
    },
    [onFilesSelected]
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        relative border border-dashed rounded-xl p-6 text-center cursor-pointer
        transition-all duration-200 ease-out
        ${
          isDragging
            ? 'border-navy-500 bg-navy-50/50 scale-[1.01]'
            : 'border-slate-200 hover:border-slate-300 bg-white hover:bg-slate-50/50'
        }
      `}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleFileInput}
        className="hidden"
        id="file-input"
      />
      <label htmlFor="file-input" className="cursor-pointer">
        <div className="flex flex-col items-center gap-2">
          <div className={`
            w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-200
            ${isDragging ? 'bg-navy-100 text-navy-600' : 'bg-slate-100 text-slate-400'}
          `}>
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <div>
            <p className={`text-sm font-medium transition-colors duration-200 ${isDragging ? 'text-navy-700' : 'text-slate-600'}`}>
              {isDragging ? 'Drop files here' : 'Drop files here or click to browse'}
            </p>
          </div>
          <p className="text-xs text-slate-400">
            PDF and Excel files (.pdf, .xlsx, .xls)
          </p>
        </div>
      </label>
    </div>
  );
}
