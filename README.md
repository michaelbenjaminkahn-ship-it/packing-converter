# Packing List Converter

A web application for converting steel supplier packing lists (from Wuu Jing and Yuen Chang in Taiwan) into Excel format for upload to Acumatica ERP.

## Features

- **File Upload**: Drag-and-drop support for PDF and Excel files
- **Auto-Detection**: Automatically identifies packing list pages vs invoices or mill certificates
- **Size Parsing**: Converts size specifications into Inventory IDs (e.g., "3/8 x 4" → "FB-0375X4")
- **Weight Conversion**: Converts metric tons to pounds
- **Excel Export**: Generates formatted Excel files for Acumatica import

## Supported Suppliers

- **Wuu Jing** (五井)
- **Yuen Chang** (元昌)

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The app will be available at `http://localhost:5173`.

### Build

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Project Structure

```
src/
├── components/       # React components
│   ├── FileDropzone.tsx    # Drag-and-drop file upload
│   ├── FileList.tsx        # Uploaded files display
│   └── ResultsTable.tsx    # Parsed results display
├── types/           # TypeScript type definitions
├── utils/           # Utility functions
│   ├── constants.ts        # App constants
│   └── conversion.ts       # Conversion utilities
├── App.tsx          # Main application component
├── main.tsx         # Application entry point
└── index.css        # Global styles
```

## Technology Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Tailwind CSS** - Styling
- **xlsx** - Excel file generation
- **pdfjs-dist** - PDF parsing
