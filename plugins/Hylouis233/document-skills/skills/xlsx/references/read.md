# Read / profile a workbook

```python
import openpyxl

wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=True)
print("sheets:", wb.sheetnames)
ws = wb[wb.sheetnames[0]]
print("dims:", ws.calculate_dimension())

rows = ws.iter_rows(values_only=True)
header = next(rows)
print("header:", header)
for i, row in enumerate(rows):
    if i >= 5: break
    print(row)
```

## Rules

- First pass always: sheet names, dimensions, header row, 5 sample rows. Report those before
  any analysis.
- `read_only=True` streams large files; you lose random access (`ws["B2"]` works but is slow
  in read_only mode - iterate instead).
- `data_only=True` gives cached values. A file saved by a library (never opened in Excel)
  has **no cached values** - formulas read as `None`. Detect and report this instead of
  claiming cells are empty.
- Mixed-type columns: profile them (`set(type(v).__name__ for v in col)`) before converting;
  a column that is mostly numbers with a few text cells is a data-quality finding, not noise.
- Never load the full sheet into memory to "look at it" when `iter_rows` with a break would do.
