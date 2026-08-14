# Read / extract a DOCX

Pick by fidelity needed.

## Fast text extraction (pandoc, if installed)

```bash
pandoc -t markdown input.docx -o extracted.md
```

Best structural fidelity for prose (headings become markdown headings, tables become pipe
tables). Prefer this when the goal is content, not coordinates.

## Structured access (python-docx)

```python
from docx import Document
doc = Document("input.docx")
for par in doc.paragraphs:
    print(par.style.name, "|", par.text)
for t, table in enumerate(doc.tables):
    for r, row in enumerate(table.rows):
        print(t, r, [c.text for c in row.cells])
```

Notes:

- `doc.paragraphs` is body-level only. Text inside text boxes, headers, footers, footnotes is
  reached via their own collections (`section.header/.footer`) or raw XML.
- `doc.tables` is top-level only; nested tables require walking cells.
- For revision/comment metadata, inspect the XML parts directly: `word/comments.xml`,
  `w:ins`/`w:del` elements in `word/document.xml`.

## Reporting contract

When summarizing a document for the user, lead with: heading outline, paragraph count, table
count with dimensions, and any parts that could not be read. Do not silently skip unreadable
parts.
