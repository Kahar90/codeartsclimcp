The previous run planned for 35 minutes and made zero edits. Work in small pieces: one edit tool call per sub-change, never plan more than one step ahead.
Step 1 right now: in runner/office.html add a `HOTDESKS` constant (the five entries from runner/assets/scene.json hotdesks) and code that loads scene.json hotdesks over it, run `node checks/office.check.mjs`, commit. Your very next action must be an edit, not more reading.
Use grep to find the code you need (STATION_KEYS, stationLane, spriteScale, the "Other lanes" panel id overflow) instead of reading the whole file.
