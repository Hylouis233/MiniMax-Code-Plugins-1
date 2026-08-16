# Conditional formatting, tables, and pivot-style aggregation

## Conditional formatting (openpyxl)

Rules attach to a range and survive openpyxl round trips. Scopes smaller than the whole
column keep files fast and avoid formatting ghost rows:

```python
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule, FormulaRule
from openpyxl.styles import Font, PatternFill

red_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
red_font = Font(color="9C0006")
last = ws.max_row                                  # real data boundary, not the column

# With only a header row (max_row == 1) every range below would be inverted
# ("D2:D1"); openpyxl rejects those ranges, so guard before building rules.
if last < 2:
    print(f"skipping conditional formatting: no data rows below the header (max_row={last})")
else:
    # value-based rule
    ws.conditional_formatting.add(
        f"D2:D{last}",
        CellIsRule(operator="lessThan", formula=["0"], fill=red_fill, font=red_font),
    )

    # whole-row highlight: FormulaRule anchored with $ on the key column
    ws.conditional_formatting.add(f"A2:F{last}", FormulaRule(formula=["$D2<0"], fill=red_fill))

    # gradient and data bars for magnitude scanning
    ws.conditional_formatting.add(
        f"C2:C{last}",
        ColorScaleRule(start_type="min", start_color="FFFFFF", end_type="max", end_color="63BE7B"),
    )
    ws.conditional_formatting.add(
        f"E2:E{last}",
        DataBarRule(start_type="min", end_type="max", color="638EC6"),
    )
```

- FormulaRule formulas are US-locale and relative to the range's top-left cell - `$D2` (lock
  column, free row) is what makes the whole-row pattern work.
- Multiple rules on one range evaluate by priority; if exactly one should apply, set
  `stopIfTrue=True` on the earlier rules.

## Structured tables

A real Table gives filter UI, banded styling, and structured references:

```python
from openpyxl.worksheet.table import Table, TableStyleInfo

tbl = Table(displayName="TData", ref=f"A1:F{ws.max_row}")   # name has no spaces
tbl.tableStyleInfo = TableStyleInfo(name="TableStyleMedium9", showRowStripes=True)
ws.add_table(tbl)
```

One Table per sheet region; the ref must cover the headers. Do not also draw manual borders
over a Table range.

## Pivot-style aggregation - the honest contract

**openpyxl cannot create pivot tables.** It preserves existing ones on a load/save round trip,
but building the pivot cache from scratch is not supported. Offer these routes and say which
one you took:

1. **Formula sheet (live, recalculates)** - the default. A `SUMIFS`/`COUNTIFS`/`AVERAGEIFS`
   grid keyed on a unique-values column reproduces most pivot outputs and stays a formula
   per contract rule 1. Build every sheet reference from the real source sheet's name -
   hard-coding `Data!` breaks on any workbook whose sheet is named differently:

   ```python
   ws2 = wb.create_sheet("ByRegion")
   ws2.append(["Region", "Units", "Revenue"])

   def sheet_ref(sheet):
       # Always quote: valid titles such as Q1-Data are ambiguous when left bare.
       # Excel escapes an apostrophe inside a quoted title by doubling it.
       escaped = sheet.title.replace("'", "''")
       return f"'{escaped}'!"

   src = sheet_ref(ws)                              # e.g. "'Sales'!" or "'Raw Data'!"
   regions = []
   seen_region_keys = set()
   for (region,) in ws.iter_rows(min_row=2, min_col=1, max_col=1, values_only=True):
       if region is None or region == "":             # keep valid falsey values: 0 and False
           continue
       key = (type(region), region)                    # do not collapse False and numeric 0
       if key not in seen_region_keys:
           seen_region_keys.add(key)
           regions.append(region)                     # stable source order; no mixed-type sort
   for i, region in enumerate(regions, start=2):
       ws2.cell(row=i, column=1, value=region)
       ws2.cell(row=i, column=2, value=f"=SUMIF({src}A:A,A{i},{src}C:C)")
       ws2.cell(row=i, column=3, value=f"=SUMIF({src}A:A,A{i},{src}D:D)")
   ```

   Unique values themselves are formulas only with array/dynamic functions - extracting them
   in Python (as above) and writing them as values is the accepted split; the aggregates stay
   live.

2. **Frozen pivot values (Python-side grouping)** - when the user wants a one-shot analysis
   report, not a living workbook. Group in pure Python (or pandas if already installed),
   write values, and **label the sheet** ("values as of generation, not recalculated").

3. **User's Excel/template pivot** - when the workbook already has slicers or a pivot the
  user maintains, edit around it and re-run the `round_trip_changes` check from
  [edit.md](edit.md) before saving.

## Postcheck additions

1. Re-open and count `ws.conditional_formatting` ranges; confirm the intended ranges exist
   and anchor rows match the data (a rule left on `D2:D1048576` from an earlier resize is a
   defect).
2. Confirm Table names are unique workbook-wide and refs cover the header row.
3. For the formula-sheet route, assert the aggregate cells contain formula strings, per the
   main postcheck.
