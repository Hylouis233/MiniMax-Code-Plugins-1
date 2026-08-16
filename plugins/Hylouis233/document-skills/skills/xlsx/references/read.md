# Read / profile a workbook

```python
import openpyxl
from openpyxl.utils import get_column_letter

formula_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=False)
value_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=True)
print("sheets:", value_wb.sheetnames)

def formula_text(value):
    if isinstance(value, str):
        return value
    if text := getattr(value, "text", None):       # ArrayFormula
        return text
    # DataTableFormula has no .text; render stable, useful attributes, not an address repr.
    fields = ("ref", "r1", "r2", "dt2D", "dtr", "ca", "del1", "del2")
    details = ", ".join(
        f"{name}={getattr(value, name)!r}" for name in fields if hasattr(value, name)
    )
    return f"{type(value).__name__}({details})"

def discover_dimension(worksheet):
    """Scan an untrusted read-only stream without relying on its <dimension>."""
    worksheet.reset_dimensions()
    min_row = min_column = max_row = max_column = None
    for row in worksheet.iter_rows():
        for cell in row:
            row_index = getattr(cell, "row", None)       # EmptyCell has no coordinates
            column_index = getattr(cell, "column", None)
            if row_index is None or column_index is None:
                continue
            min_row = row_index if min_row is None else min(min_row, row_index)
            min_column = column_index if min_column is None else min(min_column, column_index)
            max_row = row_index if max_row is None else max(max_row, row_index)
            max_column = column_index if max_column is None else max(max_column, column_index)
    if max_row is None:
        return "A1:A1", None
    extent = (
        f"{get_column_letter(min_column)}{min_row}:"
        f"{get_column_letter(max_column)}{max_row}"
    )
    return extent, min_row

# Profile EVERY sheet by default; only narrow when the task names a specific sheet.
for sheet_name in value_wb.sheetnames:
    formula_ws = formula_wb[sheet_name]
    value_ws = value_wb[sheet_name]
    # Read-only iteration is bounded by the sheet's <dimension> metadata. A
    # non-Excel producer can declare a plausible but truncated range (for
    # example A1:B2 while data continues below it), so treat that metadata as
    # untrusted: reset both streams and discover the real bounds before reading.
    declared = value_ws.calculate_dimension()
    discovered, first_populated_row = discover_dimension(value_ws)
    formula_discovered, formula_first_row = discover_dimension(formula_ws)
    if (formula_discovered, formula_first_row) != (discovered, first_populated_row):
        raise ValueError(
            "formula/value stream bounds disagree: "
            f"{(formula_discovered, formula_first_row)} != "
            f"{(discovered, first_populated_row)}"
        )
    if discovered != declared:
        print(f"--- {sheet_name} --- declared {declared!r}; discovered real extent:")
    print(f"--- {sheet_name} --- dims:", discovered)

    if first_populated_row is None:
        rows, header = iter(()), None
    else:
        rows = value_ws.iter_rows(min_row=first_populated_row, values_only=True)
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
                          formula_text(formula_cell.value))
    print("formulas without cached values:", missing_cache_count)
formula_wb.close()
value_wb.close()
```

## Rules

- First pass always: sheet names, per-sheet dimensions, header row, 5 sample rows. Report
  those before any analysis. Multi-sheet workbooks report every sheet - a profile that
  silently covers only `sheetnames[0]` is incomplete. Begin the header/sample iterator at the
  discovered first populated row; leading blank rows are not a header.
- `read_only=True` streams large files; you lose random access (`ws["B2"]` works but is slow
  in read_only mode - iterate instead).
- `data_only=True` gives cached values. A file saved by a library (never opened in Excel)
  may return `None` for formulas with no cache. Compare each cell with the corresponding cell
  from a `data_only=False` workbook and detect formulas with `cell.data_type == "f"`; array and
  data-table formulas may not be strings beginning with `=`, so a string-prefix test is incomplete.
- Mixed-type columns: profile them (`set(type(v).__name__ for v in col)`) before converting;
  a column that is mostly numbers with a few text cells is a data-quality finding, not noise.
- Never load the full sheet into memory to "look at it" when `iter_rows` with a break would do.
