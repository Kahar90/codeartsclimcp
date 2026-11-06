# Pixel Workshop
## Animated Office view · Opus implementation handoff · v2

**Design decision** · Open Office on a full-width workshop. An agent's details appear in a small floating window beside their workstation when pressed. The room keeps its size while the window is open.

Use the [original Pixel Workshop concept](https://chatgpt.com/library?file_id=libfile_f874c18cba688191a52a765ae613b9b0&account_id=personal) for art direction. Use the **v2 motion study** and **v2 asset kit** for placement, timing, and integration. The original concept depicts a previous details layout.

### 1. Stage and agent controls

- Keep Office/Lanes navigation, run goal, latest meaningful run update, and real run/model status. The stage occupies the full available width under the header.
- Keep the warm oak, dusk windows, and violet shadows. Give the lead a blueprint desk, the cyan builder a terminal, the amber artist a drawing tablet, and the green reviewer a checklist. The reference layout uses four fixture roles. Live lanes use the repo's real role or a generic sprite. Keep station assignment stable by lane ID as status changes. Provide a visible, keyboard-accessible overflow list when there are more lanes than stations.
- Each station is a DOM button anchored to scene coordinates with a visible name and state icon plus text. Add a compact progress label when a total exists. Give the hit area a usable size and distinguish keyboard focus from the selected station ring. Status changes remain readable when animation is paused.
- Use the same stage transform for hit targets, labels, character feet, and link endpoints. At narrow widths allow a compact illustration with a scrollable station list so labels stay legible.

### 2. Floating agent window

| Interaction | Expected behavior |
|---|---|
| Enter Office or switch runs | Window starts closed. Run and lane status are visible on the stage. |
| Press a sprite, label, or overflow button | Open one non-modal window anchored to that station. Enter/Space performs the same action. Pressing a different agent switches the window immediately. Pressing the active trigger again closes it. |
| Dismiss | Close via X, Escape, or a pointer press outside the window and its active trigger. Inside interactions and live updates leave it open. On keyboard dismissal return focus to the trigger. A pointer click on another focusable element keeps that element focused. |
| Anchoring | Target width 300–340 px and an 8–12 px station gap. Try right, left, then above or below. Choose an in-bounds candidate with the least overlap of other station buttons, clamp to an 8–12 px inset, and give tall content internal scroll. Recompute on resize or scroll. Keep the callout tail pointed toward its station when space allows. |
| Narrow stage | Use a floating card inset from the stage edges, capped at roughly 55% of the visible stage or viewport height. Keep its close button reachable. An overflow row can anchor its own card. |
| Contents | Lane name, status, optional model, current step or waiting reason, compact checklist, progress and existing metrics when available. Keep Open in Lanes and the existing steer composer where permitted. |
| Accessibility | Use a labelled non-modal dialog or equivalent accessible popover pattern with a button trigger, expanded state, and a controls relationship. On keyboard opening, move focus to the close button or window heading and let Tab navigate naturally. Avoid a focus trap. Announce meaningful progress updates without reading every animation. |

No reserved column or scrim. Open in 120–160 ms with a short fade and 4 px travel, close in 90–120 ms, and flip or clamp position without animating across the stage. With reduced motion, open and close instantly. If a lane disappears, close its window and return focus to a nearby stable lane control. Keep drafts keyed by run and lane. Capture both IDs at submit time, prevent duplicate in-flight submissions for that draft, and clear it only on acknowledgment. A failure preserves the draft. If the user edits during a request, keep any text typed after the submitted draft. The response for one lane never clears another lane's draft.

### 3. Sprite and scene deliverables

The asset kit contains a clean pixel-art room, transparent starter atlases for all four roles, a machine-readable frame manifest, anchor coordinates, and the demo sequence. Atlases use 64 × 64 px cells, 2 px gutters, a common foot anchor at [32, 57], and per-frame durations in milliseconds. The exported cells include props that move with the characters. The room art contains the fixed desks and props. Use nearest-neighbor sampling. Keep HTML typography and focus outlines crisp at all scales.

The supplied sprites are editable starter art with independent arm, face, and prop motion. Preserve their silhouettes and fixed foot positions when matching them more closely to the room's shading. If the existing renderer needs another atlas layout, repack using the manifest's frame bounds. Render by lane ID and clip time. Avoid DOM updates on every sprite frame.

### 4. Animation choreography

| Role | Working loop | What changes on an event |
|---|---|---|
| Lead · violet | Blueprint lifts a few pixels, hands track the paper, then settle. Slow blink during idle. | Assignment gets a brief receive/send anticipation pose and a routed packet once the source confirms a target. |
| Builder · cyan | Alternating wrists, shifting keyboard highlights, and independent terminal cursor. Add a brief hold at the end of each typing burst. | A step completion gets a single check cue and the confirmed progress changes immediately. |
| Artist · amber | Elbow leads a short pencil sweep. The pen tip moves across the tablet and leaves a pixel trail. | A confirmed handoff gets a look-up and spark, then the sketch loop once Running. A confirmed completion plays a small lift and check before settling. |
| Reviewer · green | Magnifier tilts and sweeps over two checklist marks, with a pause at each end. | A confirmed completion plays a check pose then holds. A lane already Done at hydration starts at rest. |

**Motion hierarchy.** Idle uses a staggered blink with multi-second holds. Work uses eight frames with 90–270 ms holds per the manifest. Receive uses five frames over 580 ms. Completion uses six frames over 715 ms. Keep role loops phase-offset by lane ID and allow at most one transient per lane at a time. A terminal or blocked state interrupts the working loop. A completion cue outranks a simultaneous step cue. When a receive animation ends, continue with the current confirmed status, which may still be Waiting.

**Environment and effects.** Add one or two low-amplitude ambient details such as lamp glow or terminal scan lines. Run them slower and dimmer than event cues. A confirmed assignment or handoff can send a 500–800 ms packet along an existing route. A step check can draw on over 250–350 ms. Keep packet trails short and avoid competing particles around a floating window. Layer room, links, sprites, and local effects below DOM controls. Reduced motion freezes poses and removes packets, particles, ambient movement, and window transitions while keeping text and state current.

### 5. Data and renderer integration

1. Trace actual Office and Lanes entry points, run state, ordering and reconnect rules, lane steering, and permissions. Use existing APIs and adapt their read-only state into stable run/lane keys, labels, optional role/model, steps, progress, status, and optional relationship edges.
2. Build the stage and on-demand window first. Use the existing UI stack for DOM controls and accessibility. Use the existing renderer if it supports layered sprites, otherwise a small Canvas renderer with one scheduler. Asset loading failure falls back to readable station controls and lane details.
3. Initialize poses from the latest accepted snapshot. Trigger one-shots only for new, confirmed transitions. Deduplicate by run-scoped event ID or source sequence where available. If the source only exposes snapshots, diff accepted status or step changes. Only draw a routed packet when source and destination are known. On reconnect, refresh persistent state without replaying missed cosmetic effects. Pause cosmetic rendering when hidden and resume at the current confirmed state.
4. Preserve existing steer, run context, and navigation paths. Keep progress indeterminate when there is no total. Show waiting reasons and errors only when the source provides them. Validate with a real run and the fixture included in the kit.

### 6. Acceptance checks

- Office opens to a clear full-width room. Toggling an agent window never changes stage width or sprite coordinates. Switching agents never creates a second window.
- Escape, outside press, the close button, and the active trigger dismiss as specified. Keyboard users can open, inspect, steer, close, and return to the trigger. Narrow widths and overflow lanes remain usable.
- The fixture shows blueprint movement, alternating builder arms, an artist pencil stroke, and a reviewer lens sweep. Work loops follow live state. Dispatch, handoff, step checks, and completion play once per confirmed event. Duplicate events, reconnects, and initial hydration do not replay old effects.
- Reduced motion and the explicit Motion toggle keep all status updates readable with static sprites. Hidden tabs suspend cosmetic frame work. Unsupported relationship or role data has a readable fallback.
- Steer requests target the selected lane at submit time. Switching stations or editing after submit does not lose unrelated input. Run the repo's normal checks and record a real run with the window both closed and open.

### Copy into Opus

> Implement Pixel Workshop v2 in the existing MCP visualizer. Start by locating Office/Lanes, the run source, and the steering action. Open to the full-width workshop with no agent details visible. Pressing a station should open its compact, anchored, dismissible popover without resizing the stage. Use the room PNG, transparent sprite atlases, frame manifest, and motion study from the v2 handoff. Wire sprite loops and one-shot effects to confirmed state, preserve accessibility and reduced motion, and verify the acceptance checks with a real run. Report the actual files and events you mapped, any unsupported optional effects, and the checks run.
