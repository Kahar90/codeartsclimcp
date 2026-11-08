You are working in a git repo (current directory). Refresh the README with current genuine screenshots and clear onboarding. The user gives creative freedom, but the quick install must be immediately accessible. Lead has chosen: short intro, quick install before any large image, Use it, then an attractive visual tour prioritizing Lanes, with Office retained.
Do the steps in order. Commit after each step with subject `step N: <summary>`. Do not ask questions; decide and keep going.

1. Capture current UI using ONLY existing checks: `node checks/lanes.check.mjs` and `node checks/office.check.mjs`. Copy selected PNGs from checks/out into docs/images: lanes-control-room.png, lanes.png (fresh lanes-home or plan token view), lane-detail.png (transcript view), office.png (fresh scene or window). Use representative demo fixtures only, never real local lanes/private text. Do not alter product code or checks to make nicer screenshots. Commit images.
2. Refresh README.md. Keep title/intro compact and put `## Quick install` (same one-prompt INSTALL.md URL, prerequisites, keys guidance and image) BEFORE large dashboard screenshots. Add compact anchor navigation for Quick install, Use it, visual tour, Reference. After Use it create a visually composed tour with full-width readable screenshots and short benefit captions covering Control room, plan/waves, lane transcript/brief/steering/checks, and Office. Clearly label screenshots as built-in demo data. Preserve accurate setup commands, keys privacy, agent use table, safety, maintenance and further docs. Keep copy concise, approachable, scannable. Avoid excessive badges, emoji or decorative assets. Commit README.
3. Add tools/check-readme.mjs: lightweight Node-only validation that local README image/link targets exist, the one-prompt install URL remains and Quick install precedes dashboard screenshots. Also provide docs/images/README.md explaining exact capture commands and source-to-destination mapping for reproducibility (screenshots from built-in demo state only). This is the required test hook. Commit and self-review.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only the existing checks above.
- If git commit fails, do NOT try workarounds: stop and put the exact error in your final reply.
- Never commit secrets, CLI configs or lane logs (tasks/*.lane/, tasks/*.lane.log).
- Only touch README.md, docs/images/*.png, docs/images/README.md, tools/check-readme.mjs and tasks/readme-refresh.md. Do not push. No dependency installs, no paid model calls beyond your lane.
- Never read or print credentials. Use demo fixtures only; never print private text.
- Keep existing safety rules intact. At step 1, the README check does not exist yet; run capture checks, then once added run all CHECK lines.

CHECK: node tools/check-readme.mjs
Lead-run capture check: node checks/lanes.check.mjs (dashboard assertions passed; two pre-existing onboarding doctor-row assertions failed)
Lead-run capture check: node checks/office.check.mjs (ALL PASS)

Final reply: steps with commit hashes, capture mappings, checks and anything skipped.
