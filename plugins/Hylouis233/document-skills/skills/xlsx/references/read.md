# Read / profile a workbook

```python
import openpyxl

formula_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=False)
value_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=True)
print("sheets:", value_wb.sheetnames)

def formula_text(cell):
    value = cell.value
    # ArrayFormula/DataTableFormula are objects in current openpyxl, not strings.
    return getattr(value, "text", None) or str(value)

# Profile EVERY sheet by default; only narrow when the task names a specific sheet.
for sheet_name in value_wb.sheetnames:
    formula_ws = formula_wb[sheet_name]
    value_ws = value_wb[sheet_name]
    # Read-only iteration is bounded by the sheet's <dimension> metadata.
    # Non-Excel producers write wrong dimensions, which silently truncates the
    # stream; when the declared extent looks implausible, reset it and let
    # openpyxl discover the real used range.
    declared = value_ws.calculate_dimension()
    if value_ws.max_row in (None, 0) or declared in ("A1:A1", "A1"):
        value_ws.reset_dimensions()
        formula_ws.reset_dimensions()
        print(f"--- {sheet_name} --- implausible dimension {declared!r}; reset, real extent:")
    print(f"--- {sheet_name} --- dims:", value_ws.calculate_dimension())

    rows = value_ws.iter_rows(values_only=True)
    header = next(rows, None)
    print("header:", header)
    for i, row in enumerate(rows):
        if i >= 5: break
        print(row)

    missing_cache_count = 0
    for formula_row, value_row in zip(formula_ws.iter_rows(), value_ws.iter_rows()):
        for formula_cell, value_cell in zip(formula_row, value_row):
            if formula_cell.data_type == "f" and value_cell.value is None:
                missing_cache_count += 1
                if missing_cache_count <= 10:
                    print("formula without cached value:", formula_cell.coordinate,
                          formula_text(formula_cell))
    print("formulas without cached values:", missing_cache_count)
formula_wb.close()
value_wb.close()
```

## Rules

- First pass always: sheet names, per-sheet dimensions, header row, 5 sample rows. Report
  those before any analysis. Multi-sheet workbooks report every sheet - a profile that
  silently covers only `sheetnames[0]` is incomplete.
- `read_only=True` streams large files; you lose random access (`ws["B2"]` works but is slow
  in read_only mode - iterate instead).
- `data_only=True` gives cached values. A file saved by a library (never opened in Excel)
  may return `None` for formulas with no cache. Compare each cell with the corresponding cell
  from a `data_only=False` workbook and detect formulas with `cell.data_type == "f"`; array and
  data-table formulas may not be strings beginning with `=`, so a string-prefix test is incomplete.
- Mixed-type columns: profile them (`set(type(v).__name__ for v in col)`) before converting;
  a column that is mostly numbers with a few text cells is a data-quality finding, not noise.
- Never load the full sheet into memory to "look at it" when `iter_rows` with a break would do.
