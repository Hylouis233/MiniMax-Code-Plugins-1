# Analyze / triage a deck

## Content inventory

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

def iter_shapes(shapes):
    """Walk shapes recursively so content nested inside group shapes is counted too."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shape.shapes)
        else:
            yield shape

prs = Presentation("input.pptx")
print("slide size:", prs.slide_width, prs.slide_height)
for i, slide in enumerate(prs.slides):
    layout = slide.slide_layout.name
    title = slide.shapes.title.text_frame.text if slide.shapes.title is not None else ""
    notes = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    shapes = list(iter_shapes(slide.shapes))   # flattened; groups are common in template decks
    n_tables = sum(1 for sh in shapes if sh.has_table)
    n_charts = sum(1 for sh in shapes if sh.has_chart)
    n_pics = sum(1 for sh in shapes if sh.shape_type == MSO_SHAPE_TYPE.PICTURE)
    print(i, layout, repr(title[:40]), "tables:", n_tables, "charts:", n_charts,
          "pics:", n_pics, "notes:", len(notes))
```

(Simplify the title lookup to `slide.shapes.title` when present; the defensive loop is for
layouts where the title placeholder is missing.)

## Triage: deck renders wrong

| Symptom | Check | Fix |
|---|---|---|
| Shape crosses the slide edge | compare all four shape bounds with the slide bounds | move or resize the shape |
| Text is clipped or overflows its box | render every slide and inspect right/left and bottom/vertical fit; shape bounds do not measure laid-out text | reflow, resize the box, or reduce text/font size, then render again |
| Everything shifted | slide size changed between sources | normalize slide size or re-layout on the target size |
| Fonts look wrong elsewhere | non-embedded fonts (pptx rarely embeds) | report every effective font via the resolution chain below, not just explicit `run.font.name` values |
| File will not open | broken ZIP / part mismatch | same programmatic health check as DOCX: `zipfile.testzip()`, parse every `.xml` part |
| Pictures blank | media parts missing or rels broken | verify `ppt/media/*` present and slide rels reference them |

## Font triage with inheritance

Most template decks set no explicit `run.font.name`; the effective face is inherited from the
placeholder, layout, master, or theme. Resolve what you can and name the fallback explicitly:

```python
import re
from pptx import Presentation

prs = Presentation("deck.pptx")

# 1. Theme fonts are the final fallback for inherited text.
theme_xml = next(
    part.blob.decode("utf-8", "ignore")
    for part in prs.part.package.iter_parts()
    if str(part.partname).startswith("/ppt/theme/")
)
theme = {
    "major (headings)": re.search(r'<a:majorFont>\s*<a:latin typeface="([^"]*)"', theme_xml),
    "minor (body)": re.search(r'<a:minorFont>\s*<a:latin typeface="([^"]*)"', theme_xml),
}
theme_faces = {
    kind: match.group(1) if match else "(not set)"
    for kind, match in theme.items()
}
for kind, face in theme_faces.items():
    print("theme", kind, "->", face)

# 2. Per run: explicit value, else paragraph defaults, else report as inherited.
for i, slide in enumerate(prs.slides):
    for shape in iter_shapes(slide.shapes):
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                if run.font.name:
                    face, source = run.font.name, "run"
                elif paragraph.font.name:
                    face, source = paragraph.font.name, "paragraph defaults"
                else:
                    face = f"major={theme_faces['major (headings)']}; minor={theme_faces['minor (body)']}"
                    source = "inherited candidate (verify placeholder/layout/master chain)"
                print(i, shape.name, repr(run.text[:20]), "font:", face, "source:", source)
```

python-pptx does not evaluate the full placeholder -> layout -> master inheritance chain; when
a run reports inherited, list the theme fallback above and, if the exact face matters, check
the layout and master placeholder of the same index for an explicit `<a:latin typeface>`.

## Text-fit verification

`python-pptx` exposes a text box's geometry, not the renderer's final glyph and line layout.
After any text or layout change, render all slides with the fonts used in production:

```bash
python -c "from pathlib import Path; Path('deck-render').mkdir(exist_ok=True)"
soffice --headless --convert-to pdf --outdir deck-render input.pptx
```

Inspect every page of `deck-render/input.pdf` for horizontal clipping and for the final line being
clipped or missing at the bottom. Rasterize the PDF when image inspection is easier. If this must
be an automated gate, use measured text bounds from a native renderer in both axes;
`shape.left + shape.width` is only a slide-boundary check, not an overflow test.

## Report contract

Summarize: slide count, per-slide one-line inventory, then findings ranked by user impact.
Extraction for repurposing goes to markdown with speaker notes preserved as blockquotes.
