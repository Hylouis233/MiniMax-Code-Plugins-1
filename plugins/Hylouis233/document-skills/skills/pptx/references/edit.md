# Edit an existing deck

## Locate by content, then edit narrowly

```python
from pptx import Presentation
from pptx.util import Pt

prs = Presentation("input.pptx")

target_slide, target_shape = None, None
for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame and "old wording" in shape.text_frame.text:
            target_slide, target_shape = slide, shape

assert target_shape is not None, "target text not found - report instead of guessing"

# Replace whole-paragraph text but keep the first run's formatting
tf = target_shape.text_frame
for par in tf.paragraphs:
    if "old wording" in par.text:
        template_run = par.runs[0] if par.runs else None
        par.text = par.text.replace("old wording", "new wording")
        if template_run is not None:
            for run in par.runs:
                run.font.size = template_run.font.size
                run.font.bold = template_run.font.bold

prs.save("input-edited.pptx")
```

## Rules

1. **Never rebuild the file to make a small change.** Rewriting slides from scratch loses the
   template, masters, notes, and animations. Edit in place, save to a new path.
2. Address shapes by slide index + shape name or matched text, and **assert the match** - a
   silent no-op edit is worse than a loud failure.
3. Table cells: `table.cell(r, c).text = ...`; keep the change inside the cell's text frame so
   its formatting survives.
4. Chart data: `chart.replace_data(CategoryChartData(...))` updates the embedded workbook and
   the plot together - do not hand-edit the XML series.
5. Reordering slides means moving the underlying `sldIdLst` entries; do it only on request and
   verify order in the postcheck.
6. Group shapes: iterate `shape.shapes` recursively to reach members; python-pptx will not
   ungroup for you - do not try to flatten groups.
