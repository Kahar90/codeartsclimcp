# ca-office

Dev copy of the codearts-build lane runner (`runner/ca.mjs`, `runner/dash.html`) for building the
Office view (`runner/office.html`, `runner/office-sprites.js`). The live copy is in
`~/.claude/skills/codearts-build/runner`; finished files are copied there.

Checks:
- `node --check runner/ca.mjs`
- `node checks/sprites.check.mjs` (sprite contract, no browser)
- `node checks/office.check.mjs [outDir]` (starts `ca dash` on a free port, headless Chrome over CDP, screenshots in `checks/out`)

Manual: `node runner/ca.mjs dash 4790`, then http://127.0.0.1:4790/office (`?demo=1`, `?demo=done`).
