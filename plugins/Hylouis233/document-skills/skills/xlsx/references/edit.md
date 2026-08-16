# Edit an existing workbook

```python
import openpyxl
from datetime import date
from openpyxl.styles import Font

wb = openpyxl.load_workbook("input.xlsx")   # NOT data_only: that would drop all formulas
ws = wb["Data"]

def non_cell_references(workbook):
    """Inventory ranges/formulas that insert_rows/delete_rows will not rewrite."""
    refs = []
    defined_names = workbook.defined_names
    # openpyxl 3.1 exposes a dict-like mapping; 3.0 uses DefinedNameList.
    defined_name_items = (
        defined_names.values()
        if hasattr(defined_names, "values")
        else defined_names.definedName
    )
    for item in defined_name_items:
        refs.append(("defined name", item.name, item.attr_text))
    for sheet in workbook.worksheets:
        owner = sheet.title
        for table in sheet.tables.values():
            refs.append(("table", owner + "!" + table.name, table.ref))
        for merged_range in sheet.merged_cells.ranges:
            refs.append(("merged range", owner, str(merged_range)))
        if sheet.auto_filter.ref:
            refs.append(("auto filter", owner, sheet.auto_filter.ref))
        for label, value in (
            ("print area", sheet.print_area),
            ("print title rows", sheet.print_title_rows),
            ("print title columns", sheet.print_title_cols),
        ):
            if value:
                refs.append((label, owner, str(value)))
        for validation in sheet.data_validations.dataValidation:
            refs.append(("data validation range", owner, str(validation.sqref)))
            for formula in (validation.formula1, validation.formula2):
                if formula:
                    refs.append(("data validation formula", owner, str(formula)))
        for conditional_range in sheet.conditional_formatting:
            refs.append(("conditional formatting range", owner, str(conditional_range.sqref)))
            for rule in sheet.conditional_formatting[conditional_range]:
                for formula in getattr(rule, "formula", ()):
                    refs.append(("conditional formatting formula", owner, str(formula)))
        for index, chart in enumerate(sheet._charts, start=1):
            for element in chart._write().iter():
                if element.tag.rsplit("}", 1)[-1] == "f" and element.text:
                    refs.append(("chart series", f"{owner} chart {index}", element.text))
    return refs

# Address cells directly; check the header to confirm column meaning first
ws["D2"] = "=C2*1.08"                      # real formula
ws["E2"] = date(2025, 9, 30)
ws["E2"].number_format = "yyyy-mm-dd"
ws["F2"] = 1234.5
ws["F2"].number_format = "#,##0.00"

# Insert/delete does not adjust formulas or non-cell dependencies. Fail closed until every
# reported reference that can intersect the shifted region has an explicit rewrite plan.
references_before = non_cell_references(wb)
if references_before:
    for reference in references_before:
        print("structural-edit dependency:", reference)
    raise RuntimeError(
        "insert_rows is unsafe until chart/name/table/filter/validation/format references are audited"
    )
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

# References to the shifted region may live on any sheet; inspect every formula, then rerun
# non_cell_references and verify every planned rewrite before saving.
for formula_ws in wb.worksheets:
    for row in formula_ws.iter_rows():
        for cell in row:
            if cell.data_type == "f":
                formula = getattr(cell.value, "text", None) or str(cell.value)
                print(f"{formula_ws.title}!{cell.coordinate}: {formula}")

wb.save("input-edited.xlsx")
```

- Before editing an unknown workbook, detect what an openpyxl load/save round trip silently
  changes. Dropped parts (slicers, pivot caches, power-query connections) are only half the
  risk: features stored *inside* a retained part, such as `x14` extension lists in
  `xl/worksheets/sheet1.xml`, can be stripped while the archive member name stays. Compare
  part contents too, not just names, and report both lists before overwriting the file:

  ```python
  import zipfile
  from tempfile import TemporaryFile

  # XML prefixes are arbitrary - a valid workbook may bind the x14 namespace to
  # "sx" or the markup-compatibility namespace to anything. Match the namespace
  # URIs (and the prefix-independent local name extLst), never prefixes.
  EXTENSION_MARKERS = {
      "extLst": b"extLst",
      "x14 namespace": b"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main",
      "markup compatibility": b"http://schemas.openxmlformats.org/markup-compatibility/2006",
  }

  def scan_extension_markers(archive, info):
      """Stream one XML part and retain marker names only, never the full payload."""
      found = set()
      overlap = max(len(marker) for marker in EXTENSION_MARKERS.values()) - 1
      tail = b""
      with archive.open(info) as stream:
          while chunk := stream.read(64 * 1024):
              window = tail + chunk
              found.update(
                  label for label, marker in EXTENSION_MARKERS.items() if marker in window
              )
              if len(found) == len(EXTENSION_MARKERS):
                  break
              tail = window[-overlap:]
      return found

  def archive_inventory(source):
      with zipfile.ZipFile(source) as archive:
          names = set(archive.namelist())
          markers = {}
          for info in archive.infolist():
              if info.filename.endswith((".xml", ".rels")):
                  found = scan_extension_markers(archive, info)
                  if found:
                      markers[info.filename] = found
          return names, markers

  def stripped_extension_markers(before, after, common_names):
      """Return every (part, marker) that was present before and absent after."""
      return sorted(
          (name, label)
          for name in common_names
          for label in before.get(name, set()) - after.get(name, set())
      )

  def round_trip_changes(path, **load_options):
      before_names, before_markers = archive_inventory(path)
      wb = openpyxl.load_workbook(path, **load_options)  # same options as the real edit
      with TemporaryFile() as output:
          wb.save(output)
          output.seek(0)
          after_names, after_markers = archive_inventory(output)
      wb.close()
      dropped = sorted(before_names - after_names)
      stripped_extensions = stripped_extension_markers(
          before_markers, after_markers, before_names & after_names
      )
      return dropped, stripped_extensions

  dropped, stripped = round_trip_changes("input.xlsx")
  if dropped or stripped:
      print("WARNING: saving with openpyxl will drop:", dropped)
      print("WARNING: saving with openpyxl will strip (part, marker):", stripped)
      # report to the user and get confirmation before the first save
  ```

  (openpyxl re-serializes every sheet it touches, so byte-identity of sheets is not a
  meaningful check; comparing each marker independently is what catches partial loss when, for
  example, `<extLst>` survives but its `x14:` content does not.)

## Rules

- `insert_rows`/`delete_rows` move cells but do **not** rewrite range references for you.
  Before structural edits, inventory cell formulas plus workbook defined names, tables,
  merged ranges, print areas/titles, autofilters, data validations, conditional formatting, and
  chart-series formulas as above.
  Refuse the insertion until every dependency that can intersect the shifted region has an
  explicit rewrite; after the edit, rerun both inventories and verify the expected references.
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
