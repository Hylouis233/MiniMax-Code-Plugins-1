# Document Skills

## The problem

Users keep asking coding agents for document deliverables — a Word report, a PDF handout, a slide
deck, a data workbook — and get unreliable results: ZIP files rewritten by hand and corrupted,
spreadsheets where formulas were typed as text, slide decks that no viewer opens, PDFs that are a
stack of screenshots instead of text. Office and PDF documents are container formats with strict
internal contracts, and an agent without format knowledge breaks them silently.

This Plugin installs four workbench Skills — `docx`, `pdf`, `pptx`, `xlsx` — that route each
task to the right standard tool (python-docx, python-pptx, openpyxl, pypdf, ReportLab, PyMuPDF),
enforce the container contracts (valid ZIP, correct content types, calculated dimensions), and
verify output before it is handed back.

## Try it

```text
Use the document-skills plugin: open sales-2024.xlsx, add a sheet "Summary" with per-region
totals computed by formula, a bar chart of the top 5 products, and currency formatting.
```

Expected result: the agent loads the workbook with openpyxl, inspects sheet names, headers, and
dtypes, writes `SUMIF`/`COUNTIF` formulas (not pasted values), adds a native `BarChart` anchored
to the new sheet, applies number formats, and reports the cell ranges it changed.

```text
Use the document-skills plugin: create a PDF one-pager "Q3 launch checklist" from this outline
with a title block and a two-column checklist that fits exactly one A4 page.
```

Expected result: the agent generates the page with ReportLab flowables on an A4 canvas, measures
the checklist blocks, and confirms with pypdf that the output is exactly 1 page with extractable
text — not a screenshot.

## What the Skills do

Shared spine (all four Skills follow it):

1. Classify the request as **create**, **read**, **edit**, or **review**.
2. Check tool availability first and report missing dependencies instead of improvising.
3. Follow format-specific rules (packages below).
4. Run the post-generation verification checklist; fix and re-verify until it passes.
5. Report the output path, the page/sheet/slide inventory, and any remaining caveats.

Per format:

- **docx** — create with python-docx from a heading outline; edit existing files by direct
  `word/document.xml` surgery (python-docx cannot open-and-save arbitrary files losslessly);
  extract text with python-docx or `pandoc -t markdown`; postcheck with python-docx re-open and
  `soffice --headless --convert-to` PDF smoke test when LibreOffice is present.
- **xlsx** — openpyxl for reading, editing, styling, and native charts; formulas as formulas,
  never as pasted results; `data_only=True` only for reading cached values; date/number formats
  applied explicitly; recalculation contract documented (openpyxl writes formulas, the viewer
  calculates).
- **pptx** — python-pptx to build decks (7 common slide patterns: title, agenda, bullet, two
  image+text, table, chart, quote/closing); edit only named, existing shapes, never blind
  rewriting of the whole XML; text measured against shape width with font-size reduction rules;
  presentation-level verification via `python-pptx` re-open plus a rendered PDF smoke test when
  LibreOffice is available.
- **pdf** — creation prefers ReportLab (structured, accessible text) over HTML-to-print paths;
  extraction and splitting/merging with pypdf; analysis and rasterization with PyMuPDF; explicit
  one-tool-per-job table so the agent stops mixing libraries mid-task.

## Verification-first output

Every Skill ends with the same rule: do not hand back a file you have not re-opened. The checklists
are specific (re-open the archive, confirm the sheet count and formula presence, confirm the slide
count, confirm page count and text extraction) and the Skills require reporting what was verified
versus what was assumed.

## Requirements

- Python 3.9+ with `python-docx`, `python-pptx`, `openpyxl`, `pypdf`, `reportlab`,
  `pymupdf` (`pip install python-docx python-pptx openpyxl pypdf reportlab pymupdf`).
- Optional: LibreOffice (`soffice`) for PDF smoke tests of DOCX/PPTX output; `pandoc` for
  markdown extraction from DOCX.
- Works on Windows, macOS, and Linux. All commands are given in cross-platform form; the Skills
  say how to resolve the skill directory path on each platform.

## Data and network

- No network access. All processing is local file conversion and generation.
- No credentials required.
- The Skills only read and write document files the user points at; temporary files go to the
  system temp directory and are cleaned up.

## License

Apache-2.0. See [LICENSE](LICENSE).
