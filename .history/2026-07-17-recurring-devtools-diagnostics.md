# Recurring DevTools diagnostics — 2026-07-17

- Reproduced unsupported `Autofill.enable` and `Autofill.setAddresses` messages from automatically created Electron DevTools windows.
- Confirmed the real `zvibe editor` project had no idle renderer exception; the red main-process messages came from DevTools protocol negotiation.
- Added a shared explicit auto-open predicate and applied it to dashboard, main editor, and custom windows.
- Preserved manual `Cmd/Ctrl+Alt+I`, remote debugging on port 8315, and explicit `AUTO_OPEN_DEVTOOLS=true` behavior.
- Verified focused tests 2/2, complete editor tests 497/497, editor build, clean dashboard/project process output, and an empty renderer error/exception capture.
