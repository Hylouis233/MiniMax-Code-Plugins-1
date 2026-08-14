# Inspect a PDF (PyMuPDF)

```python
import fitz
doc = fitz.open("input.pdf")
print("pages:", doc.page_count)
print("encrypted:", doc.needs_pass, "| tagged:", doc.is_pdf, "pdf:", doc.is_pdf)
for page in doc:
    print(page.number, page.rect, "text_len:", len(page.get_text()),
          "images:", len(page.get_images()), "links:", len(page.get_links()))
```

## Checks worth automating

- **Blank page detection**: `len(page.get_text()) == 0 and not page.get_images()` -> flag; a
  blank page after generation usually means an overflowing flowable created an empty page.
- **Font inventory**: `page.get_fonts()` lists embedded names - needed when the user reports
  "looks different on machine X".
- **Page size consistency**: mixed `page.rect` sizes in one file break duplex printing; report
  it rather than silently normalizing.
- **Damage**: `fitz.open` on a corrupt file raises or yields garbage - pair with
  `pypdf.PdfReader` cross-check when provenance is unknown.

Report findings as a table (page, size, text chars, images, links) - it is what every
downstream decision hangs off.
