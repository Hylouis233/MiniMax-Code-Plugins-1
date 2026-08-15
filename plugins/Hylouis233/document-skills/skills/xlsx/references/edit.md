# Edit an existing workbook

```python
import openpyxl
from datetime import date
from openpyxl.styles import Font

wb = openpyxl.load_workbook("input.xlsx")   # NOT data_only: that would drop all formulas
ws = wb["Data"]

# Address cells directly; check the header to confirm column meaning first
ws["D2"] = "=C2*1.08"                      # real formula
ws["E2"] = date(2025, 9, 30)
ws["E2"].number_format = "yyyy-mm-dd"
ws["F2"] = 1234.5
ws["F2"].number_format = "#,##0.00"

# Insert a row at a position (formulas in shifted rows do NOT auto-adjust - rewrite them)
ws.insert_rows(5)

# Append a new sheet for derived output
summary = wb.create_sheet("Summary")
summary["A1"] = "Region"
summary["B1"] = "Total"
summary["A2"] = "EU"
summary["B2"] = "=SUMIF(Data!A:A,A2,Data!C:C)"

header_font = Font(bold=True)
for row in summary["A1:B1"]:
    for cell in row:
        cell.font = header_font

# References to the shifted region may live on any sheet; inspect every formula
for formula_ws in wb.worksheets:
    for row in formula_ws.iter_rows():
        for cell in row:
            if isinstance(cell.value, str) and cell.value.startswith("="):
                print(f"{formula_ws.title}!{cell.coordinate}: {cell.value}")

wb.save("input-edited.xlsx")
```

- Before editing an unknown workbook, detect parts an openpyxl load/save round trip silently
  drops (slicers, pivot caches, power-query connections are the common casualties). Save a
  copy to memory, compare archive contents, and report the loss before overwriting the file:

  ```python
  import zipfile
  from io import BytesIO

  def round_trip_losses(path, **load_options):
      with zipfile.ZipFile(path) as z:
          before = set(z.namelist())
      wb = openpyxl.load_workbook(path, **load_options)   # same options as the real edit
      buf = BytesIO()
      wb.save(buf)
      with zipfile.ZipFile(buf) as z:
          return sorted(before - set(z.namelist()))

  losses = round_trip_losses("input.xlsx")
  if losses:
      print("WARNING: saving with openpyxl will drop:", losses)
      # report to the user and get confirmation before the first save
  ```

## Rules

- `insert_rows`/`delete_rows` move cells but do **not** rewrite range references for you.
  After structural edits, traverse `wb.worksheets` as above and update every formula that
  references the shifted region, including formulas on other sheets.
- Styling: import `Font` and assign the style to each cell. A range such as `ws["A1:F1"]`
  returns tuples of cells and cannot be styled as one object.
- Column widths: `ws.column_dimensions["A"].width = 28` - set after writing data, from the
  longest value you wrote, not a fixed guess.
- Freeze panes and autofilter improve usability cheaply:
  `ws.freeze_panes = "A2"; ws.auto_filter.ref = ws.dimensions`.
- Merged cells: avoid creating new merges; writing into a non-anchor merged cell raises.
- `.xlsm`: `load_workbook(path, keep_vba=True)` and save with the same suffix, or macros are
  stripped.
- Do not delete sheets unless asked; hide instead (`ws.sheet_state = "hidden"`) when the goal
  is a cleaner tab bar.
