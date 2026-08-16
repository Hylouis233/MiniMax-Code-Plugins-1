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
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph

def iter_body_paragraphs(parent, document):
    """Yield direct body paragraphs plus paragraphs nested in block content controls."""
    for child in parent.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, document)
        elif child.tag == qn("w:sdt"):
            content = child.find(qn("w:sdtContent"))
            if content is not None:
                yield from iter_body_paragraphs(content, document)

doc = Document("input.docx")
content_controls = list(doc.element.body.iter(qn("w:sdt")))
print("block content controls:", len(content_controls))
for par in iter_body_paragraphs(doc.element.body, doc):
    print(par.style.name, "|", par.text)
for t, table in enumerate(doc.tables):
    for r, row in enumerate(table.rows):
        print(t, r, [c.text for c in row.cells])
```

Notes:

- `doc.paragraphs` includes only direct body paragraphs; it omits paragraphs nested in block
  content controls (`w:sdt`). Use the traversal above and report the content-control count.
  Text boxes, headers, footers, and footnotes still require their own collections
  (`section.header/.footer`) or raw XML.
- `doc.tables` is top-level only; nested tables require walking cells.
- For revision/comment metadata, inspect the XML parts directly: `word/comments.xml`,
  `w:ins`/`w:del` elements in `word/document.xml`.

## Reporting contract

When summarizing a document for the user, lead with: heading outline, paragraph count, table
count with dimensions, and any parts that could not be read. Do not silently skip unreadable
parts.
