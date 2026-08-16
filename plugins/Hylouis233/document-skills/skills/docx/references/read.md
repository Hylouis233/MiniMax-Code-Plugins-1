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
from docx.table import Table
from docx.text.paragraph import Paragraph

def iter_body_blocks(parent, document):
    """Yield ("p", paragraph) / ("table", table) blocks, recursing into block content controls."""
    for child in parent.iterchildren():
        if child.tag == qn("w:p"):
            yield ("p", Paragraph(child, document))
        elif child.tag == qn("w:tbl"):
            yield ("table", Table(child, document))
        elif child.tag == qn("w:sdt"):
            content = child.find(qn("w:sdtContent"))
            if content is not None:
                yield from iter_body_blocks(content, document)

def table_matrix(table):
    """Rows of cell text with merge structure preserved.

    python-docx's row.cells repeats a merge-origin cell across every grid
    position it spans, which hides the real structure. Walk the actual w:tc
    elements and annotate gridSpan/vMerge instead.
    """
    rows = []
    for row in table.rows:
        cells = []
        for tc in row._tr.tc_lst:
            tc_pr = tc.find(qn("w:tcPr"))
            grid_span = tc_pr.find(qn("w:gridSpan")) if tc_pr is not None else None
            v_merge = tc_pr.find(qn("w:vMerge")) if tc_pr is not None else None
            note = ""
            if grid_span is not None:
                note += "(span {})".format(grid_span.get(qn("w:val")))
            if v_merge is not None:
                note += "(vmerge start)" if v_merge.get(qn("w:val")) == "restart" else "(vmerge cont.)"
            text = "".join(node.text or "" for node in tc.iter(qn("w:t")))
            cells.append(text + note if note else text)
        rows.append(cells)
    return rows

doc = Document("input.docx")
content_controls = list(doc.element.body.iter(qn("w:sdt")))
print("block content controls:", len(content_controls))
for kind, block in iter_body_blocks(doc.element.body, doc):
    if kind == "p":
        print("p", block.style.name, "|", block.text)
    else:
        print("table", len(block.rows), "x", len(block.columns), table_matrix(block))
```

Notes:

- `doc.paragraphs` includes only direct body paragraphs and `doc.tables` only top-level
  tables; both omit content nested in block content controls (`w:sdt`). The walker above
  yields paragraphs and tables inside `w:sdtContent` too, and reports the content-control
  count. Tables nested inside table cells still require walking `cell.tables`; text boxes,
  headers, footers, and footnotes still require their own collections
  (`section.header/.footer`) or raw XML.
- For revision/comment metadata, inspect the XML parts directly: `word/comments.xml`,
  `w:ins`/`w:del` elements in `word/document.xml`.

## Reporting contract

When summarizing a document for the user, lead with: heading outline, paragraph count, table
count with dimensions, and any parts that could not be read. Do not silently skip unreadable
parts.
