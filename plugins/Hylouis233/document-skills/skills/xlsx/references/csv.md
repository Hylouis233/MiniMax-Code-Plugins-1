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
  through (dates via `datetime.strptime` with the format actually observed).
- XLSX -> CSV: `iter_rows(values_only=True)`; format numbers yourself only if the user needs a
  fixed display format - otherwise write raw values and say so.
- Large CSV -> keep it CSV or move to SQLite/Parquet; loading it all into one sheet to
  "preserve" it usually exceeds limits and helps nobody.

## Messy data cleanup contract

1. Profile before touching: row count, per-column types, null counts, duplicate-key check.
2. Report the cleanup plan and get on with it only for mechanical transforms (trim, case,
   date parsing, dedup on declared keys).
3. Every destructive step (dropping rows, overwriting values) must be counted and reported.
