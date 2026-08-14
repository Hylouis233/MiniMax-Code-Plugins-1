# Create a deck (python-pptx)

## Skeleton with the seven workhorse slide patterns

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()               # 16:9 default in modern python-pptx; else set slide size
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)

blank = prs.slide_layouts[6]       # index 6 = Blank in the default template

def add_slide():
    return prs.slides.add_slide(blank)

# P1 title slide
s = add_slide()
box = s.shapes.add_textbox(Inches(0.8), Inches(2.6), Inches(11.7), Inches(1.6))
tf = box.text_frame; tf.word_wrap = True
p = tf.paragraphs[0]; p.text = "Service Reliability Review"; p.font.size = Pt(44); p.font.bold = True

# P2 bullet slide
s = add_slide()
box = s.shapes.add_textbox(Inches(0.8), Inches(1.2), Inches(11.7), Inches(5.6))
tf = box.text_frame; tf.word_wrap = True
lines = ["Uptime 99.97% (+0.04 vs last quarter)", "MTTR down to 42 minutes", "Two Sev-2 incidents, both capacity-driven"]
for i, line in enumerate(lines):
    par = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    par.text = line; par.font.size = Pt(24)
    par.space_after = Pt(12)

# P3 table slide
from pptx.util import Inches
s = add_slide()
rows, cols = 4, 3
tbl_shape = s.shapes.add_table(rows, cols, Inches(0.8), Inches(1.5), Inches(11.7), Inches(3.5))
table = tbl_shape.table
hdr = ["Region", "Error rate", "P99 latency"]
for j, text in enumerate(hdr):
    cell = table.cell(0, j); cell.text = text
    for par in cell.text_frame.paragraphs:
        for run in par.runs: run.font.bold = True

# P4 chart slide (real chart part, not a picture)
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
s = add_slide()
cd = CategoryChartData()
cd.categories = ["Jul", "Aug", "Sep"]
cd.add_series("Deploy count", (18, 22, 31))
graphic = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,
                             Inches(1.5), Inches(1.5), Inches(10), Inches(5), cd)
chart = graphic.chart
chart.has_legend = False

prs.save("deck.pptx")
```

## The seven patterns

| Pattern | Build with |
|---|---|
| Title / section divider | one large textbox, 40-48pt |
| Agenda / list | single textbox, 22-28pt, space_after 10-14pt |
| Bullets + callout | two textboxes: bullets left, highlight right |
| Image + text | `add_picture` (aspect-true) + textbox beside it |
| Data table | `add_table`, bold header row, zebra fills optional |
| Chart | `add_chart` with `CategoryChartData` |
| Quote / closing | centered italic 28-32pt + attribution 16pt |

## Rules

- Set slide size once up front (16:9 = 13.333 x 7.5 in) and stay inside 0.6in margins.
- Title top-left at a consistent y-position across content slides; consistency reads as design.
- Max ~6 bullets per slide, one line each at the chosen size - if a bullet wraps twice, split
  the slide or cut.
- Speaker notes: `slide.notes_slide.notes_text_frame.text = "..."` - put the script there,
  not on the slide.
- Do not touch masters/layouts unless asked; a restyled master changes every existing slide.
