# Analyze / triage a deck

## Content inventory

```python
from pptx import Presentation
prs = Presentation("input.pptx")
print("slide size:", prs.slide_width, prs.slide_height)
for i, slide in enumerate(prs.slides):
    layout = slide.slide_layout.name
    title = slide.shapes.title.text_frame.text if slide.shapes.title is not None else ""
    notes = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    n_tables = sum(1 for sh in slide.shapes if sh.has_table)
    n_charts = sum(1 for sh in slide.shapes if sh.has_chart)
    n_pics = sum(1 for sh in slide.shapes if sh.shape_type == 13)
    print(i, layout, repr(title[:40]), "tables:", n_tables, "charts:", n_charts,
          "pics:", n_pics, "notes:", len(notes))
```

(Simplify the title lookup to `slide.shapes.title` when present; the defensive loop is for
layouts where the title placeholder is missing.)

## Triage: deck renders wrong

| Symptom | Check | Fix |
|---|---|---|
Text overflows the slide edge | shape left+width vs `prs.slide_width` | move/resize the shape, or shrink font |
Everything shifted | slide size changed between sources | normalize slide size or re-layout on the target size |
Fonts look wrong elsewhere | non-embedded fonts (pptx rarely embeds) | report referenced fonts (`run.font.name`) |
File will not open | broken ZIP / part mismatch | same programmatic health check as DOCX: `zipfile.testzip()`, parse every `.xml` part |
Pictures blank | media parts missing or rels broken | verify `ppt/media/*` present and slide rels reference them |

## Report contract

Summarize: slide count, per-slide one-line inventory, then findings ranked by user impact.
Extraction for repurposing goes to markdown with speaker notes preserved as blockquotes.