# Excel Metals Packing List Converter

A tool to convert supplier packing lists (PDF/Excel) into Acumatica upload format.

## What This Tool Does

Takes packing lists from:
- **Wuu Jing** (Taiwan) - Hot rolled plate, #1 finish
- **Yuen Chang** (Taiwan) - Cold rolled sheet, 2B finish

And converts them to the Excel format Acumatica needs for inventory receipt upload.

## Business Logic (IMPORTANT)

### Inventory ID Format
```
{thickness}-{width}__-{length}__-304/304L-{finish}
```
Examples:
- `0.188-60__-144__-304/304L-#1____` (3/16" x 60" x 144" hot rolled)
- `0.030-48__-120__-304/304L-2B____` (22GA x 48" x 120" cold rolled)

### Thickness Conversions

**Gauge to Decimal (for Yuen Chang cold rolled):**
| Gauge | Decimal |
|-------|---------|
| 26GA | 0.018 |
| 24GA | 0.024 |
| 22GA | 0.030 |
| 20GA | 0.036 |
| 18GA | 0.048 |
| 16GA | 0.060 |
| 14GA | 0.075 |
| 12GA | 0.105 |
| 11GA | 0.120 |
| 10GA | 0.135 |

**MM to Decimal (for Wuu Jing hot rolled):**
| MM | Fraction | Decimal |
|----|----------|---------|
| 4.76 | 3/16" | 0.188 |
| 6.35 | 1/4" | 0.250 |
| 7.94 | 5/16" | 0.313 |
| 9.53 | 3/8" | 0.375 |
| 12.70 | 1/2" | 0.500 |

### Supplier Differences

| Field | Wuu Jing | Yuen Chang |
|-------|----------|------------|
| Vendor Code | V005006 | V005010 |
| Finish | #1____ (hot rolled) | 2B____ (cold rolled) |
| Lot/Serial Source | BUNDLE NO. column | ITEM column |
| Size Format | `4.76*1525MM*3660MM(3/16"*60"*144")` | `22GA*48"*120"` |
| Weight Units | Metric Tons (MT) | Pounds (LBS) |
| Heat Number | NOT in packing list (need Mill Cert) | In packing list |

### Weight Conversion
- Metric Tons to Pounds: multiply by 2204.62
- For Wuu Jing theoretical weight: not needed (actual weights provided)
- For Yuen Chang: actual weights usually provided

### Output Columns (Acumatica Format)
1. **Order Number** - PO number (e.g., "1812")
2. **Vendor** - V005006 (Wuu Jing) or V005010 (Yuen Chang)
3. **Inventory ID** - Built from size parsing
4. **Lot/Serial Nbr.** - Bundle number or Item number
5. **Piece Count** - From PC/PCS column
6. **Heat Number** - From packing list or Mill Cert
7. **Gross Weight** - In pounds
8. **OrderQty** - *Manual entry needed*
9. **Container Qty** - Net weight in pounds
10. **Unit Cost** - *Manual entry needed*
11. **Warehouse** - LA, Baltimore, or Houston
12. **UOM** - Always "LB"
13. **Order Line Nbr** - *Manual entry needed*

## PDF Structure (Multi-page files)

Supplier PDFs often contain multiple document types:
- **Page 1:** Commercial Invoice (SKIP - has pricing, not quantities per bundle)
- **Page 2:** Packing List (USE THIS - has bundle-level detail)
- **Pages 3+:** Mill Test Certificates (USE FOR - heat numbers if not in packing list)

### How to Identify Packing List Page
Look for these columns:
- NO. / ITEM
- SIZE
- PC / PCS
- BUNDLE NO.
- NET WEIGHT / N'WEIGHT
- GROSS WEIGHT / G'WEIGHT

### How to Identify Invoice (skip it)
- Has PRICE, AMOUNT, US$/PC, US$/MT columns
- Usually summarized (not per-bundle)

### How to Identify Mill Test Cert
- Has CHEMICAL COMPOSITION (C, Si, Mn, P, S, Ni, Cr...)
- Has MECHANICAL PROPERTIES (Tensile, Yield, Elongation, Hardness)
- Has HEAT NO. or PRODUCT ID that can be cross-referenced

## Size Parsing Examples

**Wuu Jing format:** `4.76*1525MM*3660MM(3/16"*60"*144")`
- Thickness: 4.76mm → 0.188"
- Width: 60"
- Length: 144"
- Result: `0.188-60__-144__-304/304L-#1____`

**Yuen Chang format:** `22GA*48"*120"` or `22GA(48"*120")`
- Thickness: 22GA → 0.030"
- Width: 48"
- Length: 120"
- Result: `0.030-48__-120__-304/304L-2B____`

## Warehouses
- **LA** - Los Angeles (most common)
- **Baltimore** - East coast
- **Houston** - Gulf coast

## Tech Stack Suggestions

For the local web app:
- **Frontend:** React + Tailwind CSS
- **PDF Parsing:** pdf.js (for text extraction) or pdf-parse
- **Excel Parsing:** xlsx (SheetJS)
- **Excel Output:** xlsx or exceljs
- **Backend (optional):** Node.js/Express or just run client-side

## User Flow

1. User drops PDF or Excel file
2. App detects file type and scans for packing list
3. If multiple sheets/pages, show selection with confidence scores
4. Auto-detect supplier (Wuu Jing vs Yuen Chang) from content
5. Show parsed data preview
6. User enters Order Number and selects Warehouse
7. User clicks Convert
8. App generates Excel file for download
9. User fills in manual fields (Unit Cost, Order Line Nbr, OrderQty) in Excel
10. User uploads to Acumatica

## Example: Converting PO 1812 (Wuu Jing)

Input PDF had:
- Page 1: Commercial Invoice
- Page 2: Packing List (19 bundles)
- Pages 3-8: Mill Test Certificates

Output: 19 rows with:
- Inventory IDs built from sizes
- Weights converted from MT to LBS
- Bundle numbers as Lot/Serial Nbr
- Heat Numbers left blank (would need Mill Cert lookup)
