# Excel Metals Packing List Converter - Project Brief

## Summary of What We Figured Out

This document summarizes a conversation where we developed and refined a tool to convert supplier packing lists into Acumatica upload format. Use this as your starting point - all the business logic and edge cases have been worked out.

---

## The Problem

Excel Metals receives packing lists from Taiwanese steel suppliers (Wuu Jing and Yuen Chang) in PDF or Excel format. These need to be converted to a specific Excel format for upload to Acumatica (their ERP system) for inventory receiving.

**Pain points:**
- Suppliers use different formats (metric vs imperial, different column names)
- PDFs often contain multiple documents (invoice, packing list, mill certs) - need to identify the right one
- Manual conversion is tedious and error-prone
- Inventory IDs must be built from size specifications using specific formatting rules

---

## The Solution We Built

A converter tool that:
1. Accepts both PDF and Excel files
2. Auto-detects which page/sheet contains the packing list (vs invoice or mill cert)
3. Identifies the supplier format (Wuu Jing vs Yuen Chang)
4. Parses size specifications into Inventory IDs
5. Converts weights to pounds if needed
6. Outputs Acumatica-ready Excel file

---

## Key Business Logic

### Inventory ID Format
```
{thickness}-{width}__-{length}__-304/304L-{finish}
```

The `__` after width and length is intentional padding. Examples:
- `0.188-60__-144__-304/304L-#1____` 
- `0.030-48__-120__-304/304L-2B____`

### Two Supplier Formats

**Wuu Jing (V005006):**
- Hot rolled plate, finish = `#1____`
- Size format: `4.76*1525MM*3660MM(3/16"*60"*144")`
- Weights in Metric Tons (MT) - multiply by 2204.62 for pounds
- Lot number from "BUNDLE NO." column
- Heat numbers NOT in packing list - found in Mill Test Certificates

**Yuen Chang (V005010):**
- Cold rolled sheet, finish = `2B____`
- Size format: `22GA*48"*120"` or similar
- Weights already in pounds
- Lot number from "ITEM" column  
- Heat numbers usually in packing list

### Thickness Conversion Tables

**Gauge to Decimal (Yuen Chang):**
- 26GA → 0.018
- 24GA → 0.024
- 22GA → 0.030
- 20GA → 0.036
- 18GA → 0.048
- 16GA → 0.060
- 14GA → 0.075
- 12GA → 0.105
- 11GA → 0.120
- 10GA → 0.135

**MM to Decimal (Wuu Jing):**
- 4.76mm → 0.188 (3/16")
- 6.35mm → 0.250 (1/4")
- 7.94mm → 0.313 (5/16")
- 9.53mm → 0.375 (3/8")
- 12.70mm → 0.500 (1/2")

### Output Columns for Acumatica
| Column | Description | Auto-filled? |
|--------|-------------|--------------|
| Order Number | PO number | User enters once |
| Vendor | V005006 or V005010 | Auto from supplier |
| Inventory ID | Built from size | Auto |
| Lot/Serial Nbr. | Bundle/Item number | Auto |
| Piece Count | From PC column | Auto |
| Heat Number | From packing list or Mill Cert | Sometimes auto |
| Gross Weight | In pounds | Auto |
| OrderQty | Sum for line | Manual |
| Container Qty | Net weight in pounds | Auto |
| Unit Cost | From PO | Manual |
| Warehouse | LA/Baltimore/Houston | User selects |
| UOM | Always "LB" | Auto |
| Order Line Nbr | From PO | Manual |

---

## PDF Detection Logic

Supplier PDFs contain multiple document types. We built a scoring system:

**Packing List indicators (+10 points each):**
- "pcs", "pc", "pieces", "qty"
- "size", "gauge", "thickness"  
- "bundle", "bundle no", "item"
- "weight", "net weight", "gross weight"
- "heat", "heat no", "coil"

**Non-packing-list indicators (-15 points each):**
- "invoice", "total amount", "payment", "bill to" (it's an invoice)
- "certificate", "test result", "chemical composition", "tensile", "yield" (it's a mill cert)

**Bonus:**
- "PACKING LIST" in title: +30 points
- 3-100 data rows: +15 points

Sheet/page with highest score ≥ 30 is selected as the packing list.

---

## What We Tested

Successfully converted a Wuu Jing PDF (PO 1812) containing:
- Page 1: Commercial Invoice (correctly skipped)
- Page 2: Packing List with 19 bundles (correctly extracted)
- Pages 3-8: Mill Test Certificates (correctly skipped)

Output: 19 rows with proper Inventory IDs, weights converted from MT to LBS, bundle numbers mapped.

---

## User's Situation

- Works at Excel Metals
- No coding experience
- Wants a polished, shareable tool (not just a script)
- Prefers a local web app with nice UI
- Will use Claude Code to build it

---

## Recommended Tech Stack

- **Frontend:** React + Tailwind CSS
- **PDF parsing:** pdf.js or pdf-parse
- **Excel parsing:** xlsx (SheetJS)
- **Excel output:** xlsx or exceljs
- **Run locally:** No backend needed, everything client-side

---

## User Flow to Build

1. Drop PDF or Excel file
2. App scans all pages/sheets, scores each for "packing list likelihood"
3. If confident (score ≥ 40, single page), auto-select; otherwise show picker
4. Auto-detect supplier from content (look for "Wuu Jing", "bundle no", etc.)
5. Parse data and show preview table
6. User enters Order Number, confirms/changes Warehouse
7. Click "Convert" → generates Excel file
8. User downloads, fills in manual fields, uploads to Acumatica

---

## Files to Include with This Brief

1. **PACKING_LIST_CONVERTER_PROJECT.md** - Detailed business logic reference
2. **CONVERSATION_SUMMARY.md** - This file
3. **Sample Wuu Jing PDF** - For testing (the PO 1812 file)
4. **Sample converted output** - What the Excel should look like

---

## First Prompt for Claude Code

```
I want to build a packing list converter for Excel Metals (a steel company).

Read these files first - they contain all the business logic and context:
- CONVERSATION_SUMMARY.md (start here)
- PACKING_LIST_CONVERTER_PROJECT.md (detailed reference)

Build a local web app (React + Tailwind) that:
1. Accepts PDF or Excel files via drag-and-drop
2. Auto-detects the packing list page/sheet (vs invoices or mill certs)
3. Parses the data and shows a preview
4. Converts to Acumatica upload format
5. Downloads as Excel file

Make it look polished and professional - this will be shared with the team.

Start by reading the docs, then set up the project structure.
```

---

## Tips for Working with Claude Code

1. **Be specific about what's wrong** - "The thickness should be 0.250, not 0.25" is better than "it's not working"

2. **Test with real files** - Drop actual packing lists and report exactly what failed

3. **Iterate in small steps** - Get the PDF parsing working first, then the conversion, then the UI polish

4. **Save working versions** - When something works, commit it before making big changes

5. **Ask Claude to explain** - If you don't understand why something was done, just ask

---

## Potential Future Enhancements

- Auto-lookup heat numbers from Mill Test Cert pages in the same PDF
- Watch a folder and auto-convert new files
- Remember user preferences (default warehouse, etc.)
- Validate Inventory IDs against Acumatica master list
- Support additional suppliers
- Desktop app packaging (Electron/Tauri) for easier distribution
