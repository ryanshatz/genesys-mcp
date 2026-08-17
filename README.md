# genesys-mcp

**Your Genesys Cloud org, in your AI's hands.** An open-source MCP server for Genesys Cloud on Cloudflare Workers - zero dependencies, and unlike the analytics-focused Genesys MCP servers, this one **builds**: queues, skills, users, wrap-up codes, and Architect flows.

> The existing Genesys MCP servers read. This one builds.

By design it ships **no analytics/KPI tools** and **no contact-list management** - it is the admin/build side of the house, and it never deletes (no delete tools; the raw API tool refuses DELETE).

## Quick start

1. **Deploy**: `git clone` this repo, then `npx wrangler deploy` (free Cloudflare account).
2. **Create a Genesys OAuth client**: Admin → Integrations → OAuth → Add Client → grant type **Client Credentials** → assign a role → save.
3. **Configure**: open `/setup` on your Worker and paste the Client ID, Secret, and region - the wizard validates them live and hands you an access key. (Or use Wrangler secrets: `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET`, `GENESYS_REGION`, `MCP_AUTH_TOKEN`.)
4. **Connect your AI**: point Claude / ChatGPT / any MCP client at `https://<your-worker>/mcp` with the access key.

Local dev: copy your values into `.dev.vars`, then `npm run dev`. Tests: `npm test`. Live smoke against your org: `npm run smoke`.

## Status

Early - built in the open by [Ryan Shatzkamer](https://www.linkedin.com/in/ryanshatzkamer) (Director, Technical Services at outboundIQ; creator of [five9-mcp](https://github.com/ryanshatz/five9-mcp)). Architect flow building (compose → diagram → publish) is in active development.

MIT
