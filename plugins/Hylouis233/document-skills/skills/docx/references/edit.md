# Edit an existing DOCX

Editing has two tiers. Pick the lowest tier that can express the change.

## Tier 1 - python-docx structural edits (preferred)

python-docx opens the real package and rewrites it safely. Use it for: adding/removing
paragraphs, tables, images; changing styles; editing text of a specific run; find-replace over
paragraph text.

```python
from docx import Document

doc = Document("input.docx")

# Address paragraphs by index over doc.paragraphs (body level). Tables' cells hold their own
# paragraphs: table.rows[i].cells[j].paragraphs
for i, par in enumerate(doc.paragraphs):
    if "TBD" in par.text:
        # Run-level replace keeps formatting of untouched runs
        for run in par.runs:
            if "TBD" in run.text:
                run.text = run.text.replace("TBD", "To be decided")

# Append content at a specific position: manipulate the XML tree
target = doc.paragraphs[7]._p
new_par = doc.add_paragraph("Inserted after the target.")
target.addnext(new_par._p)

doc.save("input.edited.docx")
```

## Tier 2 - raw OOXML surgery (only when Tier 1 cannot express it)

For field codes, sectPr surgery, tracked changes, or parts python-docx does not model.
Rules that keep the archive valid:

1. Operate on a **copy** of the file.
2. Unzip preserving structure: `python -m zipfile -e input.docx work/` or use `zipfile` in
   Python with `ZIP_DEFLATED` on repack.
3. Parse XML with `lxml`/`xml.etree` - never string replace. Text lives in `w:t` inside runs
   (`w:r`) inside paragraphs (`w:p`); a logical sentence can span several runs.
4. Repack with `[Content_Types].xml` first and stored/deflated entries only:

```python
import zipfile, pathlib
src = pathlib.Path("work")
with zipfile.ZipFile("output.docx", "w", zipfile.ZIP_DEFLATED) as z:
    for name in ["[Content_Types].xml"] + [p.name for p in src.rglob("*") if p.is_file()]:
        pass  # write real paths in archive order; see note
```

   Concretely, walk the tree and `z.write(p, p.relative_to(src).as_posix())`, writing
   `[Content_Types].xml` first. Do not add directories as entries, do not preserve absolute
   timestamps incorrectly (ZIP wants local time or 0).
5. If you touched part names or added parts, update `[Content_Types].xml` and
   `word/_rels/document.xml.rels` consistently - a mismatch here is the classic silent corrupt.

## Never do

- Blind find/replace on the raw XML string of `word/document.xml`.
- Deleting parts that look unused (styles, theme, settings) - viewers may require them.
- Editing a document that is open in Word (the save will collide with the lock file).

## Delivery

Save to `<original>-edited.docx` unless the user explicitly asked to overwrite. Run the
postcheck from SKILL.md step 4 on the output.
