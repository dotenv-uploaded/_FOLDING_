---
version: 1.0
name: Folding-design-system
description: A cool-navy desktop workspace for Folding, a local-first document wiki. The system anchors on a pure-white canvas with a single saturated brand blue (#2B5DFD, sampled from the folder mark) and a cool navy ink ramp (#0D1630, sampled from the wordmark). Brand voltage comes from restraint — blue appears only on the one primary action, on citations, and on the active chat row; everything else is navy-tinted neutral. Type is Pretendard for both Latin and Hangul with JetBrains Mono reserved for data (paths, counts, timestamps). Chrome is quiet because the documents are the content.

colors:
  primary: "#2B5DFD"
  primary-hover: "#1E48E0"
  primary-active: "#1838B4"
  primary-deep: "#16298C"
  primary-soft: "#5C86FE"
  primary-softer: "#8DAEFE"
  primary-tint: "#BBCCFF"
  primary-wash: "#DCE6FF"
  primary-wash-soft: "#EEF3FF"
  ink: "#0D1630"
  ink-900: "#141E3D"
  body: "#1F2A4D"
  body-soft: "#2E3A5E"
  ink-600: "#465172"
  muted: "#5B6480"
  subtle: "#8A92AB"
  ink-300: "#B4BACB"
  border-strong: "#D6DAE4"
  border-default: "#E4E7EE"
  hairline: "#EEF0F4"
  surface-subtle: "#F7F8FA"
  canvas: "#FFFFFF"
  success: "#16A46B"
  success-strong: "#0E8A57"
  success-wash: "#E7F7EF"
  warning: "#F5A623"
  warning-strong: "#D2860B"
  warning-wash: "#FEF4E2"
  error: "#E5484D"
  error-strong: "#CE3439"
  error-wash: "#FDEBEC"

typography:
  display:
    fontFamily: "Pretendard"
    fontSize: 48px
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: -0.02em
  h1:
    fontFamily: "Pretendard"
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: -0.02em
  h2:
    fontFamily: "Pretendard"
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.02em
  h3:
    fontFamily: "Pretendard"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.02em
  body:
    fontFamily: "Pretendard"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.01em
  body-chat:
    fontFamily: "Pretendard"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: -0.01em
  label:
    fontFamily: "Pretendard"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: -0.01em
  mono:
    fontFamily: "JetBrains Mono"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  eyebrow:
    fontFamily: "Pretendard"
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.08em
    textTransform: uppercase

spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  section: 112px
  gutter: 24px

rounded:
  xs: 4px
  sm: 6px
  md: 10px
  lg: 14px
  xl: 18px
  2xl: 24px
  3xl: 32px
  pill: 999px

shadows:
  xs: "0 1px 2px rgba(13,22,48,.06)"
  sm: "0 1px 3px rgba(13,22,48,.08), 0 1px 2px rgba(13,22,48,.04)"
  md: "0 6px 16px rgba(13,22,48,.08), 0 2px 4px rgba(13,22,48,.04)"
  lg: "0 16px 36px rgba(13,22,48,.10), 0 4px 8px rgba(13,22,48,.05)"
  xl: "0 28px 64px rgba(13,22,48,.14), 0 8px 16px rgba(13,22,48,.06)"
  brand: "0 10px 26px rgba(43,93,253,.30)"
  brand-sm: "0 4px 12px rgba(43,93,253,.22)"
  focus: "0 0 0 3px rgba(43,93,253,.35)"

motion:
  ease-standard: "cubic-bezier(.2,.6,.2,1)"
  ease-out: "cubic-bezier(.16,1,.3,1)"
  ease-in-out: "cubic-bezier(.65,0,.35,1)"
  duration-fast: 120ms
  duration-base: 200ms
  duration-slow: 320ms

layout:
  pane-chatlist: 260px
  pane-tree: 320px
  topbar: 56px
  container-max: 1200px
  container-narrow: 760px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    boxShadow: "{shadows.brand-sm}"
    borderRadius: "{rounded.lg}"
    height: 42px
    padding: "0 20px"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    border: "1px solid {colors.border-strong}"
    boxShadow: "{shadows.xs}"
    borderRadius: "{rounded.lg}"
  card:
    backgroundColor: "{colors.canvas}"
    border: "1px solid {colors.hairline}"
    borderRadius: "{rounded.xl}"
    boxShadow: "{shadows.xs}"
  input:
    backgroundColor: "{colors.canvas}"
    border: "1px solid {colors.border-default}"
    borderRadius: "{rounded.md}"
    textColor: "{colors.ink-900}"
    focusBoxShadow: "{shadows.focus}"
  badge:
    borderRadius: "{rounded.pill}"
    typography: "{typography.eyebrow}"
    height: 20px
  message-user:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.ink}"
    borderRadius: "{rounded.lg}"
    padding: "10px 16px"
    maxWidth: "80%"
---

## Overview

Folding is a **local-first document wiki** that runs as a desktop app. Everything the user cares about — their own documents — lives in the middle of the screen, so the chrome around it is deliberately quiet. The canvas is pure white (`{colors.canvas}`), not a tinted off-white: the app sits next to Word and 한글 windows all day and any warm tint would read as "stale" beside them.

The palette is **one blue on a cool navy ramp**. Brand blue (`{colors.primary}` — #2B5DFD) is sampled from the folder mark; the ink ramp descends from #0D1630, sampled from the wordmark. Both come from the same source artwork, which is why the neutrals feel blue-adjacent rather than gray — shadows are navy-tinted (`rgba(13,22,48,…)`), never black.

Blue is **rationed**. It appears on exactly three things: the single primary action on screen, citation chips (evidence the user can click through to the original), and the active chat row. Everything else — panels, borders, tree rows, tool badges — is neutral. When a document answer arrives with a blue citation attached, that blue means *"this is verifiable"*, and it only carries that meaning because nothing else competes for it.

Type is **Pretendard for everything** (Latin and Hangul from one variable file, weight axis 45–920) with **JetBrains Mono reserved for data** — file paths, counts, timestamps, build IDs. If a number is machine-produced, it is mono; if a human wrote it, it is sans. Fonts are self-hosted rather than CDN-loaded because the wiki exists only on the user's disk and the app must render identically with the network off.

**Key Characteristics:**
- Pure white canvas (`{colors.canvas}`) with cool navy ink (`{colors.ink}` — #0D1630). No warm tint anywhere.
- One saturated brand blue (`{colors.primary}` — #2B5DFD), rationed to primary action, citations, active row.
- Navy-tinted shadows (`rgba(13,22,48,…)`) — a black shadow on a white canvas looks like dirt; the navy tint keeps elevation in the same color family as the ink.
- Pretendard variable (45–920) covers Latin + Hangul from one file. JetBrains Mono only for machine-produced values.
- Self-hosted webfonts — the app works offline by design, so no CDN dependency.
- Three-pane desktop shell at fixed widths: chat list `{layout.pane-chatlist}` / conversation `1fr` / document tree `{layout.pane-tree}`.
- Hairline borders (`{colors.hairline}` — #EEF0F4) do the separating; shadows are for genuine elevation only.
- 4px spacing base, radii from 4px to 32px with a clear size→radius pairing.
- Motion is short and flat: `{motion.duration-fast}` for state changes, no bounce, no overshoot on interactive elements.

## Colors

### Brand & Accent
- **Brand Blue** (`{colors.primary}` — #2B5DFD): The primary action, citation chips, active chat row. Sampled from the folder mark. Rationed on purpose — see Do's and Don'ts.
- **Blue Hover** (`{colors.primary-hover}` — #1E48E0): One step darker. Hover state on primary surfaces.
- **Blue Active** (`{colors.primary-active}` — #1838B4): Press state, one step darker again.
- **Blue Wash** (`{colors.primary-wash-soft}` — #EEF3FF): The tinted background behind subtle buttons ("새 채팅"), the active chat row, and inline blue callouts.
- **Blue Tint** (`{colors.primary-tint}` — #BBCCFF): Text selection background (`::selection`).

### Surface
- **Canvas** (`{colors.canvas}` — #FFFFFF): The page floor and card background. Same value for both — separation comes from hairlines, not fills.
- **Surface Subtle** (`{colors.surface-subtle}` — #F7F8FA): Hover fills on ghost/secondary controls, quiet info panels (execution status, changed-file bar).
- **Surface Sunken** (`{colors.hairline}` — #EEF0F4): Inset areas and the user's own chat bubble.
- **Surface Inverse** (`{colors.ink}` — #0D1630): Reserved for inverted chrome; used sparingly.

### Text
- **Ink** (`{colors.ink}` — #0D1630): Headings and strongest text. Also the wordmark color.
- **Body** (`{colors.body}` — #1F2A4D): Default running text, including agent answers.
- **Muted** (`{colors.muted}` — #5B6480): Secondary labels, panel captions, tool badge text.
- **Subtle** (`{colors.subtle}` — #8A92AB): Timestamps, counts, eyebrow labels, placeholder text.
- **Link** (`{colors.primary-hover}` — #1E48E0): Inline links; hover goes to `{colors.primary-active}`.

### Semantic
- **Success** (`{colors.success}` — #16A46B) on wash `{colors.success-wash}` — #E7F7EF: Conversion complete, sync applied.
- **Warning** (`{colors.warning}` — #F5A623) on wash `{colors.warning-wash}` — #FEF4E2: "근거를 찾지 못했습니다", auth banners, degraded-but-usable states. The most-used semantic tone in this app, because "I could not verify this" is a first-class answer.
- **Error** (`{colors.error}` — #E5484D) on wash `{colors.error-wash}` — #FDEBEC: Build failure, destructive confirm (chat delete), validation.

Semantic colors are always used as **text-on-wash pairs**, never as solid fills, so a failure never shouts louder than the document content next to it.

## Typography

### Font Family
- **Sans**: `Pretendard` variable (weight axis 45–920), self-hosted as one `.woff2`. Falls back to `-apple-system`, `Apple SD Gothic Neo`, `Malgun Gothic`. One family covers Latin and Hangul, so mixed-script lines (`GBX-ONB-001 온보딩 계획서`) keep a single baseline and weight.
- **Mono**: `JetBrains Mono` at 400/500/700, self-hosted. Used only for machine-produced values.

### Hierarchy
| Role | Size | Weight | Line height | Tracking |
|---|---|---|---|---|
| Display | 48px | 800 | 1.08 | −0.02em |
| H1 | 40px | 700 | 1.08 | −0.02em |
| H2 | 32px | 700 | 1.25 | −0.02em |
| H3 | 24px | 600 | 1.25 | −0.02em |
| H4 | 20px | 600 | 1.25 | −0.02em |
| Body | 16px | 400 | 1.5 | −0.01em |
| Chat body | 15px | 400 | 1.65 | −0.01em |
| Label | 13px | 600 | 1.5 | −0.01em |
| Caption | 11px | 400–700 | 1.5 | −0.01em |
| Eyebrow | 11px | 700 | 1.5 | +0.08em, uppercase |

### Principles
- **Negative tracking everywhere except eyebrows.** Body sits at −0.01em, headings at −0.02em. Pretendard runs slightly wide by default and the tightening is what makes Hangul and Latin sit at the same optical density.
- **Chat body is 15px/1.65, not 16px/1.5.** Answers are long and often contain tables from converted documents; the looser leading and slightly smaller size make a 12-line answer scannable.
- **Weight carries hierarchy, size carries structure.** Within a panel, prefer 600 vs 400 at the same size over jumping a size step.
- **Eyebrows are the only uppercase.** 11px/700/+0.08em, in `{colors.subtle}`. Anything else uppercase reads as shouting.

### Note on Font Substitutes
If Pretendard fails to load, the stack falls through to the platform Korean UI face (Apple SD Gothic Neo / Malgun Gothic). Metrics differ enough that tight tracking looks cramped — this is accepted, because the alternative (blocking render on a webfont) is worse in an offline-first app.

## Layout

### Spacing System
4px base. The used steps are `{spacing.xs}` 4 · 8 · 12 · `{spacing.md}` 16 · 20 · `{spacing.lg}` 24 · `{spacing.xl}` 32 · 40 · `{spacing.2xl}` 48 · 64 · 80 · 96 · 128.

In app chrome, spacing rarely exceeds 24px — the shell is dense on purpose. The large steps exist for the marketing/login surfaces, where `{spacing.section}` (112px) sets the section rhythm.

### Grid & Container
The app is a **fixed three-pane shell**, not a fluid grid:

```
┌─ titlebar (56px) ─────────────────────────────────┐
├──────────────┬──────────────────┬─────────────────┤
│ chat list    │  conversation    │  document tree  │
│ 260px        │  1fr             │  320px          │
└──────────────┴──────────────────┴─────────────────┘
```

The centre track must be declared `min-w-0`. Without it, a wide SVG (the knowledge graph) expands the `1fr` track and squeezes the right pane — a real bug this rule was written after.

Marketing and login surfaces use `{layout.container-max}` (1200px) with `{layout.container-narrow}` (760px) for prose.

### Whitespace Philosophy
Panels breathe at 12–16px internal padding, not 24px+. This is a working tool that shows many documents at once; generous whitespace would mean scrolling to see a folder. Whitespace is spent on the **conversation column** — where reading happens — and saved everywhere else.

## Elevation & Depth

Separation is done with **hairlines first, shadows second**.

- `{shadows.xs}` — cards and secondary buttons at rest. Barely visible; it exists to lift a white card off a white canvas.
- `{shadows.sm}` / `{shadows.md}` — hovering cards, popovers.
- `{shadows.lg}` — interactive card hover (paired with a −2px translate).
- `{shadows.xl}` — modals only (approval dialog).
- `{shadows.brand-sm}` / `{shadows.brand}` — the primary button and brand surfaces only. A blue-tinted glow, never applied to neutral elements.

All neutral shadows are `rgba(13,22,48, …)` — the ink color at low alpha. **Never use black shadows**: on this white canvas they read as smudges rather than depth.

### Decorative Depth
There is one glass surface utility (`fold-glass`: white at 82% + `saturate(180%) blur(16px)`), and it is **restricted to sticky chrome**. Glass as decoration is forbidden — it costs compositing on every scroll frame and makes text on top unpredictable.

## Shapes

### Border Radius Scale
| Token | Value | Used for |
|---|---|---|
| `{rounded.xs}` | 4px | Focus ring corners, tiny chips |
| `{rounded.sm}` | 6px | Tool badges, inline controls |
| `{rounded.md}` | 10px | Inputs, small buttons, list rows |
| `{rounded.lg}` | 14px | Buttons, chat bubbles, chips |
| `{rounded.xl}` | 18px | Cards |
| `{rounded.2xl}` | 24px | Feature panels |
| `{rounded.3xl}` | 32px | Hero / large surfaces |
| `{rounded.pill}` | 999px | Badges, scrollbar thumb |

The pairing is by size, not by type: a 34px-tall button takes `{rounded.md}`, a 42px one takes `{rounded.lg}`. Corner radius tracks the element's height so curvature looks constant.

### Photography & Illustrations
There are none. The only graphics are the wordmark, the folder mark, and the knowledge graph (a generated SVG). Product surfaces show **real converted documents**, not illustrations — the app's claim is that it reads your actual files, and stock artwork would undercut it.

## Components

### Title Bar
`{layout.topbar}` (56px), draggable via `[data-drag-region]`. Buttons/inputs/links inside it must opt out with `-webkit-app-region: no-drag` or they become unclickable — the CSS in `base.css` does this automatically for those three tags.

### Buttons
Five variants, three sizes.

| Variant | Rest | Hover | Press |
|---|---|---|---|
| `primary` | blue-500 + `{shadows.brand-sm}` | blue-600 | blue-700 |
| `secondary` | white + border ink-200 + `{shadows.xs}` | ink-50 | ink-100 |
| `subtle` | blue-50 / blue-600 text | blue-100 | blue-200 |
| `ghost` | transparent / ink-700 | ink-50 | ink-100 |
| `danger` | red-500 + red glow | red-600 | red-600 |

Sizes: `sm` 34px / 13px / `{rounded.md}` · `md` 42px / 15px / `{rounded.lg}` · `lg` 52px / 16px / `{rounded.lg}`.

Rules: **one primary per screen.** Hover is one step darker, press is one more step **plus a 0.5px downward translate**. No bounce, no scale. Loading swaps the left icon for a spinner and disables the button.

### Cards
White on white, separated by a 1px `{colors.hairline}` border and `{shadows.xs}`. `interactive` cards add `hover:-translate-y-0.5` with `{shadows.lg}`. `selected` cards swap the border for the brand color rather than adding a fill.

### Inputs
`{rounded.md}`, 1px `{colors.border-default}` border, 15px text. Hover darkens the border to ink-200; focus swaps to `{colors.primary}` **plus** `{shadows.focus}`. Disabled fills with `{colors.surface-subtle}`.

Field labels are 13px/600 in ink-700, with hint text below in `{colors.subtle}` and errors in `{colors.error}`.

### Badges
Pill-shaped, five tones (`neutral` / `brand` / `success` / `warning` / `danger`), each a text-on-wash pair. Two sizes: 20px and 24px tall. Used for build status, document counts, and tool names.

### Chat Messages
- **User** — right-aligned, `{colors.hairline}` fill, `{rounded.lg}`, max 80% width. Deliberately *not* brand blue: the user's own words are not an action.
- **Agent** — full-width, no bubble, 15px/1.65 body, preceded by the folder mark at 26px. Markdown-rendered, because converted documents carry tables and headings.
- **Streaming caret** — a 2px blue bar that blinks on a 1s step, placed *outside* the markdown block so incomplete markdown does not shift it.
- **Thinking dots** — three 6px blue dots bouncing in sequence (`fold-dot-bounce`, 1.1s, 0.14s stagger). The stagger must stay well under a third of the cycle or the three dots read as random blinking instead of a wave.

### Citation Chips
Blue, clickable, sit under an answer. This is where the product's promise lives — every claim traces back to a document — so it gets the brand color and nothing else on that row does.

### Approval Modal
`{shadows.xl}`, shows the diff before anything is written. A destructive confirm uses the `danger` button; the cancel path is always the wider target.

### Inline Destructive Confirm
Row-level deletes (chat history) do **not** open a modal. The row turns into a red wash strip with 삭제 / 취소 in place. Modal fatigue makes people click through; an inline change of state in the same spot does not.

## Do's and Don'ts

### Do
- Ration blue. Primary action, citations, active row — that is the whole list.
- Use hairlines to separate, shadows to elevate. If two things are side by side, they need a line, not a shadow.
- Keep shadows navy-tinted (`rgba(13,22,48,…)`).
- Put machine-produced values in JetBrains Mono. Paths, counts, IDs, timestamps.
- Give every failure a sentence in Korean that says what happened and what to do. Warning wash, not a red modal.
- Animate `transform` and `opacity` only.
- Respect `prefers-reduced-motion` — it is already killed globally in `base.css`; do not re-enable per component.

### Don't
- Don't put two primary buttons on one screen.
- Don't use black shadows. Ever.
- Don't use `fold-glass` for decoration — sticky chrome only.
- Don't bounce or overshoot interactive elements. Press is a 0.5px translate, not a scale.
- Don't hardcode a hex. Every color exists as a token and is mapped into Tailwind by `@theme inline`; a literal hex will silently drift from the system.
- Don't make the user's chat bubble brand blue.
- Don't add a modal for a row-level action.
- Don't let text be selectable everywhere. This is a desktop app: `user-select` is off by default and turned on with `[data-selectable]` for content only.

## Responsive Behavior

### Breakpoints
This is a **fixed-layout desktop application**, not a responsive website. The shell assumes a window wide enough for 260 + content + 320. There is a secondary web build (used for demos) that renders the same components in a browser, but the three-pane shell is not adapted for narrow viewports.

### Touch Targets
Not applicable to the desktop shell — pointer only. Minimum control heights are set by ergonomics rather than touch: 34px (`sm`) is the floor for any clickable control, and icon-only buttons carry at least 6px of padding around a 14–15px icon.

### Collapsing Strategy
None currently. See Known Gaps.

### Image Behavior
The knowledge graph SVG must be constrained by its container (`min-w-0` on the grid track). It is the only element in the app that can grow unboundedly.

## Iteration Guide

The token files under `src/renderer/src/styles/tokens/` are **the single source of truth** and are marked "원본 그대로 — 업스트림 동기화 대상" (upstream sync target). `index.css` maps them into Tailwind v4 with `@theme inline`, which means Tailwind consumes the same CSS variables rather than copying their values. Change a token in one place and every utility follows.

To extend the system:
1. Add or change the variable in the relevant `tokens/*.css` file.
2. If it should be reachable as a Tailwind utility, add the mapping in the `@theme inline` block in `index.css`. Do not duplicate the value.
3. If the pattern repeats across components, add a `@utility` (see `fold-card`, `fold-focus`, `fold-eyebrow`, `fold-glass`). If it belongs to one component, keep it in that component.

Import order in `index.css` matters: tokens → Tailwind → `@theme inline` → `base.css` **wrapped in `layer(base)`**. Unlayered rules beat layered ones regardless of specificity, so importing `base.css` without the layer makes `h1 { color: … }` override `text-white` — this actually happened and turned the login headline navy.

## Known Gaps

- **No dark mode.** Every token is light-only. The ink ramp would invert cleanly, but surfaces and the navy-tinted shadows would need to be re-derived, not flipped.
- **No responsive/collapse strategy.** The three-pane shell has fixed side panes with no breakpoint behavior; a narrow window clips rather than reflows. The web demo build inherits this.
- **Semantic color contrast is unaudited.** The text-on-wash pairs have not been measured against WCAG AA; `{colors.warning}` on `{colors.warning-wash}` is the most likely to fail.
- **Focus ring is one size.** `{shadows.focus}` is a 3px spread at every radius; on `{rounded.pill}` badges it reads slightly loose.
- **Motion tokens are underused.** `{motion.duration-slow}` and `ease-in-out` are defined but barely referenced — most components hardcode `{motion.duration-fast}`.
- **No documented empty/skeleton states.** Loading is covered (spinner, thinking dots, progress bar) but first-run empty panes are ad hoc.
- **Mono is Latin-only.** JetBrains Mono has no Hangul; Korean text inside a mono context falls back mid-string.
