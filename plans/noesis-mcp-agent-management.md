# MCP management through codemode

Expose foreground-only MCP configuration, lifecycle, authentication, and inspection through the canonical Broker. Reuse application lifecycle authorization, configuration files, host, and TUI interaction bridge. Project trust and shadowing remain enforced.

Configuration specifies global/project scope, local stdio or remote transport (including explicit Streamable HTTP), OAuth options, and environment references for headers or child credentials. Authentication awaits the OAuth callback and reconnect, or collects referenced credentials in a masked form into protected credential storage, restoring them automatically for the exact scoped server on every connection. Secrets never become tool arguments/results or configuration values. Arbitrary provider-specific login protocols are not inferred: OAuth and server-driven MCP form/URL elicitation use their existing protocol implementations.

Keep the turn catalog frozen. Add a fixed `mcp.call_tool` adapter taking an exact discovered tool identity. Inspection returns the current identity and schema; dispatch validates that identity, input, output, and effect through the same Broker and host. This supports explicitly configured/authenticated servers immediately without replacing the catalog or granting subagents management access. Changed identities fail closed, including workflow resume.

Validate real stdio connection, configuration/trust, masked credential cancellation, same-turn invocation, stale identities, and OAuth completion using controlled local fixtures. Run formatting, lint, typecheck, and the full test suite.

## Validation

Implemented and verified with nine focused tests: controlled Pi same-turn setup/authentication/invocation, scoped configuration and project trust, credential cancellation, stale identities/native schema validation, configuration changes during credential entry, real loopback OAuth callback/token exchange over Streamable HTTP, stdio credential persistence/isolation/logout, and HTTP-header persistence with destination binding. Browser authorization opens only for explicit authentication requests.

Formatting, lint, and type checking pass. The complete suite passes with four workers (96 files, 1,203 tests). The initial default-concurrency run failed only the existing cross-process model-store file-lock test; the reduced-concurrency full rerun passed. No paid providers or external MCP services were used.

## Persisted credential correction

Manually entered header/stdio and OAuth client-secret credentials persist in an owner-only protected file using the same locked, validated, atomic storage implementation as OAuth tokens. Resolve values independently for each scoped server and bind them to connection settings, excluding cosmetic metadata and enablement. Never populate a shared process environment with saved secrets. Logout deletes saved credentials and disconnects; removal deletes saved header/stdio values. Verify restarts, isolation between servers using the same reference name, changed destinations, logout/removal, and file permissions.

## OAuth outcome reporting

Distinguish a failed token exchange from a successful sign-in followed by a failed MCP connection. The latter keeps credentials, shows a browser page confirming sign-in with reconnect instructions, and returns an actionable connection error through the existing tool failure path. Readiness remains false until connection and discovery succeed. Test an actual loopback OAuth exchange followed by HTTP 500, then reconnect and call a tool without a second browser flow or token exchange.
