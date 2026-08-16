# CSV / TSV and messy data

## Reading

```python
import csv

with open("input.csv", newline="", encoding="utf-8-sig") as f:   # utf-8-sig strips a BOM
    reader = csv.DictReader(f)
    for i, row in enumerate(reader):
        if i >= 5: break
        print(row)
```

- Always pass `newline=""` to `open` on every platform - it is the documented requirement,
  not a style choice.
- Sniff the dialect when provenance is unknown, and pass the detected dialect to the reader -
  seeking back alone does not reconfigure it, so semicolon exports would still parse as comma:

  ```python
  with open("input.csv", newline="", encoding="utf-8-sig") as f:
      sample = f.read(2048)
      f.seek(0)
      dialect = csv.Sniffer().sniff(sample)      # raises csv.Error on ambiguous input
      reader = csv.DictReader(f, dialect=dialect)
      for i, row in enumerate(reader):
          if i >= 5: break
          print(row)
  ```
- Never trust inferred dtypes in CSV: everything is a string. Convert explicitly with
  `try/except ValueError` per column and report counts of parse failures rather than dropping
  rows silently.

## Writing

```python
import csv

with open("output.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(["Region", "Units"])
    writer.writerow(["EU", 120])
```

## Converting

- CSV -> XLSX: read with `csv`, write with openpyxl; convert values to real types on the way
  through (dates via `datetime.strptime` with the format actually observed). Treat every
  remaining CSV field as data, not a formula. In particular, force strings beginning with `=`
  back to the string data type unless the user explicitly requested formula interpretation:

  ```python
  def write_csv_field(cell, value):
      cell.value = value
      if isinstance(value, str) and value.startswith("="):
          cell.data_type = "s"  # openpyxl otherwise promotes it to an XLSX formula
  ```
- XLSX -> CSV: use a separate `data_only=True` read so formulas export the cached values users
  see, not formula strings. Pair it with a formula-preserving read and report missing caches;
  cached values can also be stale until a spreadsheet application recalculates the workbook:

  ```python
  import csv
  import openpyxl
  from pathlib import Path

  formula_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=False)
  value_wb = openpyxl.load_workbook("input.xlsx", read_only=True, data_only=True)
  formula_ws, value_ws = formula_wb["Data"], value_wb["Data"]
  missing_caches = []
  output_path = Path("output.csv")
  temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
  with temporary_path.open("w", newline="", encoding="utf-8") as output:
      writer = csv.writer(output)
      for formula_row, value_row in zip(formula_ws.iter_rows(), value_ws.iter_rows()):
          for formula_cell, value_cell in zip(formula_row, value_row):
              if formula_cell.data_type == "f" and value_cell.value is None:
                  missing_caches.append(formula_cell.coordinate)
          writer.writerow([cell.value for cell in value_row])
  formula_wb.close()
  value_wb.close()
  if missing_caches:
      temporary_path.unlink(missing_ok=True)
      raise RuntimeError(f"formula cells have no cached value: {missing_caches}")
  temporary_path.replace(output_path)
  ```

  Format numbers yourself only if the user needs a fixed display format; otherwise write raw
  cached values and say so. Export formula text from the `data_only=False` workbook only when
  the user explicitly requests formulas rather than displayed values.
- Large CSV -> keep it CSV or move to SQLite/Parquet; loading it all into one sheet to
  "preserve" it usually exceeds limits and helps nobody.

## Messy data cleanup contract

1. Profile before touching: row count, per-column types, null counts, duplicate-key check.
2. Report the cleanup plan and get on with it only for mechanical transforms (trim, case,
   date parsing, dedup on declared keys).
3. Every destructive step (dropping rows, overwriting values) must be counted and reported.
