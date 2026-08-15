# Read / profile a workbook

```python
import openpyxl

formula_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=False)
value_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=True)
print("sheets:", value_wb.sheetnames)

# Profile EVERY sheet by default; only narrow when the task names a specific sheet.
for sheet_name in value_wb.sheetnames:
    formula_ws = formula_wb[sheet_name]
    value_ws = value_wb[sheet_name]
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
            if (isinstance(formula_cell.value, str)
                    and formula_cell.value.startswith("=")
                    and value_cell.value is None):
                missing_cache_count += 1
                if missing_cache_count <= 10:
                    print("formula without cached value:", formula_cell.coordinate,
                          formula_cell.value)
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
  from a `data_only=False` workbook, as above, before claiming it is empty.
- Mixed-type columns: profile them (`set(type(v).__name__ for v in col)`) before converting;
  a column that is mostly numbers with a few text cells is a data-quality finding, not noise.
- Never load the full sheet into memory to "look at it" when `iter_rows` with a break would do.
