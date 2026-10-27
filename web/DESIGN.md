---
name: Azzurro
description: Console of the local Azure emulator, told as a live national-team match broadcast; scoreboard, lower thirds and ticker on friendly rounded panels.
colors:
  azzurro: "#2f5bff"
  azzurro-deep: "#1d3fd1"
  azzurro-soft: "#e6ecff"
  azzurro-soft-2: "#cdd9ff"
  azzurro-text: "#2348e0"
  notte: "#0b1d51"
  notte-2: "#13296b"
  notte-3: "#1c3684"
  notte-deep: "#071440"
  rosso: "#ff3b4e"
  rosso-text: "#e5243b"
  rosso-soft: "#ffe6e9"
  giallo: "#ffcc00"
  giallo-ink: "#7a5c00"
  giallo-soft: "#fff6cc"
  oro: "#f6c344"
  arancio: "#ff8a1f"
  verde: "#19b36b"
  verde-text: "#12935a"
  verde-soft: "#def7eb"
  ink: "#0c1430"
  ghiaccio: "#eef2fb"
  ghiaccio-sunken: "#e3e9f7"
  surface: "#ffffff"
  surface-2: "#f6f8fe"
  surface-hover: "#f0f4ff"
  border: "#dfe5f2"
  border-strong: "#c4cee4"
  text-2: "#2c3656"
  muted: "#5d6787"
  faint: "#8f98b3"
  team-containers: "#10a9c2"
  team-web: "#7a5cff"
  team-databases: "#e0409a"
  team-networking: "#1aa3ff"
  team-monitor: "#7cc22f"
  team-ai: "#b45cff"
  team-management: "#6b7593"
typography:
  display:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "clamp(40px, 4.2vw, 68px)"
    fontWeight: 850
    lineHeight: 0.95
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 68"
  scoreboard:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "clamp(52px, 5vw, 92px)"
    fontWeight: 850
    lineHeight: 0.88
    letterSpacing: "-0.02em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 62"
  headline:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "34px"
    fontWeight: 750
    lineHeight: 1.04
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 82"
  title:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "16.5px"
    fontWeight: 680
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  on-air:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.03em"
    fontVariation: "'wdth' 72"
  label:
    fontFamily: "'Saira Variable', 'Saira', 'Avenir Next', 'Segoe UI', sans-serif"
    fontSize: "11.5px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.08em"
  mono:
    fontFamily: "'Martian Mono Variable', 'Martian Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 87.5"
rounded:
  tag: "4px"
  sm: "8px"
  control: "10px"
  tile: "14px"
  panel: "16px"
  stage: "20px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  panel: "18px"
  page-top: "28px"
  gutter: "clamp(16px, 2.2vw, 36px)"
  rail: "240px"
  topbar: "60px"
  ticker: "44px"
components:
  button-primary:
    backgroundColor: "{colors.azzurro}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "36px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.azzurro-deep}"
    textColor: "{colors.surface}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "36px"
  button-default-hover:
    backgroundColor: "{colors.surface-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.control}"
    height: "36px"
  button-danger-solid:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "36px"
  button-sm:
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "38px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "18px"
  scoreboard:
    backgroundColor: "{colors.notte}"
    textColor: "{colors.surface}"
    rounded: "{rounded.stage}"
    typography: "{typography.scoreboard}"
  scoreboard-cell:
    backgroundColor: "{colors.notte}"
    textColor: "{colors.surface}"
    padding: "18px 20px 16px"
  scoreboard-cell-hover:
    backgroundColor: "{colors.notte-2}"
  scoreboard-cell-running:
    backgroundColor: "{colors.giallo}"
    textColor: "{colors.ink}"
  scoreboard-cell-alert:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.surface}"
  badge-ok:
    backgroundColor: "{colors.verde-soft}"
    textColor: "{colors.verde-text}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  badge-warn:
    backgroundColor: "{colors.giallo-soft}"
    textColor: "{colors.giallo-ink}"
    rounded: "{rounded.pill}"
  badge-bad:
    backgroundColor: "{colors.rosso-soft}"
    textColor: "{colors.rosso-text}"
    rounded: "{rounded.pill}"
  badge-info:
    backgroundColor: "{colors.azzurro-soft}"
    textColor: "{colors.azzurro-text}"
    rounded: "{rounded.pill}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "5px 14px"
  chip-on:
    backgroundColor: "{colors.azzurro}"
    textColor: "{colors.surface}"
  tabs:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.tile}"
    padding: "4px"
  tab-on:
    backgroundColor: "{colors.azzurro}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  nav-link-active:
    backgroundColor: "{colors.azzurro}"
    textColor: "{colors.surface}"
    rounded: "12px"
    padding: "8px 12px"
  toast-lower-third:
    backgroundColor: "{colors.notte}"
    textColor: "{colors.surface}"
    rounded: "4px 14px 14px 4px"
    width: "min(460px, calc(100vw - 32px))"
  ticker:
    backgroundColor: "{colors.notte}"
    textColor: "{colors.surface}"
    height: "{spacing.ticker}"
  ticker-label:
    backgroundColor: "{colors.azzurro}"
    textColor: "{colors.surface}"
    typography: "{typography.on-air}"
    padding: "0 26px 0 16px"
  method-get:
    backgroundColor: "{colors.azzurro}"
    textColor: "{colors.surface}"
    typography: "{typography.on-air}"
  method-post:
    backgroundColor: "{colors.notte-3}"
    textColor: "{colors.surface}"
  method-put:
    backgroundColor: "{colors.oro}"
    textColor: "{colors.ink}"
  method-patch:
    backgroundColor: "{colors.arancio}"
    textColor: "{colors.ink}"
  method-delete:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.surface}"
  score-bug-local:
    backgroundColor: "{colors.oro}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "34px"
  score-bug-azure:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "34px"
  favourite:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 14px 6px 8px"
---

# Design System: Azzurro

## Overview

**Creative North Star: "Azzurri in diretta"**

The console narrates the developer's cloud the way Italian television narrates a national-team or Serie A match. Night-blue broadcast chrome frames the whole screen: a rail and topbar in deep night blue, a score bug in the topbar naming the active directory (EMULATORE or AZURE) with a live clock, and a DIRETTA ticker along the bottom where every API request runs past as a chip. Inside that frame the working surface is light and friendly. An ice-blue ground carries white panels with soft corners. The controls inside them are ordinary, legible form controls that never perform.

On-air graphics are reserved for the moments that tell the story. The home screen opens on a full-width scoreboard: giant italic condensed numerals that count up, each cell topped by a team-colour stripe. Changes arrive as lower thirds (toasts, the activity stack, assistant replies) that wipe in from the left with their colour band leading. Requests arrive in the ticker with an ochre underline whose length is the request's duration. Diagonal cuts, clip-path wipes and italic condensed Saira mark something as broadcast graphics; everything else stays upright and calm.

The world rejects the grey Fluent clone of the Azure portal and the dark neon console. Density is high and full-width, because the users read IDs, JSON and paths beside a terminal.

**Key Characteristics:**
- Night-blue broadcast chrome (rail, topbar, ticker, scoreboard, lower thirds) around a light ice-blue working floor with white rounded panels.
- One action colour, Azzurri blue. Cards (rosso, giallo, verde) are reserved for state, and gold marks writes and highlights.
- Every resource category has a team colour, used on its icon tile and as the scoreboard stripe.
- Saira variable on two registers: heavy italic condensed for the on-air register and normal width for the interface. Martian Mono handles IDs, paths, payloads and timings.
- Motion is a broadcast wipe on one exponential ease. Numbers count up, panels wipe in diagonally, and pages change behind an azzurro curtain.

## Colors

The palette is a team kit: Azzurri blue for action, night blue for the broadcast frame, referee cards for state, and a bank of team colours for resource categories.

### Primary
- **Azzurri Blue** (`azzurro`): the only action colour. It fills primary buttons, the active nav link, the active tab, selected chips, switches, checkbox accents, focus rings (at 34% alpha), text selection, the DIRETTA ticker label and the GET method tag. It is also the page-transition curtain.
- **Deep Azzurri** (`azzurro-deep`): hover and pressed state of every azzurro fill.
- **Azzurri Link Ink** (`azzurro-text`): links and info text on light surfaces. It is a darker step of azzurro chosen for text contrast.
- **Azzurri Wash** (`azzurro-soft`, `azzurro-soft-2`): selected rows, the info badge ground, hover borders on buttons, chips and tiles, and the spinner track.

### Secondary
- **Night Blue** (`notte`): the broadcast frame. It fills the rail, topbar, ticker, scoreboard, home cost figures, toasts, the login studio panel, the pricing draft estimate and the chart tooltip. `notte-2` is the scoreboard cell hover, `notte-3` the POST method tag, and `notte-deep` the deepest shell shade.

### Tertiary: the cards
- **Rosso** (`rosso`): destructive and error. It fills the solid danger button, the DELETE method, the alert scoreboard cell, the error toast band, the modal top strip and the AZURE score bug. It also marks the live dots (ticker label, clock and unread notifications) and the inset rule under the topbar when the real Azure directory is active. Text on light grounds uses the darker `rosso-text`.
- **Giallo** (`giallo`): waiting. It fills the running-deployment scoreboard cell and the offline bar, always with ink text. Warning text and icons use `giallo-ink` on `giallo-soft`.
- **Verde Campo** (`verde`): success fills, the success toast band and the storage team colour. Success text uses the darker `verde-text`.
- **Oro** (`oro`): writes and highlights. It marks the PUT method, the request-duration underline in the ticker, the EMULATORE score bug, the favourites ring, the active-nav dot, avatars, the draft-estimate top strip and the forecast figure stripe. It is never text on white.
- **Arancio** (`arancio`): the PATCH method and the integration team colour only.

### Team colours (resource categories)
Compute uses azzurro, containers `team-containers`, web `team-web`, storage verde, databases `team-databases`, networking `team-networking`, identity oro, security rosso, integration arancio, monitor `team-monitor`, AI `team-ai` and management `team-management`. They fill resource icon tiles (white glyph, or ink on oro and team-monitor) and the 5px stripe topping each scoreboard cell.

### Neutral
- **Ghiaccio** (`ghiaccio`): the page ground. `ghiaccio-sunken` is used for segmented-control wells, neutral badges, tags, skeletons and secrets.
- **Surface** (`surface`, `surface-2`, `surface-hover`): panels, table header and panel footers, and the shared hover tint.
- **Border** (`border`, `border-strong`): panel and row hairlines, and control strokes.
- **Ink** (`ink`) and the text ramp (`text-2`, `muted`, `faint`): body text, secondary text, metadata and placeholders. Ink is also the fixed dark text on oro, giallo and light team fills.

**Dark theme.** The frame deepens and the floor turns night. Ground is #070e29, panels #0f1a42, borders #1f2f66, text #edf1ff and muted #8f9cc8. Primary lifts to #5b80ff, link text to #9db4ff, success text to #3fd38b and danger to #ff5c6c. The card washes become deep tints. The scoreboard sits on #0b1745. Full values are in the sidecar.

**The One Action Colour Rule.** Azzurri blue is the only colour that means "do this". Cards never decorate, and gold never means "click".

**The Cards Are For State Rule.** Rosso, giallo and verde appear only when something failed or is destructive, is waiting, or succeeded. A panel is never tinted rosso for emphasis.

**The Ink On Light Kits Rule.** Oro, giallo, arancio and team-monitor fills always carry ink text, never white.

## Typography

**Display Font:** Saira Variable, using its width axis and true italic (with Avenir Next, Segoe UI as fallbacks)
**Body Font:** Saira Variable at normal width
**Label/Mono Font:** Martian Mono Variable (with ui-monospace, SF Mono, Menlo), compressed to 87.5% width

**Character:** One family plays both the broadcast and the desk. Pushed to italic, 62 to 72% width and weight 800 to 850, Saira becomes a sports caption. At normal width and weight 400 to 700, it is a quiet, readable interface sans. Martian Mono gives IDs, paths and timings an engineered, tabular texture.

### Hierarchy
- **Display** (850 italic, 68% width, clamp(40px, 4.2vw, 68px), 0.95): the home greeting only. The login studio headline is the same voice at 64% width and up to 92px, and login and assistant-empty titles use smaller italic condensed variants.
- **Scoreboard** (850 italic, 62% width, clamp(52px, 5vw, 92px), 0.88, tabular): scoreboard numerals. The same voice at smaller sizes serves money figures (clamp(36px, 3.4vw, 62px) on the costs scoreboard and clamp(30px, 2.8vw, 48px) in home costs) and the draft estimate (34px).
- **Headline** (750, 82% width, 34px, 1.04): page titles. Panel and modal titles use 750 at 85% width and 21px.
- **Title** (680, 16.5px): section and card titles. Card heads use 15.5px.
- **Body** (400, 14px, 1.5): everything you read. Controls use 13.5px at weight 600.
- **On-air** (800 italic, 72 to 75% width, 13 to 16px, +0.03 to 0.04em): method tags, activity verbs, the ticker label (16px, uppercase), score bug labels, toast titles (700 italic, 80% width, 16px), pricing stamps and assistant speaker names.
- **Label** (700, 11.5px, +0.08em, uppercase): table column headers. Rail group titles use the same treatment at 11px and +0.1em.
- **Mono** (400, 11.5px, 87.5% width, tabular): IDs, resource paths, tags, ticker paths and timings, code, JSON.

**The Two Registers Rule.** Italic condensed heavy Saira means "on air", so it appears only on broadcast graphics and big numbers. Buttons, form labels, table cells and body copy stay upright at normal width.

**The Mono Is Evidence Rule.** Martian Mono is reserved for things the machine said: IDs, paths, HTTP payloads, durations. Prose never uses it.

## Layout

The app is a three-row, two-column grid. On the left is a 240px night-blue rail. On the right is a sticky 60px topbar, a full-width main column, and a sticky 44px DIRETTA ticker at the bottom. Main padding is 28px on top with the fluid gutter (clamp(16px, 2.2vw, 36px)) at the sides. Content uses the full width with no centred narrow container.

The home and dashboards sit on a 12-column board with a 16px gap. The scoreboard spans all twelve columns at 8 cells across, then 4 below 1280px and 2 below 720px. Board panels collapse to full width below 1200px. Card heads are 14px 18px, card bodies 18px, and the general rhythm is 4, 8, 12, 16, 18 and 28px.

Below 960px the rail becomes an off-canvas drawer (min(300px, 86vw)) over a scrim. The topbar shows the brand and a menu button, and the ticker is fixed to the bottom. Below 480px search collapses to an icon that expands over the topbar, the score bug keeps only its label, and ticker paths truncate to 38vw so status and duration stay visible. Login splits 1.25fr studio and 1fr form, and the studio panel is dropped below 900px.

## Elevation & Depth

Depth here is mostly tonal: night-blue chrome against a light floor, white panels against ghiaccio. Resting panels carry only a 1px hairline and a barely-there shadow. Real lift is reserved for floating layers (menus, search results, side panels, modals, toasts, the off-canvas rail) and for the azzurro fills, which cast a coloured glow beneath them.

### Shadow Vocabulary
- **Card rest** (`0 1px 2px rgba(11, 29, 81, 0.05)`): panels, tables, board cells.
- **Pop** (`0 2px 8px rgba(11, 29, 81, 0.08), 0 22px 50px -14px rgba(11, 29, 81, 0.34)`): dropdowns, search results, side panels, modals, toasts and the cost tooltip. In dark mode it is black at 0.4 and 0.75.
- **Stage** (`0 24px 48px -28px rgba(11, 29, 81, 0.9)`): the scoreboard only.
- **Azzurri glow** (`0 10px 20px -12px rgba(47, 91, 255, 0.95)`): primary buttons, the active nav link, the active tab and the page-head icon tile.
- **Hover lift** (`0 16px 30px -20px rgba(11, 29, 81, 0.6)`): catalog tiles and favourites on hover, paired with a 2 to 3px rise.

**The Flat Floor Rule.** Panels are flat at rest. Lift belongs to things that float or that you can press.

## Shapes

Soft and friendly inside, cut and angular on air. Controls use a 10px radius (8px when small). Tiles, tabs and the composer use 14px, panels and tables 16px, and the scoreboard, side panels and modals 20px. Badges, tags, chips, segmented controls, search, favourites and progress tracks are full pills. Icon tiles are 9px (7px small, 12px in the catalog), and avatars and live dots are circles.

Broadcast graphics carry the diagonal. The ticker label ends in a 14px slant, and method tags and the score bug label end in 7 to 9px slants. Activity verbs and the toast colour band are trapezoids, and lower thirds have 4px leading corners and 14px trailing corners. The scoreboard, board panels and home cost figures enter through a skewed clip-path wipe, and a changed score flashes behind a -12deg skewed team-colour slab.

**The Cut Means On Air Rule.** Diagonal cuts and skews belong only to broadcast graphics: the scoreboard, score bug, lower thirds (toasts, activity verbs) and the ticker (its label and its method tags). Buttons, inputs, panels, tabs and badges are never cut. The same method tag inside the request drawer list is a rounded 5px pill, not a cut.

## Components

### Buttons
Plain, confident desk controls.
- **Shape:** 10px radius, 36px tall (30px and 8px radius when small, 38px square when icon-only), weight 600 at 13.5px.
- **Primary:** azzurro fill with white text and the azzurri glow. Hover moves to deep azzurri with a stronger glow.
- **Default:** white with a strong border. Hover tints to surface-hover with an azzurri-wash border.
- **Ghost:** transparent with text-2. Inside the night-blue chrome it uses translucent white text and a 10% white hover.
- **Danger:** rosso-text outline with a rosso-soft hover. The solid variant is a rosso fill for confirmed destruction.
- **States:** hover lifts 1px and icons scale 1.12. Active presses to 0.97 in 80ms. Disabled drops to 50% opacity. Focus is a 3px azzurro ring at 34% alpha, offset 2px.
- **Microsoft sign-in:** a 50px night-blue slab with a 14px radius that turns azzurro on hover with a 2px rise. Its focus ring is oro. In dark mode it inverts to white.

### Chips, Badges and Tags
- **Badge:** a 22px pill with a 6px leading dot in currentColor. Variants are ok (verde-soft/verde-text), warn (giallo-soft/giallo-ink), bad (rosso-soft/rosso-text), info (azzurro-soft/azzurro-text) and neutral (sunken). A pulsing variant replaces the dot with a live pulse.
- **Tag:** a mono pill on sunken ground for key:value tags.
- **Chip:** a white pill with a strong border. Hover shows an azzurro border and a 1px rise. Selected is a solid azzurro fill.
- **Stamp:** an italic condensed 800 outlined pill (1.5px ink border) for pricing models.

### Cards / Containers
- **Corner Style:** 16px.
- **Background:** white on ghiaccio, with surface-2 for table heads and panel footers.
- **Shadow Strategy:** card rest (see Elevation).
- **Border:** 1px border hairline, and card heads are divided by the same hairline.
- **Internal Padding:** 14px 18px heads (min 52px), 18px bodies.
- **Entrance:** board panels wipe in diagonally (420ms) staggered by 60 to 80ms.

### Inputs / Fields
- **Style:** 38px min height, 10px radius, 1px strong border, white fill, 8px 12px padding. Labels are 13px/650 in text-2, and hints and errors are 12.5px.
- **Focus:** the border turns azzurro with a 4px focus halo, and the caret is azzurro.
- **Error:** the border and message take the danger colour, and required marks use a danger asterisk.
- **Switch:** a 40x22 pill track that fills azzurro when on. Its white thumb travels on `--spring`.
- **Search (topbar):** a translucent white pill on night blue that turns white with a 4px azzurro halo on focus.

### Navigation
- **Rail:** night blue. Group titles are 11px uppercase, tracked and faint. Links are 14px/500 on a 12px radius. Hover shows a translucent white tint with a 3px nudge right. The active link is a solid azzurro fill with the azzurri glow and an oro dot at its trailing edge.
- **Tabs:** a white 14px tray with 4px padding. Inactive tabs are muted text. The active tab is an azzurro pill with a glow that pops in.
- **Segmented control:** a sunken pill well. The active segment is white with a hairline shadow.
- **Mobile:** an off-canvas drawer that slides on the ease over a scrim.

### Scoreboard (signature)
A full-width night-blue stage with a 20px radius and the stage shadow, split into cells by inset translucent hairlines. Each cell has a label (13px/650, translucent ice) above a scoreboard numeral that counts up from its previous value with an exponential ease-out over 900ms. A 5px team-colour stripe grows across the top of each cell. Cells wipe in diagonally with a 60ms stagger while a light sheen sweeps across once. Zero values dim to 58% ice. A running count turns the cell giallo with ink text, and a failure count turns it rosso. A changed number flashes behind a skewed slab in its team colour ("goal"). Linked cells hover to notte-2. The same grammar renders the six-up costs scoreboard, the four-up pricing scoreboard and the three-figure home costs strip.

### Score Bug (signature)
In the topbar, a 34px translucent capsule with an 8px radius. It holds the directory label (italic condensed 13px, slanted right edge: oro EMULATORE or rosso AZURE), the directory name, and a darker mono clock with a pulsing rosso live dot. When the real Azure directory is active, the topbar gains a 3px rosso inset underline.

### Lower Thirds (signature)
- **Toast:** night blue, 460px max, radius 4px 14px 14px 4px, pop shadow. It is stacked at the bottom-left above the ticker. A 44px trapezoid colour band (azzurro, verde or rosso) leads, then a 16px italic condensed title and 13px ice description. It enters by clip-path reveal from the left (550ms), then the band grows and the text rises.
- **Activity stack:** rows on surface-2 with 8px radius, each led by a trapezoid verb tag in method colours (GET azzurro, PUT oro, POST notte-3, DELETE rosso, failed as rosso hazard stripes), revealed left to right with a 50ms stagger.
- **Assistant replies** enter with the same reveal.

### DIRETTA Ticker (signature)
A 44px night-blue strip pinned to the bottom. At its left is an azzurro label with a slanted edge: an uppercase italic condensed "DIRETTA" with a pulsing rosso dot and a mono count. Request chips (28px, 6px radius, translucent white) slide in from the right and fade at the left edge. Each chip has a slanted method tag, a mono path, a status in green or soft red, and a duration. Its oro underline is as long as the request took (0.6px per ms, capped at 220px). Pending methods show moving hazard stripes. Clicking opens the request drawer with a list and JSON detail.

### Favourites
Pills with a white fill, a 2px oro ring and the resource icon tile. They pop in and on hover rise 2px and tilt -1deg.

### Resource Icon Tiles
Rounded squares (30px with a 9px radius, 24px with 7px, 42px with 12px in the catalog) filled with the category team colour. They tilt -6deg and scale on row hover.

### Dialogs and Side Panels
Side panels float 10px from the viewport edges with a 20px radius and slide 60px in from the right. Modals are 20px-radius cards topped by a 6px rosso strip (azzurro for neutral modals) and scale in from 96%.

## Do's and Don'ts

### Do:
- **Do** use azzurro for every primary action and selected state, and nothing else for that job.
- **Do** put broadcast moments (counts, live events, requests, confirmations) on night blue with italic condensed Saira and a leading colour band.
- **Do** give each resource category its team colour on its icon tile and scoreboard stripe, with ink text on oro, giallo, arancio and team-monitor.
- **Do** set IDs, paths, payloads and durations in Martian Mono at 87.5% width with tabular numerals.
- **Do** animate on the single exponential ease (`cubic-bezier(0.16, 1, 0.3, 1)`). Wipes run 420ms, lower thirds 500 to 550ms, and counters 900ms.
- **Do** keep `--spring` for the switch thumb and the notification count badge only.
- **Do** let every motion collapse to instant under reduced motion, including counters, the curtain and the scoreboard sheen.
- **Do** keep the preserved logo mark (open "A" on #0b3fbf with an #e8a917 crossbar) and the lowercase "azzurro" logotype (800, 75% width) exactly as shipped.

### Don't:
- **Don't** cut, skew or italicise buttons, inputs, panels, tabs or badges. Diagonals mean "on air".
- **Don't** use rosso, giallo or verde as decoration or emphasis. They are referee cards for state.
- **Don't** put white text on oro, giallo, arancio or team-monitor.
- **Don't** fall back to the grey Fluent look of the Azure portal or to a dark neon console.
- **Don't** centre content in a narrow container. The board uses the full width.
- **Don't** add a second easing curve or bouncy motion outside the two `--spring` uses.
- **Don't** recolour the logo mark to the world's azzurro or oro, and don't use the logo's hexes as UI tokens.
