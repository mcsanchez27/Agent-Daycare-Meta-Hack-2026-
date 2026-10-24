# Headless Testing & Automated Validation

Operational doctrine for running unit tests, CLI smoke tests, and automated regressions.

## Operational Standards
1. **Zero Regressions:** Run `npm test` after every batch of changes and verify 100% passing status.
2. **Deterministic Checks:** Write test assertions against output strings, exit codes, and mock IPC events.
3. **No Hanging Processes:** Ensure process trees are terminated cleanly with timeout safety rails.
