# genesys-mcp

**Your Genesys Cloud org, in your AI's hands.** An open-source MCP server for Genesys Cloud on Cloudflare Workers. Zero dependencies, no terminal required, and unlike the analytics-focused Genesys MCP servers out there, this one **builds**.

> The existing Genesys MCP servers read. This one builds.

Prompt Claude (or any MCP client):

- *"create a queue called Weekend Support"*
- *"build a call flow: greet callers, press 1 for Weekend Support, press 9 to end the call. show me the diagram first"*
- *"draw my Main IVR as a diagram"*
- *"onboard prep: create a spanish skill and assign it to Jess at proficiency 4"*

The flow builder composes real Archy YAML, shows you the flow as a Mermaid diagram in chat, then publishes through Genesys' own flow-jobs pipeline (the same one CX as Code uses), so Genesys validates and publishes server-side.

## What it deliberately does NOT do

- **No analytics or KPI tools.** Other MCP servers cover that lane well.
- **No contact-list management.**
- **No deletes.** There are no delete tools, and the raw API tool refuses `DELETE`. Create-first by design.

## Deploy your own in 3 steps

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ryanshatz/genesys-mcp)

1. **Deploy**: click the button (free Cloudflare account), or `git clone` + `npx wrangler deploy`. The CONFIG KV namespace is auto-provisioned.
2. **Create a Genesys OAuth client**: Admin → Integrations → OAuth → Add Client → grant type **Client Credentials** → assign a role (see [Scoping the role](#scoping-the-role)) → save.
3. **Configure**: open `/setup` on your new Worker and paste the Client ID, Secret, and your region. The wizard validates them live against Genesys before saving, then hands you your access key (shown once).

Prefer terminal-managed config? Set Wrangler secrets instead; they override the wizard: `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET`, `GENESYS_REGION` (e.g. `usw2.pure.cloud`), `MCP_AUTH_TOKEN`.

## Connect your AI

The MCP endpoint is `https://<your-worker>/mcp`.

- **Claude (web/desktop)**: Settings → Connectors → Add custom connector → paste the URL. When the authorization screen appears, paste your access key.
- **Claude Code**: `claude mcp add --transport http genesys https://<your-worker>/mcp` and authenticate when prompted.
- **ChatGPT**: Settings → Connectors → Advanced → Developer mode → add the MCP server URL.
- **Anything else**: standard streamable HTTP MCP with OAuth 2.1 (or send the access key as a Bearer token).

Then try: *"check the connection and list my queues."*

## The toolbox (25 tools)

| Group | Tools |
|---|---|
| 🔌 Org & Connection | `about`, `check_connection`, `list_divisions`, `list_did_pools` |
| 📞 Queues & Routing | `list_queues`, `get_queue`, `create_queue` ✏️, `list_wrapup_codes`, `create_wrapup_code` ✏️ |
| 👥 Users & Skills | `list_users`, `get_user`, `list_skills`, `create_skill` ✏️, `assign_user_skill` ✏️ |
| 🌳 Flows (Architect) | `list_flows`, `get_flow`, `get_flow_configuration`, `list_prompts`, `render_flow`, `export_flow` |
| 🏗️ Flow Builder | `build_flow`, `publish_flow` ✏️, `get_flow_job`, `unlock_flow` ✏️ |
| ⚡ Power | `genesys_api_call` ✏️ (any Platform API endpoint; GET/POST/PUT/PATCH only) |

✏️ = write tool. Everything resolves names to GUIDs for you, so "the Weekend Support queue" just works.

### How the flow builder works

1. `build_flow` turns a spec (greeting + DTMF menu + queue transfers) into Archy YAML and a Mermaid diagram. Your AI shows you the diagram first.
2. `publish_flow` registers an Architect flow job, uploads the YAML, and polls. Genesys validates and publishes server-side; validation errors come back verbatim.
3. `render_flow` also diagrams flows that already exist in your org, and `export_flow` round-trips any flow back to YAML.

TTS is inline in the flow (your org's TTS engine speaks it), so there are no audio files to record or upload.

## Security model

- Your Genesys credentials live in **your** Cloudflare account (Wrangler secrets or the auto-provisioned KV), and nowhere else.
- The AI can only do what the **OAuth client's role** allows. You scope it; Genesys enforces it.
- The MCP endpoint requires the access key (raw Bearer or the built-in OAuth 2.1 flow for connectors).
- No delete tools exist, and `genesys_api_call` refuses `DELETE` outright.

### Scoping the role

For everything here to work, the OAuth client's role needs: Routing (queues, skills, wrap-up codes) view + add, Directory user view + edit (for skill assignment), Architect flow view + add + edit + publish, and Telephony DID view. Master Admin works for a sandbox; scope down for production. The server can only ever be as powerful as the role you assign.

## Local dev

```bash
git clone https://github.com/ryanshatz/genesys-mcp
cd genesys-mcp
cp .dev.vars.example .dev.vars   # or create it: GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION / MCP_AUTH_TOKEN
npm test                          # zero-dep unit tests (node --test)
npm run smoke                     # live read-tools smoke against your org
npm run smoke -- --writes         # also exercises create tools (MCP_Test_* artifacts)
npm run dev                       # wrangler dev
```

## About

Built in the open by [Ryan Shatzkamer](https://www.linkedin.com/in/ryanshatzkamer) (Director, Technical Services at outboundIQ), creator of [five9-mcp](https://github.com/ryanshatz/five9-mcp), the same zero-dependency architecture pointed at a second platform. Issues and PRs welcome; the roadmap is the issue tracker.

MIT
