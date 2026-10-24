# Security Auditing & Threat Modeling

Institutional playbook for auditing code, APIs, and workspace files for vulnerabilities.

## Operational Standards
1. **Fencing Check:** Verify all commands and file write operations stay strictly within the chat workspace.
2. **Injection Defense:** Scan for unescaped shell interpolations, arbitrary code execution, and unsafe deserialization.
3. **Secret Hygiene:** Ensure API keys, tokens, and credentials are never printed to logs or committed into files.
4. **Minimal Patching:** Deliver surgical diffs that neutralize vulnerabilities without bloating code.
