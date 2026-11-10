# CodeArts · Pixel Workshop Lanes
## Opus implementation handoff

### Copy this into Opus

> Implement the approved Pixel Workshop Lanes redesign in the existing CodeArts dashboard. Start with the current plan and lane hash routes, shared navigation, live lane updates, phase views, evidence tabs, and existing action handlers. Use the enclosed home and lane-detail mockups for visual direction and this document as the behavioral specification. The two source screenshots show the same lane with different evidence tabs. Preserve the underlying data, lifecycle semantics, deep links, and actions. Ship the home and detail routes together, verify live behavior with representative lanes, and report changed files, checks run, and any discrepancies between the screenshots and the actual repo.

### References

| File | Use |
|---|---|
| `01_Lanes_Home.png` | Approved home view. Use it for the shared shell, plan rail, wave layout, and visual tokens. |
| `02_Lane_Detail_Transcript.png` | Lane detail with Transcript selected. Use it for visual hierarchy and the placement of controls. |
| `03_Lane_Detail_Brief.png` | Same lane with Brief selected. Use it for the static evidence view. |
| `Current_Lanes_Transcript.png` | Existing live-detail screen. Source for data, labels, and interaction affordances. |
| `Current_Lanes_Brief.png` | Existing detail screen with Brief selected. Source for the Brief surface. |

Mockup text is abbreviated to show hierarchy. The renderer uses actual values and exposes the full source text. Keep the global counts fully in bounds, including in the Brief state where the generated reference clips the rightmost label. Existing behavior and this spec take precedence over incidental generated image details. Route examples use the captured hash URLs. Verify exact entry points, payloads, and available statuses in the repo before modifying them.

### 1. Navigation and shared shell

| Entry | Destination and behavior |
|---|---|
| Lanes top tab | Existing Lanes entry point with active plan context as supported today. Share the same CodeArts shell, navigation, and status system with Office. |
| Plan rail item | Existing plan route, for example `#/plan/ca-office`. Preserve plan counts, progress, the selected plan, and finished lane links. |
| Lane name in a wave or the rail | Existing lane detail route, for example `#/lane/ca-office-wt-office-layout--office-layout`. Use real lane IDs. Keep ordinary link behavior for deep links, open in new tab, and browser Back/Forward. |
| View all steps on a wave card | Inline preview disclosure. Keep it a distinct control from the link that opens the lane route. |
| Parent plan breadcrumb | Existing parent-plan link when a relationship exists. Keep standalone lane routes usable and provide a return to Lanes. Preserve existing browser scroll restoration where available. |

Keep the left rail as navigation on both routes. The detail page occupies the main workspace. The small, on-demand floating inspector belongs to the Office stage. On narrow layouts, replace the persistent rail with a labelled Plans/Lanes disclosure and stack main content in reading order. The rail can scroll independently on desktop and should remain useful with dozens of entries.

### 2. Plan home

- Plan title and status, lead model, updated time, and full goal. Preserve existing source/worktree metadata where supplied.
- Show the lead's current update with a small sprite. Keep plan counts and role information sourced from the existing run model.
- Render each wave as a full-width section in the existing order. Preserve wave label, description, status and lane count. Give running lanes the current step, model, elapsed time, progress and relevant code/path labels. Support multiple lanes and long titles without horizontal clipping. Wave collapse and individual step previews are independent.
- Keep the full Planned next checklist, Risks, and Decisions log. Timestamped decisions wrap naturally and retain full copy. Show Other lanes and Finished entries as defined by current data, including stopped or failed entries if they already live in Finished.

### 3. Lane detail

| Region | Layout and data |
|---|---|
| Identity | Parent breadcrumb, role sprite, lane name, written status. Show build and review models, elapsed and idle time, tokens in/out, steer and interruption counts, and worktree path as available. Make long paths wrap or offer a full selectable value. Distinguish zero from absent. |
| Phase strip | Preserve Build, Gates, Fix, Review, Result. The live phase and the viewed phase are separate when the repo supports inspection. Highlight each appropriately and preserve existing click behavior. A phase label alone never establishes a pass or a verdict. |
| Now | Show the existing current activity and step when present. Keep the band stable during live updates. |
| Plan steps | A compact ordered list with active, pending and committed/completed markers as supported. Start with the current step summary and give each truncated row a way to reveal the full source. For the captured build, show step 1 active with `0/7` completed. Use existing commit/progress semantics. |
| Lane context | In-flow group for Gates, Files touched, and Steering & incidents. Show configured checks distinctly from executed results. Show real paths, counts, history, and honest empty states. Keep details accessible when the stack collapses on narrow screens. |
| Evidence | Full-width panel below the steps/context grid. A separate tab strip holds Transcript, Review, Summary, and Brief. Keep the panel visible early on desktop. Text remains selectable, with readable monospace for logs and code. |
| Actions | Sticky to the bottom of the main workspace, with Steer input, Steer, Open TUI, and Stop according to existing capabilities. Leave enough bottom padding to read the last evidence row. On small screens, wrap controls and account for the virtual keyboard. |

Suggested desktop geometry is a 240–290 px rail, 20–28 px content gutters, and a 2:1 steps/context split. Let the cards size to their content. A compact step list keeps Transcript visible above the sticky controls on a typical desktop viewport. At narrow widths use one column with no page-level horizontal scrolling. Logs or code may scroll inside their own panel.

### 4. Evidence tabs and actions

- **Transcript** shows the existing live source with timestamps, preserving text, ordering, and output styling. Show Follow live only here. Following keeps the latest event in view without stealing keyboard focus or scrolling the outer page. Turning it off keeps the reading position as events arrive. Preserve the existing manual-scroll behavior or suspend following when the operator scrolls up. Keep the follow choice and position when switching evidence tabs within the same lane where feasible.
- **Review** shows existing review evidence and verdict if available. Handle pending, empty, and loaded states separately. Keep this tab distinct from the Review phase in the lifecycle strip.
- **Summary** shows the existing summary or a clear pending/unavailable state. Retain formatting and full text.
- **Brief** shows the original model and complete brief, including command snippets, paths, and line breaks. Brief is independently scrollable and selectable. It remains stable when live transcript entries arrive. It has no follow toggle.
- **Steer** uses the existing command and eligibility. Bind run/lane and target phase or session according to the existing handler at submission time. Preserve drafts on failure, clear only acknowledged text, and prevent duplicate in-flight requests. A delayed response must leave another lane's draft alone.
- **Open TUI and Stop** reuse the current target, capability checks, handlers, and confirmation behavior. Apply destructive styling to Stop and prevent duplicate in-flight execution. Preserve error feedback and the actual terminal state.

### 5. Visual tokens and motion

Start from shared Office tokens where they exist. Suggested fallbacks are stage background `#171320`, panel `#231D2C`, border `#403448`, foreground `#FBF3FF`, muted `#C9BDD5`, active selection `#BC8CE7`, running mint `#83F2CF`, review amber `#FFD591`, and failure coral `#FF9C9C`. Use written badges and icons alongside colors. Keep log categories legible on a quieter dark surface. Prefer the same type as Office for interface text and a system monospace for logs and paths.

Reuse the Office sprite assets already in the repo or the existing Pixel Workshop kit. Keep avatars small and animate only a few visible, running agents with their existing role loops. A real step completion can briefly highlight its row once. Initial hydration, repeated events, and reconnect snapshots settle directly to current state. Respect reduced motion and any platform motion toggle. Avoid large scene artwork or recurring effects around the console.

### 6. Build sequence and checks

1. Trace current plan and lane routing, live state, phase/evidence rendering and existing command handlers. Treat the text inside the source screenshots as fixture content. Locate actual dashboard files from the repo.
2. Implement shared shell styling and rail, then render the plan overview against existing data. Wire the lane link and separate step disclosure.
3. Restyle detail identity, lifecycle, steps, context, evidence, and sticky actions. Reuse existing adapters, handlers, and selectors where possible. Preserve live behavior and render transcript/brief content as data using the repo's safe rendering path.
4. Verify with a running lane, a completed lane, a failed or stopped lane, and a needs-review lane if fixtures support them. Exercise direct links and Back/Forward from both routes, transcript follow on/off, switching to Brief during updates, and steering while navigating. Use a fixture or safe local harness for Stop and Open TUI checks.
5. Verify keyboard and visible focus for navigation, disclosure, tabs, and actions. Verify narrow widths, long model names and paths, empty and missing fields, large log output, reduced motion, and sticky footer clearance. Run the normal repo checks and capture both routes and both evidence states for visual review.
