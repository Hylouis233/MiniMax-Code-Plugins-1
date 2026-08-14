# Extract from a PDF (PyMuPDF)

```python
import fitz  # pymupdf

doc = fitz.open("input.pdf")
print("pages:", doc.page_count, "metadata:", doc.metadata)

# Plain text, page by page
for page in doc:
    text = page.get_text("text")       # reading order text

# With coordinates (decide columns/reading order yourself)
for block in page.get_text("dict")["blocks"]:
    for line in block.get("lines", []):
        for span in line["spans"]:
            print(round(span["bbox"][0]), round(span["bbox"][1]), span["text"])

# Images
for i, info in enumerate(page.get_images(full=True)):
    pix = fitz.Pixmap(doc, info[0])
    pix.save(f"img-p{page.number}-{i}.png")

# Rasterize a page (for visual checks or OCR preprocessing)
pix = page.get_pixmap(dpi=150)
pix.save(f"page-{page.number}.png")
```

## Rules

- Scanned pages return empty `get_text`. Detect: first page text empty + images present ->
  report "scanned, needs OCR" instead of claiming there is no text.
- "Sort by position" before emitting tables: spans come in internal order, not visual order;
  sort by `(round(bbox[1]), bbox[0])` for top-to-bottom, left-to-right reading.
- Two-column layouts: cluster spans by x-gap before joining lines, or text interleaves columns.
- Never send the whole raw text to the user when asked for a summary; extract, then summarize
  with page references (`page 3` etc. derived from `page.number`).
