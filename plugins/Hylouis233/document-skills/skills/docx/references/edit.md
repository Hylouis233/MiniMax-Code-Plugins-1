# Edit an existing DOCX

Editing has two tiers. Pick the lowest tier that can express the change.

## Tier 1 - python-docx structural edits (preferred)

python-docx opens the real package and rewrites it safely. Use it for: adding/removing
paragraphs, tables, images; changing styles; editing text of a specific run; find-replace over
paragraph text.

```python
from docx import Document

def replace_across_runs(paragraph, old, new):
    """Replace non-overlapping matches, including matches split across runs."""
    if not old:
        raise ValueError("old must not be empty")

    runs = list(paragraph.runs)
    text = "".join(run.text for run in runs)
    starts = []
    position = 0
    while (start := text.find(old, position)) != -1:
        starts.append(start)
        position = start + len(old)

    # Map each non-empty run to its character range in the original paragraph text.
    spans = []
    position = 0
    for index, run in enumerate(runs):
        end = position + len(run.text)
        if end > position:
            spans.append((index, position, end))
        position = end

    # Work backwards so changing a later match cannot move an earlier match.
    for start in reversed(starts):
        end = start + len(old)
        first, first_start, _ = next(s for s in spans if s[1] <= start < s[2])
        last, last_start, _ = next(s for s in spans if s[1] < end <= s[2])
        prefix = runs[first].text[:start - first_start]
        suffix = runs[last].text[end - last_start:]

        if first == last:
            runs[first].text = prefix + new + suffix
        else:
            runs[first].text = prefix + new
            for index in range(first + 1, last):
                runs[index].text = ""
            runs[last].text = suffix

    return len(starts)

doc = Document("input.docx")

# Address paragraphs by index over doc.paragraphs (body level). Tables' cells hold their own
# paragraphs: table.rows[i].cells[j].paragraphs
for par in doc.paragraphs:
    replace_across_runs(par, "TBD", "To be decided")

# Append content at a specific position: manipulate the XML tree
target = doc.paragraphs[7]._p
new_par = doc.add_paragraph("Inserted after the target.")
target.addnext(new_par._p)

doc.save("input.edited.docx")
```

The replacement text inherits the first matched run's formatting. Unmatched text before and
after it stays in its original runs, so its formatting is preserved. Use raw OOXML for fields,
tracked changes, or other content that `paragraph.runs` does not expose.

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
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

src = Path("work")
content_types = src / "[Content_Types].xml"
if not content_types.is_file():
    raise FileNotFoundError(content_types)

files = sorted(
    (path for path in src.rglob("*") if path.is_file() and path != content_types),
    key=lambda path: path.relative_to(src).as_posix(),
)

with ZipFile(
    "output.docx", "w", compression=ZIP_DEFLATED, strict_timestamps=False
) as archive:
    archive.write(content_types, "[Content_Types].xml")
    for path in files:
        archive.write(path, path.relative_to(src).as_posix())
```

   This writes relative POSIX archive names, does not add directory entries, and excludes
   `[Content_Types].xml` from the remaining files so it cannot be added twice.
5. If you touched part names or added parts, update `[Content_Types].xml` and
   `word/_rels/document.xml.rels` consistently - a mismatch here is the classic silent corrupt.

## Never do

- Blind find/replace on the raw XML string of `word/document.xml`.
- Deleting parts that look unused (styles, theme, settings) - viewers may require them.
- Editing a document that is open in Word (the save will collide with the lock file).

## Delivery

Save to `<original>-edited.docx` unless the user explicitly asked to overwrite. Run the
postcheck from SKILL.md step 4 on the output.
