# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Inches, Pt

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


# ---- build the deck ------------------------------------------------------------
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[5])  # blank

box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1))
tf = box.text_frame
p = tf.paragraphs[0]
r1 = p.add_run()
r1.text = "old wording"
r2 = p.add_run()
r2.text = " linked part"
r2.font.italic = True
r2.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
r2.hyperlink.address = "https://example.com/docs"

table_shape = slide.shapes.add_table(2, 2, Inches(1), Inches(2.5), Inches(6), Inches(1))
table = table_shape.table
cell = table.cell(0, 1)
ctf = cell.text_frame
cp = ctf.paragraphs[0]
cr = cp.add_run()
cr.text = "old cell text"
cr.font.bold = True
cr.font.color.rgb = RGBColor(0x00, 0x70, 0xC0)

prs.save("input.pptx")

# ---- edit.md snippet: single-shape run replace keeps styling and hyperlink -----
prs = Presentation("input.pptx")
old, new = "old wording", "new wording"
candidates = []
for i, s in enumerate(prs.slides):
    for shape in s.shapes:
        if shape.has_text_frame and old in shape.text_frame.text:
            candidates.append((i, shape.name, shape))
assert len(candidates) == 1
_, _, target_shape = candidates[0]
tf = target_shape.text_frame
run_hits = [run for par in tf.paragraphs for run in par.runs if old in run.text]
assert len(run_hits) == 1
run_hits[0].text = run_hits[0].text.replace(old, new, 1)

edited_link = [run for par in tf.paragraphs for run in par.runs if run.hyperlink.address]
check("run replace keeps the other run's hyperlink", len(edited_link) == 1 and edited_link[0].hyperlink.address == "https://example.com/docs")
styled = [run for par in tf.paragraphs for run in par.runs if run.font.italic]
check("run replace keeps sibling run styling", len(styled) == 1 and styled[0].font.color.rgb == RGBColor(0xC0, 0x00, 0x00))
prs.save("edited.pptx")

# ---- edit.md snippet: table cell edited at run level ---------------------------
prs2 = Presentation("input.pptx")
old_cell, new_cell = "old cell text", "new cell text"
tbl = next(sh for sh in prs2.slides[0].shapes if sh.has_table).table
cell = tbl.cell(0, 1)
hits = [run for par in cell.text_frame.paragraphs for run in par.runs if old_cell in run.text]
assert len(hits) == 1, "target is duplicated or split across runs in this cell"
hits[0].text = hits[0].text.replace(old_cell, new_cell, 1)

prs2.save("cell-edited.pptx")
prs3 = Presentation("cell-edited.pptx")
cell3 = next(sh for sh in prs3.slides[0].shapes if sh.has_table).table.cell(0, 1)
after_runs = [run for par in cell3.text_frame.paragraphs for run in par.runs]
check("cell run edit keeps bold", any(r.font.bold for r in after_runs))
check("cell run edit keeps color", any(r.font.color and r.font.color.rgb == RGBColor(0x00, 0x70, 0xC0) for r in after_runs))
check("cell run edit changed the text", cell3.text_frame.text == "new cell text")

# the dangerous variant for contrast: assigning cell.text drops run properties
prs4 = Presentation("input.pptx")
tbl4 = next(sh for sh in prs4.slides[0].shapes if sh.has_table).table
tbl4.cell(0, 1).text = "new cell text"
prs4.save("cell-flattened.pptx")
prs5 = Presentation("cell-flattened.pptx")
flat_runs = [run for par in next(sh for sh in prs5.slides[0].shapes if sh.has_table).table.cell(0, 1).text_frame.paragraphs for run in par.runs]
check("cell.text assignment is proven lossy (negative control)", not any(r.font.bold for r in flat_runs))

# ---- analyze.md snippet: grouped-shape walker ----------------------------------
from pptx.oxml import parse_xml

prs6 = Presentation()
slide6 = prs6.slides.add_slide(prs6.slide_layouts[5])
pic_holder = slide6.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
pic_holder.text_frame.text = "nested member"

GRP = (
    '<p:grpSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    "<p:nvGrpSpPr><p:cNvPr id=\"901\" name=\"demo group\"/>"
    "<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
    "<p:grpSpPr><a:xfrm><a:off x=\"914400\" y=\"914400\"/>"
    '<a:ext cx="4572000" cy="914400"/>'
    '<a:chOff x="0" y="0"/><a:chExt cx="4572000" cy="914400"/></a:xfrm></p:grpSpPr>'
    "</p:grpSp>"
)


def iter_shapes(shapes):
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape


sp_element = slide6.shapes[-1]._element  # the textbox; layout 5 still carries a Title placeholder
group_element = parse_xml(GRP)
sp_element.getparent().replace(sp_element, group_element)
group_element.append(sp_element)

flat = list(iter_shapes(slide6.shapes))
check(
    "walker finds the shape nested in the group",
    any(getattr(sh, "text_frame", None) is not None and sh.text_frame.text == "nested member" for sh in flat),
)
check(
    "top-level shapes list hides the nested member (negative control)",
    not any(getattr(sh, "text_frame", None) is not None and sh.text_frame.text == "nested member" for sh in slide6.shapes),
)

# ---- analyze.md snippet: theme font resolution ---------------------------------
import re

prs7 = Presentation("input.pptx")
theme_xml = next(
    part.blob.decode("utf-8", "ignore")
    for part in prs7.part.package.iter_parts()
    if str(part.partname).startswith("/ppt/theme/")
)
major = re.search(r'<a:majorFont>\s*<a:latin typeface="([^"]*)"', theme_xml)
minor = re.search(r'<a:minorFont>\s*<a:latin typeface="([^"]*)"', theme_xml)
check("theme major/minor fonts resolve", bool(major) and bool(minor), (major and major.group(1), minor and minor.group(1)))
print("theme fonts:", major.group(1), "/", minor.group(1))

check(
    "unstyled runs report as inherited, not as a concrete face",
    all(run.font.name is None for sh in prs7.slides[0].shapes if sh.has_text_frame for par in sh.text_frame.paragraphs for run in par.runs),
)

print("\n" + ("ALL PPTX FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
