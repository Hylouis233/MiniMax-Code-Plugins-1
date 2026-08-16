# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import csv
import io
import sys
import zipfile

import openpyxl

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


# ---- csv.md snippet: sniffed dialect actually reaches the reader ---------------
semicolon_csv = "region;units;note\nEU;120;first\nUS;80;second\n"
with open("input.csv", "w", newline="", encoding="utf-8") as f:
    f.write(semicolon_csv)

with open("input.csv", newline="", encoding="utf-8-sig") as f:
    sample = f.read(2048)
    f.seek(0)
    dialect = csv.Sniffer().sniff(sample)
    reader = csv.DictReader(f, dialect=dialect)
    rows = list(reader)

check("sniffer detects the semicolon dialect", dialect.delimiter == ";", dialect.delimiter)
check("rows parse into per-column values", rows[0] == {"region": "EU", "units": "120", "note": "first"}, rows[0])

# negative control: default comma reader splits the whole line as one key
with open("input.csv", newline="", encoding="utf-8-sig") as f:
    naive = next(csv.DictReader(f))
check("default reader is proven wrong here (negative control)", list(naive.keys())[0] == "region;units;note", naive)

# ---- csv.md conversion: formula-looking input remains literal text -----------
formula_looking = '=HYPERLINK("https://example.invalid", "click")'
csv_wb = openpyxl.Workbook()
csv_cell = csv_wb.active["A1"]
csv_cell.value = formula_looking
csv_cell.data_type = "s"
csv_wb.save("csv-text.xlsx")
csv_reopened = openpyxl.load_workbook("csv-text.xlsx", data_only=False)
check("formula-looking CSV field keeps its exact text", csv_reopened.active["A1"].value == formula_looking)
check("formula-looking CSV field is not an XLSX formula", csv_reopened.active["A1"].data_type == "s")

unsafe_wb = openpyxl.Workbook()
unsafe_wb.active["A1"] = formula_looking
check("plain assignment is proven unsafe (negative control)", unsafe_wb.active["A1"].data_type == "f")

# ---- edit.md snippet: round_trip_changes detects dropped parts AND stripped extensions ----
from io import BytesIO

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Data"
ws.append(["Region", "Units"])
ws.append(["EU", 120])
wb.save("plain.xlsx")

with zipfile.ZipFile("plain.xlsx") as zin:
    payload = {name: zin.read(name) for name in zin.namelist()}

# simulate an unsupported extension part (what a slicer/queries part looks like in the zip)
payload["xl/slicers/slicer1.xml"] = b"<slicer xmlns='stub'/>"

# simulate an in-part x14 extension that openpyxl will strip while keeping the part name
EXT = (b"<extLst><ext uri='{00000000-0000-0000-0000-000000000000}' "
       b"xmlns:x14='http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'>"
       b"<x14:stub/></ext></extLst>")
payload["xl/worksheets/sheet1.xml"] = payload["xl/worksheets/sheet1.xml"].replace(
    b"</worksheet>", EXT + b"</worksheet>")

with zipfile.ZipFile("extended.xlsx", "w", zipfile.ZIP_DEFLATED) as zout:
    for name, data in payload.items():
        zout.writestr(name, data)

EXTENSION_MARKERS = {
    "extLst": b"<extLst",
    "x14": b"x14:",
    "AlternateContent": b"mc:AlternateContent",
}


def stripped_extension_markers(before, after):
    return sorted(
        (name, label)
        for name in set(before) & set(after)
        for label, marker in EXTENSION_MARKERS.items()
        if marker in before[name] and marker not in after[name]
    )


def round_trip_changes(path, **load_options):
    with zipfile.ZipFile(path) as z:
        before = {name: z.read(name) for name in z.namelist()}
    wb = openpyxl.load_workbook(path, **load_options)  # same options as the real edit
    buf = BytesIO()
    wb.save(buf)
    with zipfile.ZipFile(buf) as z:
        after = {name: z.read(name) for name in z.namelist()}
    dropped = sorted(set(before) - set(after))
    stripped_extensions = stripped_extension_markers(before, after)
    return dropped, stripped_extensions


dropped, stripped = round_trip_changes("extended.xlsx")
check("injected slicer-like part is detected as dropped", "xl/slicers/slicer1.xml" in dropped, dropped)
check("in-part x14 extension strip is detected (same part name)",
      ("xl/worksheets/sheet1.xml", "x14") in stripped, stripped)
check("clean workbook reports nothing", round_trip_changes("plain.xlsx") == ([], []))
partial_before = {"xl/worksheets/sheet1.xml": b"<worksheet><extLst><x14:stub/></extLst></worksheet>"}
partial_after = {"xl/worksheets/sheet1.xml": b"<worksheet><extLst/></worksheet>"}
check(
    "marker comparison catches x14 loss while extLst survives",
    stripped_extension_markers(partial_before, partial_after)
    == [("xl/worksheets/sheet1.xml", "x14")],
    stripped_extension_markers(partial_before, partial_after),
)

# ---- formatting.md snippet: sheet references built from the real sheet title -------
wb_f = openpyxl.Workbook()
src = wb_f.active
src.title = "Raw Data"          # space forces quoting
src.append(["Region", "Units", "Price"])
src.append(["EU", 3, 10])
src.append(["US", 4, 20])
agg = wb_f.create_sheet("ByRegion")


def sheet_ref(sheet):
    escaped = sheet.title.replace("'", "''")
    return f"'{escaped}'!"


ref = sheet_ref(src)
agg.append(["Region", "Units"])
agg["A2"] = "EU"
agg["B2"] = f"=SUMIF({ref}A:A,A2,{ref}B:B)"
wb_f.save("agg.xlsx")
wb_g = openpyxl.load_workbook("agg.xlsx")
check("formula references the real sheet name", wb_g["ByRegion"]["B2"].value == "=SUMIF('Raw Data'!A:A,A2,'Raw Data'!B:B)", wb_g["ByRegion"]["B2"].value)
apostrophe_sheet = wb_f.create_sheet("O'Brien")
apostrophe_sheet["A1"] = 1
agg["B3"] = f"=SUM({sheet_ref(apostrophe_sheet)}A:A)"
wb_f.save("apostrophe-agg.xlsx")
apostrophe_formula = openpyxl.load_workbook("apostrophe-agg.xlsx")["ByRegion"]["B3"].value
check(
    "quoted sheet reference doubles apostrophes",
    apostrophe_formula == "=SUM('O''Brien'!A:A)",
    apostrophe_formula,
)
hyphen_sheet = wb_f.create_sheet("Q1-Data")
hyphen_sheet["A1"] = 1
agg["B4"] = f"=SUM({sheet_ref(hyphen_sheet)}A:A)"
wb_f.save("hyphen-agg.xlsx")
hyphen_formula = openpyxl.load_workbook("hyphen-agg.xlsx")["ByRegion"]["B4"].value
check("ambiguous punctuation is protected by quoting", hyphen_formula == "=SUM('Q1-Data'!A:A)", hyphen_formula)

# Falsey values are valid categories; blank filtering must not discard or conflate them.
falsey_ws = openpyxl.Workbook().active
for value in ("Category", 0, False, "", None, 0, False):
    falsey_ws.append([value])
regions = []
seen_region_keys = set()
for (region,) in falsey_ws.iter_rows(min_row=2, min_col=1, max_col=1, values_only=True):
    if region is None or region == "":
        continue
    key = (type(region), region)
    if key not in seen_region_keys:
        seen_region_keys.add(key)
        regions.append(region)
check(
    "aggregation preserves numeric zero and boolean false as distinct categories",
    len(regions) == 2
    and type(regions[0]) is int and regions[0] == 0
    and type(regions[1]) is bool and regions[1] is False,
    [(type(value).__name__, value) for value in regions],
)

# and the edit itself still works after the warning path
wb2 = openpyxl.load_workbook("plain.xlsx")
wb2["Data"]["B2"] = "=B2*1"  # formula stays a formula
wb2["Data"]["B2"].number_format = "#,##0.00"
wb2.save("edited.xlsx")
wb3 = openpyxl.load_workbook("edited.xlsx")
check("edited cell keeps a formula string", isinstance(wb3["Data"]["B2"].value, str) and wb3["Data"]["B2"].value.startswith("="))
expected_number_formats = {"Data": {"B2": "#,##0.00"}}
format_matches = all(
    wb3[sheet][coordinate].number_format == expected
    for sheet, cells in expected_number_formats.items()
    for coordinate, expected in cells.items()
)
check("task-specific number format mapping is verified", format_matches)

# ---- read.md snippet: multi-sheet profiles cover every sheet ----------------------
wb_h = openpyxl.Workbook()
wb_h.active.title = "First"
wb_h.active["A1"] = "=1+1"
second = wb_h.create_sheet("Second")
second["A1"] = "plain"
second["A2"] = "=2+2"
wb_h.save("multi.xlsx")
formula_wb = openpyxl.load_workbook("multi.xlsx", read_only=True, data_only=False)
value_wb = openpyxl.load_workbook("multi.xlsx", read_only=True, data_only=True)
profiled = list(value_wb.sheetnames)
uncached = {sn for sn in profiled
            for frow, vrow in zip(formula_wb[sn].iter_rows(), value_wb[sn].iter_rows())
            for fc, vc in zip(frow, vrow)
            if isinstance(fc.value, str) and fc.value.startswith("=") and vc.value is None}
check("multi-sheet profile iterates every sheet", profiled == ["First", "Second"], profiled)
check("uncached formulas found on both sheets", uncached == {"First", "Second"}, uncached)
formula_wb.close()
value_wb.close()

print("\n" + ("ALL XLSX FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
