# Minimal runnable fixtures for the snippets called out in review: one file per format.
# Each script is self-contained, writes only scratch files into the current directory,
# and exits non-zero on failed assertions. Run from any scratch directory:
#   python pdf_fixture.py   (deps: reportlab, pypdf, pymupdf)
#   python pptx_fixture.py  (deps: python-pptx)
#   python xlsx_fixture.py  (deps: openpyxl)
#   python docx_fixture.py  (deps: python-docx, pymupdf, soffice on PATH)
import copy
import subprocess
import sys

import fitz
from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ((" :: " + str(extra)) if not cond and extra else ""))
    if not cond:
        failures.append(name)


def list_number_num_id(doc):
    """The numId that the ListNumber style binds to in this document part."""
    styles = doc.part.element.body.getparent()  # document.xml root; styles live in another part
    styles_part = doc.part.part_related_by(RT.STYLES)
    for style in styles_part.element.findall(qn("w:style")):
        if style.get(qn("w:styleId")) == "ListNumber":
            numPr = style.find(qn("w:pPr") + "/" + qn("w:numPr"))
            if numPr is not None:
                return int(numPr.find(qn("w:numId")).get(qn("w:val")))
    raise LookupError("ListNumber style has no numPr")


def new_restart_num_id(doc, base_num_id):
    """Clone <w:num> base_num_id with a startOverride so the next list restarts at 1."""
    numbering = doc.part.part_related_by(RT.NUMBERING).element
    source = next(
        n for n in numbering.findall(qn("w:num"))
        if n.get(qn("w:numId")) == str(base_num_id)
    )
    clone = copy.deepcopy(source)
    new_id = max(int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))) + 1
    clone.set(qn("w:numId"), str(new_id))
    override = OxmlElement("w:lvlOverride")
    override.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:startOverride")
    start.set(qn("w:val"), "1")
    override.append(start)
    clone.append(override)
    numbering.append(clone)
    return new_id


def numbered_paragraph(doc, text, num_id):
    p = doc.add_paragraph(text, style="List Number")
    pPr = p._p.get_or_add_pPr()
    numPr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    numId = OxmlElement("w:numId")
    numId.set(qn("w:val"), str(num_id))
    numPr.append(ilvl)
    numPr.append(numId)
    pPr.append(numPr)
    return p


# ---- document A: naive reuse of List Number (second list continues) -----------
doc_a = Document()
doc_a.add_paragraph("First list")
for item in ("one", "two", "three"):
    doc_a.add_paragraph(item, style="List Number")
doc_a.add_paragraph("Second list, same style")
for item in ("four", "five", "six"):
    doc_a.add_paragraph(item, style="List Number")
doc_a.save("continuing.docx")

# ---- document B: second list restarts via cloned numbering definition ---------
doc_b = Document()
doc_b.add_paragraph("First list")
for item in ("one", "two", "three"):
    doc_b.add_paragraph(item, style="List Number")
doc_b.add_paragraph("Second list, restarted")
base_id = list_number_num_id(doc_b)
restart_id = new_restart_num_id(doc_b, base_id)
for item in ("four", "five", "six"):
    numbered_paragraph(doc_b, item, restart_id)
doc_b.save("restarted.docx")

# ---- structural assertions ------------------------------------------------------
numbering_b = doc_b.part.part_related_by(RT.NUMBERING).element
nums_b = numbering_b.findall(qn("w:num"))
check("cloned num entry exists", any(n.get(qn("w:numId")) == str(restart_id) for n in nums_b))
clone_entry = next(n for n in nums_b if n.get(qn("w:numId")) == str(restart_id))
override = clone_entry.find(qn("w:lvlOverride"))
check("clone carries startOverride=1 at ilvl 0",
      override is not None and override.get(qn("w:ilvl")) == "0"
      and override.find(qn("w:startOverride")).get(qn("w:val")) == "1")
second_list_num_ids = [
    p._p.find(qn("w:pPr") + "/" + qn("w:numPr") + "/" + qn("w:numId")).get(qn("w:val"))
    for p in doc_b.paragraphs[-3:]
]
check("restarted paragraphs reference the cloned numId", set(second_list_num_ids) == {str(restart_id)}, second_list_num_ids)

# ---- rendered proof via LibreOffice --------------------------------------------
subprocess.run(
    ["soffice", "--headless", "--convert-to", "pdf", "--outdir", ".", "continuing.docx", "restarted.docx"],
    check=True, capture_output=True, timeout=180,
)


def second_list_numbers(pdf_path):
    text = " ".join(page.get_text() for page in fitz.open(pdf_path))
    # take the rendered numbers in front of the second list's item words
    return [text.split(word)[0].split()[-1] for word in ("four", "five", "six")]


cont = second_list_numbers("continuing.pdf")
restart = second_list_numbers("restarted.pdf")
print("continuing.docx renders second list as:", cont)
print("restarted.docx renders second list as:", restart)
check("plain style reuse continues the sequence (negative control)", cont == ["4.", "5.", "6."], cont)
check("cloned definition restarts the second list at 1", restart == ["1.", "2.", "3."], restart)

print("\n" + ("ALL DOCX FIXTURES PASSED" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(0 if not failures else 1)
