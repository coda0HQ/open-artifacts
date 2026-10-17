# Artifact quality profile

Read this for an HTML Artifact that needs a stronger visual direction or a
quality review beyond the base Recipe contract. It complements, and never
replaces, [design.md](design.md), [interaction.md](interaction.md),
[motion.md](motion.md), and [canvas.md](canvas.md).

## Scope

Apply this profile by Artifact register, not by reflex:

- **Level 1 / product register:** preserve reading rhythm and familiar
  document structure. The quality floor is measure, contrast, honest content,
  and responsive text. Do not manufacture a hero or structural novelty.
- **Level 2 / product register:** preserve familiar controls and information
  density. Reachable interaction states, keyboard paths, and visible feedback
  matter more than visual novelty.
- **Level 3 / brand register:** add a named layout concept, select visual
  material deliberately, and test that repeated brand artifacts do not collapse
  into a color-swapped template.
- **Canvas:** use [canvas.md](canvas.md), not this page's scrolling-document
  layout rules. The runtime owns the transformed plane, zoom cluster, overflow,
  pointer routing, and mobile stacked read. This profile applies only inside an
  authored frame when it does not contradict that contract.

## Design brief

Before writing a Recipe, write this short brief in the generation task. It is
working context, not a Recipe field and not viewer content:

```text
Artifact read: <kind> for <audience>, optimized for <primary task>
Level/register: <1|2|3> / <product|brand>
Layout concept: <one sentence naming the information shape>
System: <light/dark surface posture> · <display/body roles> · <accent role>
Visual material: <none | data | diagram | CSS art | supplied asset>
Motion budget: <none | feedback only | one orchestrated moment>
Content provenance: <supplied | derived | labelled placeholder>
```

The brief is complete when every supplied fact is classified and the layout
concept describes information organization rather than a generic web page.
Examples: “a decision memo with an evidence table and a closing recommendation”
is a concept; “a clean dashboard” is not.

When the user has not supplied audience, primary task, or tone, infer them from
visible project context and state the inference once in the task's design note.
Do not block an isolated publishing workflow on an extra user round-trip.

## Level 3 critique

After composing a Level 3 brand artifact and before publishing, score the
output from 1 to 5 on these six axes:

1. **Philosophy** — the page takes a clear visual position appropriate to the
   brief.
2. **Hierarchy** — the eye finds primary, secondary, and supporting material
   immediately.
3. **Execution** — contrast, spacing, type, responsive behavior, and states
   are intentional rather than merely plausible.
4. **Specificity** — copy, visual material, and organization belong to this
   artifact rather than a category default.
5. **Restraint** — every flourish earns its place; one decisive move beats
   competing decoration.
6. **Variety** — when the project has multiple brand artifacts, the structure
   is not a superficial color swap of the latest one.

Revise the lowest axis whenever it is below 3. Keep this critique inside the
generation task; do not publish a score claim in the Artifact body.

## The 14-pass visual critique

Judge the rendered page visually (not by reading code intentions). Open the
rendered view at desktop width, then at 360px mobile width. Run each pass
independently:

1. **One second**: Glance and look away. What was seen? Exactly one focal
   point must register. If the answer is "a website", hierarchy has failed.
2. **Squint**: Defocus your eyes until text blurs into tone bars. The layout
   must resolve to 2–3 clear masses with distinct visual weight.
3. **Cover the logo / name**: Could this page belong to a competitor or another
   industry? If yes, it lacks a subject-derived idea. Inject what only this subject has.
4. **Edges**: Count distinct left alignment axes down the page. A composed page
   has 2–3 axes. Six axes means elements were placed one at a time.
5. **Space**: Are related elements grouped tightly and sections spaced generously?
   Section gap must clearly exceed intra-card gap. No accidental holes.
6. **Type**: Is display-to-body scale contrast ≥ 3x? Are there ≤ 5 distinct sizes?
   Are there any orphan words on the last line of headings?
7. **Colour**: 60-30-10 distribution. Is the accent color rare and meaningful
   (≤ 10%), or splashed across dozens of elements?
8. **Visual material**: Is real data, an authentic diagram, or a typographic
   set-piece present under strict CSP? Zero broken remote assets or lazy grey boxes.
9. **Sameness**: Do adjacent sections vary layout families (split, grid,
   prose, table), or does the page repeat the same 3-card skeleton?
10. **Cadence**: Is there rhythm between dense informational passages and
    breathing room?
11. **Mobile platform feel**: At 360px, are touch targets ≥ 44px? Is horizontal
    scroll eliminated? Do hover states stay stuck? Are inputs ≥ 16px?
12. **Copy honesty**: Are button labels explicit verb-noun phrases? Are AI buzzwords
    ("unlock", "supercharge", "seamless", "elevate") eliminated?
13. **Content authenticity**: Are all metrics, entities, and examples authentic to
    the brief? No fictional "Acme Corp" or fake "99.9%" stats.
14. **Restraint**: One accent hue, one orchestrated motion flourish, quiet
    everything else.

## Worst-case data resilience (break-UI stress test)

A fragile UI looks acceptable with ideal 3-word titles and collapses with real
data. Stress-test components against worst-case values before shipping:

### 1. Names, people, and locales
- **Long compound names**: `Aleksandra Wiśniewska-Kowalczyk`, `Christopher Alexander Montgomery III`. Must wrap gracefully; containers must not truncate initials or clip descenders.
- **Minimal strings**: `Jo`, `J`. One or two letters must not collapse card bounds or leave tiny unclickable hit areas.
- **Diacritics & stacked accents**: `Đặng Thị Ngọc Hân`, `Ólafur Darri Ólafsson`. Tight line-heights + `overflow: hidden` must not slice off top or bottom diacritics.
- **Non-Latin & mixed scripts**: `王秀英` (CJK without spaces, can break anywhere), `نور الهدى عبد الرحمن` (RTL alignment, directional icon placement with `dir="auto"`).
- **Emoji & surrogate pairs**: `🦊 Fox`, `👩🏽‍💻 Priya` (multi-codepoint ZWJ sequences). String slicing must not produce orphaned half-surrogates or replacement characters.

### 2. Unbreakable identifiers & URLs
- **Long emails & addresses**: `bartholomew.fitzgerald@northwind-industries-holdings.example.com`.
- **URLs & hashes**: `https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a`, `9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f`.
- Rule: Apply `overflow-wrap: anywhere` or `min-width: 0; text-overflow: ellipsis; overflow: hidden;` on table cells and flex children so unbreakable strings never force horizontal container expansion.

### 3. Numbers, counts, and currencies
- **Zero & negative numbers**: `0 items`, `-$1,420.50`. Ensure negative signs and zero states do not break alignments.
- **Massive counts**: `10,482`, `1,000,000+`. Container widths must accommodate 6+ digits without wrapping to a new line.
- **Tabular alignment**: Always apply `font-variant-numeric: tabular-nums` to numbers in tables, metrics, and timestamps so digits align vertically across rows.

### 4. Collection volume & states
- **Empty state**: Educational zero-state with a call to action. Never a blank box or "No data".
- **Single item**: Must not look abandoned or oddly stretched.
- **Dense volume**: 100+ items must scroll cleanly inside contained boxes (`overscroll-behavior: contain`) without page jitter.

## Structural choices for brand artifacts

Choose one information shape before building a Level 3 artifact. Do not force
this catalog onto a report, a product tool, or Canvas.

| Shape | Use when | Avoid when |
| --- | --- | --- |
| **Thesis** | One claim or launch message carries the Artifact. | The audience needs dense reference material. |
| **Evidence-led** | Real data, comparisons, or research findings carry the argument. | Numbers are missing or speculative. |
| **Guided walkthrough** | A product, workflow, or proposal is best understood step by step. | A static document is the actual task. |
| **Index** | Discovery across links, entries, or work items is the value. | The content needs a narrative. |
| **Narrative** | A memo, letter, case study, or argument should be read in sequence. | The audience needs to operate controls. |
| **Spatial map** | Relationships are more useful in two dimensions than in a scroll. | The mobile stacked read would destroy the central relationship. |

Within one brand artifact, use at least three appropriate section families:
prose, split evidence, table/list, quote, diagram, full-bleed statement, or
operable control. Do not repeat an identical card skeleton as the default
section grammar.

For a family of Level 3 artifacts, remember the last layout concept, visual
material choice, and section families in an optional project-local
`.artifacts/design-memory.local.json`. It is a generation note, never Recipe
metadata, must be bounded to the newest 20 entries, and must be written only by
the same serialized content-generation task that runs `create` or `update`.
Keep the identity system consistent; vary organization only when the brief
supports it.

## Visual-material decision

Typography-only is the default and a complete answer. Add material only when
removing it would make the Artifact less understandable.

1. **Data or diagram:** use an inline SVG chart, flow, timeline, map, or table
   when the brief supplies facts or relationships.
2. **CSS art:** use one small abstract or geometric construction when it makes
   the subject clearer without introducing an asset.
3. **Hand-built SVG:** use a labelled illustration or diagram when CSS cannot
   carry the structure cleanly.
4. **User-supplied asset:** embed it as a `data:` URI only when its provenance
   and role are clear.
5. **Generated still:** use only when the brief truly requires a scene that
   cannot be represented as data, type, CSS, or SVG. Label it as illustrative
   when it is not documentary.

The Artifact CSP still applies: no remote image, media, font, stylesheet, or
script URL. The profile never authorizes a runtime request.

For Level 3 motion, use one orchestrated moment at most. Every animation has a
one-sentence communication reason and a reduced-motion endpoint; see
[motion.md](motion.md).

## Static quality profile

The Recipe builder enforces the checks below for scrolling HTML. They are
intentionally conservative and do not apply to Canvas or Markdown:

- display headings are roman and declare `overflow-wrap: anywhere` plus
  `min-width: 0` when they use display-scale type;
- primary affordances marked by a CTA/primary class or `data-oa-primary` use
  `white-space: nowrap`;
- a Grid parent that contains image/video content uses `minmax(0, 1fr)` rather
  than a bare fraction track;
- a multi-column `.oa-section-head` containing an eyebrow and a heading
  collapses to one column at or before 48rem;
- a secondary `position: sticky; top: 0` is offset below a top sticky nav;
- fake browser, IDE, terminal, and phone chrome is rejected;
- colors and font-family declarations live in theme token blocks, not component
  rules.

Run the rendered check before publishing a scrolling HTML artifact whose scope
includes responsive design:

```sh
node "$ARTIFACT_CLI" smoke .artifacts/recipes/<name>.recipe.json
```

It renders at **320, 375, 414, and 768px**, failing on horizontal document
scroll or heading overflow. The command uses `agent-browser`; install it before
running the smoke check. Canvas uses its own ship gate in [canvas.md](canvas.md).

## Content and copy

Specificity is a visual material. Use supplied names, dates, decisions,
measurements, and sources. If a number, testimonial, logo, or result was not
supplied, omit it, ask for it, or label the gap plainly:

```text
— metric to confirm
Source pending
Illustrative example
```

Avoid generic opening claims such as “Built for the modern team,” “Unleash your
workflow,” “Seamless integration,” and “Next-generation platform.” Replace them
with a concrete subject, action, constraint, place, date, or observable result.

## Reference DNA is optional

When the user explicitly asks to learn from a screenshot or URL, read
[study.md](study.md) before inspecting it. The study is agent-side research:
it produces static design facts for a Recipe or `design.md`; the published
Artifact never fetches the reference.
