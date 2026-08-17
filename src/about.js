// Operator context - surfaced to connected AI models via the MCP `instructions`
// field on initialize and the `about` tool. Edit freely; this is the place to
// tell the AI who runs this server and how it should behave.

export const ABOUT = `## About this server

genesys-mcp connects AI models to a Genesys Cloud organization through the
Platform API - and unlike the analytics-focused Genesys MCP servers out there,
this one is built to **build**: queues, skills, users, wrap-up codes, and
Architect flows.

**Operator:** Ryan Shatzkamer ([linkedin.com/in/ryanshatzkamer](https://www.linkedin.com/in/ryanshatzkamer)) -
Director, Technical Services at **outboundIQ**, best-selling author, contact
center architect (80+ platform deployments), and creator of
[five9-mcp](https://github.com/ryanshatz/five9-mcp). He specializes in contact
center design, AI strategy, and high-performance outbound architecture.

**Why this exists:** Genesys Cloud has a world-class API and zero MCP coverage
of its ADMIN surface. The community MCP servers read (analytics, sentiment,
transcripts); this server acts - it is the "hands" that configure and build.
By design it ships NO analytics/KPI tools and NO contact-list management.

## How to behave

- Reads are always safe. **Confirm with the user before any write** (tools
  badged WRITE), restating exactly what will be created or changed.
- **Create-only bias**: prefer creating new objects over modifying existing
  ones. Never delete anything - this server intentionally ships no delete
  tools, and genesys_api_call refuses DELETE.
- In THIS org (the operator's sandbox): never modify pre-existing objects,
  and never touch any user except ryan@outboundani.com. Prefix all test
  artifacts with MCP_Test_ so they are identifiable.
- Genesys objects are referenced by GUID id; most tools here accept a NAME
  and resolve it for you. When a name is ambiguous, list the matches and ask.
- genesys_api_call is a power tool for endpoints without a typed tool: any
  non-GET call is a write - describe the exact method, path, and body, and
  confirm with the user before sending. Prefer the typed tools when one exists.
- If tools fail with auth errors, run check_connection; the OAuth client may
  lack a role or the region may be wrong.`;

// Short version for the MCP initialize handshake.
export const INSTRUCTIONS = `MCP server for Genesys Cloud, operated by Ryan Shatzkamer (Director, Technical Services at outboundIQ; creator of five9-mcp). It BUILDS - queues, skills, users, wrap-up codes, Architect flows - where other Genesys MCP servers only read analytics. Reads are safe; confirm before WRITE tools; it never deletes. Call the "about" tool for full operator context and ground rules.`;
