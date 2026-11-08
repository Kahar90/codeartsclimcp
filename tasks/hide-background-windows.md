You are working in a git repo. Fix empty Windows console windows from CodeArts lanes background process launches. Do not ask questions; decide and keep going. Commit after each step with subject `step N: ...`.

Evidence: runner/ca.mjs git helper uses spawnSync without windowsHide. syncCommits invokes git log every 5000 ms in lane supervision, matching reported recurring empty windows when launched through DeepSeek Harness. killTree taskkill, userEnv powershell, Server.start codearts serve, trust helper and doctor git version also lack windowsHide. Existing background launches already use windowsHide:true. Intentional attach terminals must remain interactive.

1. Add checks/windows-hide.check.mjs following existing check style. Test real subprocess options by instrumenting node:child_process with syncBuiltinESMExports or equivalent isolated source extraction. Cover recurring git helper, credential powershell, taskkill cleanup, server spawn, trust helper and doctor git version. Prove failing before the fix. Keep checks independent of real credentials/network/paid calls. Ensure explicit attach behavior is preserved. Commit the regression check.
2. In runner/ca.mjs add windowsHide:true to the unattended launches identified above. Audit other runner/*.mjs for related background omissions, but only change ca.mjs unless an additional concrete issue requires a follow-up brief. Preserve stdio, arguments, env, error handling, cross-platform behavior and intentional ca attach / dashboard attach terminal visibility. Commit the fix.
3. Self review against this brief; ensure regression tests actually exercise production options and existing targeted checks pass. Commit if changed.

Safety rules (hard):
- Never kill processes you did not start (no taskkill / Stop-Process on chrome, node or git).
- Never change file permissions or ownership (no icacls, takeown, chmod).
- Do not launch browsers or write your own browser scripts; use only checks below.
- If git commit fails, do NOT try workarounds: stop and put the exact error in final reply.
- Never print, log or commit credentials, CLI configs or lane logs. Numbers only, never print private text.
- Only touch runner/ca.mjs, checks/windows-hide.check.mjs and this tasks/hide-background-windows.md brief. No dependencies or unrelated cleanup. No em dashes.

CHECK: node --check runner/ca.mjs
CHECK: node checks/windows-hide.check.mjs
CHECK: node checks/cli.check.mjs
CHECK: node checks/authfast.check.mjs
CHECK: node checks/controls.check.mjs

For step 1 the regression check must fail before the fix; record this expected red result, then step 2 makes all checks pass.
Final reply: root cause, steps with commit hashes, checks, remaining limitations.
