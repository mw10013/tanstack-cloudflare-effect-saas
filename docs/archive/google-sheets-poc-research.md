# Google Sheets OAuth for Organization Agent (POC Research)

## TL;DR

- Use **Google Sheets + Drive** for the POC.
- Keep Google OAuth separate from Better Auth.
- Store Google OAuth artifacts in the **organization agent Durable Object SQLite**.
- One Google connection per organization agent is feasible.
- Hibernation is fine as long as tokens/state are persisted in DO storage, not memory.

## Why Sheets over Docs for first POC

Sheets is simpler because the first useful operations are direct value read/write calls:

- `spreadsheets.values.get`
- `spreadsheets.values.update`
- `spreadsheets.values.append`

Docs editing is operation/index based via `documents.batchUpdate`, and document structure/tabs handling adds complexity.

Practical impact for POC:

- Sheets: fast path to "agent writes data users can inspect"
- Docs: more structure orchestration before first useful edit

References:

- https://developers.google.com/workspace/sheets/api/guides/values
- https://developers.google.com/sheets/api/reference/rest
- https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate
- https://developers.google.com/workspace/docs/api/how-tos/tabs

## OAuth explained simply (no auth-as-login coupling)

OAuth here means:

1. User clicks "Connect Google"
2. Google asks user to approve your app for chosen scopes
3. Callback returns an authorization `code`
4. Server exchanges `code` for tokens:
   - `access_token` (short-lived)
   - `refresh_token` (long-lived, used to get new access tokens)
5. Store refresh token in organization agent storage
6. Later calls to Sheets API use access token; refresh when expired

This does **not** require using Google for web-app sign in.

Reference:

- https://developers.google.com/identity/protocols/oauth2/web-server

### What "scopes" mean (plain language)

- A scope is a permission string your app asks Google for.
- Example: `.../auth/spreadsheets` means your app can read/write Sheets the user can access.
- You can request multiple scopes in one OAuth flow.
- User sees one consent screen listing all requested permissions.

Example scope set for your desired UX:

- `https://www.googleapis.com/auth/spreadsheets` (read/write sheet content)
- `https://www.googleapis.com/auth/drive.readonly` (list existing spreadsheets in Drive)

If later you want Docs too, add:

- `https://www.googleapis.com/auth/documents`

POC decision based on your preference:

- Request all three in the first OAuth flow:
  - `spreadsheets`
  - `drive.readonly`
  - `documents`
- This is one consent screen, one token set.

References:

- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/docs/api/auth

## Clarifying your questions

### Why ask for a "first action"?

Because OAuth scopes should match first capability. POC is easier if we define one small outcome, e.g.:

- "Create a spreadsheet and append a row"

Then scope/API/storage can be minimal and easier to debug.

POC decision:

- First milestone is **list files in Drive** (filtered to spreadsheets) on the org integration page.
- Then milestone 2 is selecting one spreadsheet and reading/writing values.

### Why might `spreadsheetId` be required?

Most Sheets API calls target a specific spreadsheet, so they need `spreadsheetId`.

POC options:

- User pastes `spreadsheetId` once
- or user picks from a list of existing spreadsheets
- or agent creates a spreadsheet first, then persists returned `spreadsheetId`

If you want users to pick existing spreadsheets, add a listing step.

Important detail: listing spreadsheets is generally a **Drive API** concern (`files.list` with spreadsheet mime type), not a Sheets API endpoint. So the practical POC shape is Drive (list/select) + Sheets (read/write).

References:

- https://developers.google.com/workspace/drive/api/guides/search-files
- https://developers.google.com/workspace/drive/api/guides/mime-types
- https://developers.google.com/workspace/sheets/api/scopes

Can we request Drive + Sheets + Docs in one go?

- Yes. One OAuth redirect can request multiple scopes together.
- Google returns tokens whose permissions are the union of granted scopes.
- Your chosen POC path: request all three now.

## Grounding in current codebase

Your organization agent already uses agent-local SQLite:

- `src/organization-agent.ts:235` class `OrganizationAgent extends AIChatAgent<Env>`
- `src/organization-agent.ts:239` creates `Upload` table via `this.sql`

Agent SDK persists state and MCP metadata in DO SQLite:

- `refs/agents/packages/agents/src/index.ts:591` creates `cf_agents_mcp_servers`
- `refs/agents/packages/agents/src/index.ts:603` creates `cf_agents_state`
- `refs/agents/packages/agents/src/index.ts:577` executes SQL via `this.ctx.storage.sql.exec(...)`

Agents SDK OAuth provider also persists OAuth client/tokens/state in Durable Object storage:

- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:113`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:137`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:157`

That matches your preference to avoid Better Auth `Account` table.

### Agents SDK OAuth deep dive (what it is, what it is not)

What it is:

- OAuth plumbing used by the Agents SDK MCP client manager
- Persists OAuth state/client/tokens in DO storage
- Handles callback orchestration through Agent request handling

Grounding:

- `refs/agents/packages/agents/src/index.ts:686` initializes `MCPClientManager`
- `refs/agents/packages/agents/src/index.ts:753` handles MCP OAuth callback path
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:36` class `DurableObjectOAuthClientProvider`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:149` generates/stores `state`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:137` persists tokens

What it is not:

- Not an out-of-box generic Google OAuth integration for arbitrary app features.
- It is specialized around MCP server OAuth flows.

POC guidance:

- Reuse the same design patterns (state table, token persistence, callback validation).
- Implement Google OAuth explicitly for your organization-agent integration.

Direct answer on tables:

- Do **not** reuse MCP OAuth tables (`cf_agents_mcp_servers` etc.) for Google Sheets integration.
- Do reuse the architectural pattern only: store OAuth state + refresh token durably in DO storage.
- Keep your own Google-specific tables (`GoogleConnection`, `GoogleOAuthState`, `GoogleSheetsConfig`, optional cache).

## Durable Object hibernation and token persistence

From Cloudflare docs:

- DO can hibernate after ~10s idle in hibernateable state
- In-memory state is discarded when hibernated
- Constructor runs again on wake

References:

- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:30`
- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:51`
- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:54`
- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:59`

Implication:

- Keep OAuth tokens, oauth `state`, chosen spreadsheet id in DO SQLite
- Do not rely on instance vars for these values

## Security posture for POC

Cloudflare DO data is encrypted at rest and in transit:

- `refs/cloudflare-docs/src/content/docs/durable-objects/reference/data-security.mdx:17`
- `refs/cloudflare-docs/src/content/docs/durable-objects/reference/data-security.mdx:25`

Still recommended:

- Store Google client secret and optional local-encryption key as Worker secrets (`env` bindings)
- Use Wrangler secrets for prod values

Reference:

- `refs/cloudflare-docs/src/content/docs/workers/configuration/secrets.mdx:12`
- `refs/cloudflare-docs/src/content/docs/workers/configuration/secrets.mdx:80`

## Proposed POC architecture (one Google account per organization agent)

### Connection model

- One row of Google connection metadata per organization agent
- First user to connect establishes org-wide Google account link
- Other users in same org use that same linked account through agent
- Add an org page dedicated to Google connection status + spreadsheet selection.
- If connected, show spreadsheet list and current selected default spreadsheet.

### Suggested tables in OrganizationAgent SQLite

```sql
create table if not exists GoogleConnection (
  id integer primary key check (id = 1),
  provider text not null,
  googleUserEmail text,
  scopes text not null,
  accessToken text,
  accessTokenExpiresAt integer,
  refreshToken text,
  createdAt integer not null,
  updatedAt integer not null
);

create table if not exists GoogleOAuthState (
  state text primary key,
  codeVerifier text,
  createdAt integer not null,
  expiresAt integer not null
);

create table if not exists GoogleSheetsConfig (
  id integer primary key check (id = 1),
  defaultSpreadsheetId text,
  defaultSheetName text,
  updatedAt integer not null
);

create table if not exists GoogleSpreadsheetCache (
  spreadsheetId text primary key,
  name text not null,
  lastSeenAt integer not null
);
```

Notes:

- Keep one-row semantics with `id = 1` constraint.
- For stricter security, encrypt `refreshToken` before storage using a Worker secret key.

## Minimal OAuth + Drive+Sheets API flow for POC

1. UI invokes `connectGoogleSheets` action on an org page
2. Server generates OAuth `state` (and PKCE verifier if used), stores in `GoogleOAuthState`
3. Redirect user to Google auth URL with scopes:
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/documents`
4. Google callback endpoint validates state, exchanges code for tokens
5. Persist tokens in `GoogleConnection`, clear used state row
6. First visible POC outcome: fetch Drive file list (start with spreadsheets) and cache in `GoogleSpreadsheetCache`
7. User picks spreadsheet from list, persist chosen id in `GoogleSheetsConfig`
8. Agent tool calls use stored refresh token -> get access token -> call Sheets API on selected spreadsheet

Recommended scopes for this specific UX:

- Chosen path: `drive.readonly` + `spreadsheets` + `documents`
- Lower-risk alternative for later hardening: Google Picker + `drive.file` (more moving parts, less broad Drive access)

Clarification:

- `spreadsheets` already allows read/write sheet data.
- `drive.readonly` is only for listing/metadata in Drive.
- So `spreadsheets` + `drive.readonly` supports your POC need: pick existing spreadsheet, then write/save cells.

If you later need file-level Drive mutations (rename/move/share/create in Drive), add broader Drive scope.

References:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/drive/api/guides/search-files
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth

## Worker vs Agent responsibility split

Your mental model is correct. Recommended split:

1. Worker/TanStack route layer:
- Serves pages
- Initiates OAuth redirect
- Receives OAuth callback HTTP request
- Resolves `organizationId` from session/route context
- Forwards connect/disconnect/select actions to the target organization agent

2. Organization Agent:
- Owns Google tokens and config in DO SQLite
- Owns spreadsheet list cache
- Owns all runtime Sheets calls used by tools/RPC/chat workflows

Grounding in current app:

- Worker already routes agent requests and authorizes by active organization id:
  - `src/worker.ts:69`
  - `src/worker.ts:78`
  - `src/worker.ts:89`
- Worker already calls organization agent by name for background flows:
  - `src/worker.ts:180`

Important clarification:

- Browser `useAgent()` WebSocket RPC is useful for interactive UI operations.
- OAuth callback itself should still be plain HTTP route handling.
- Route handler can call the organization agent stub; callback logic does not need to run over browser WebSocket.

## Answers to open items

1. Callback routing shape:

- Use TanStack API route for callback.
- Route has session context; from that derive `activeOrganizationId`, then call target agent by name.

2. PKCE for first pass:

- Recommendation: **include PKCE now**.
- Cost is small, benefit is better authorization-code interception protection.

3. Spreadsheet source:

- Since you want list selection, add Drive listing step and persist selected spreadsheet id.

4. Token encryption at app layer:

- POC acceptable without extra app-layer encryption if you keep strong access controls and use Worker secrets for client secret.
- Next increment: encrypt `refreshToken` using an env key before DB write.

## Why this POC shape is low-risk

- No coupling to Better Auth tables
- Natural fit with Agent/DO lifecycle and persistence model
- One clear success criterion: from chat/tool call, write/read a sheet row
- Easy rollback: disconnect = delete row(s) from `GoogleConnection` and `GoogleSheetsConfig`

## Appendix: why not Better Auth `Account`

You asked to avoid mingling app-auth identity with org-agent integration state.

Current Better Auth schema includes token fields in app DB:

- `migrations/0001_init.sql:119` table `Account`
- `migrations/0001_init.sql:124` `accessToken`
- `migrations/0001_init.sql:125` `refreshToken`

Using organization agent SQLite instead keeps ownership and lifecycle aligned to the organization agent itself.

## Google Account Setup (Beginner Guide)

This section explains how to obtain:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

without assuming prior Google Cloud knowledge.

### What is Google Cloud Console?

- Google Cloud Console is Google's dashboard for configuring APIs, OAuth, credentials, and billing for apps.
- URL: `https://console.cloud.google.com/`
- Sign in with your Google account.

### What you are creating

You need an OAuth client for a web app. Google gives you:

- a **Client ID** -> use as `GOOGLE_OAUTH_CLIENT_ID`
- a **Client Secret** -> use as `GOOGLE_OAUTH_CLIENT_SECRET`

### Step-by-step clicks

1. Open `https://console.cloud.google.com/`
2. Create/select a project:
   - top nav project picker -> **New Project** (if needed)
3. Enable APIs:
   - left nav -> **APIs & Services** -> **Library**
   - enable:
     - **Google Drive API**
     - **Google Sheets API**
     - **Google Docs API**
4. Configure OAuth consent screen:
   - **APIs & Services** -> **OAuth consent screen**
   - user type for POC: **External**
   - fill required app fields (app name, support email, developer email)
   - add scopes you need when prompted
   - add your Google account as a test user if app is in testing mode
5. Create OAuth client credentials:
   - **APIs & Services** -> **Credentials**
   - **Create Credentials** -> **OAuth client ID**
   - Application type: **Web application**
   - Name: anything (e.g. `tca-localdev`)
   - Authorized redirect URIs:
     - `http://localhost:<PORT>/api/google/callback`
     - replace `<PORT>` with output of `pnpm port`
6. Save and copy values:
   - copy **Client ID**
   - copy **Client secret**

### Map Google values to your env vars

```env
GOOGLE_OAUTH_CLIENT_ID=<client-id-from-google>
GOOGLE_OAUTH_CLIENT_SECRET=<client-secret-from-google>
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:<PORT>/api/google/callback
```

Current local client id (provided):

```env
GOOGLE_OAUTH_CLIENT_ID=776636651275-h65o0s1frskhhdkg6coac8rhmce33qqi.apps.googleusercontent.com
```

### Exact values to enter in Google OAuth client config

Authorized JavaScript origins:

- `http://localhost:3000`
- `http://localhost:3001`

Authorized redirect URIs:

- `http://localhost:3000/api/google/callback`
- `http://localhost:3001/api/google/callback`

If you keep using the repo default port from `pnpm port`, make sure that port is also listed in both places.

### Localdev notes for this repo

- This repo’s local port is from:
  - `pnpm port`
- Redirect URI in Google must match exactly:
  - scheme (`http`)
  - host (`localhost`)
  - port (from `pnpm port`)
  - path (`/api/google/callback`)

Mismatch here is the most common OAuth error.

### Common errors and what they mean

- `redirect_uri_mismatch`
  - Redirect URI in request does not exactly match what you registered.
- `access_denied`
  - User canceled consent or app not properly configured for testing users.
- `invalid_client`
  - Wrong client ID/secret pair.
- `origin_mismatch`
  - Current app origin/port not added under Authorized JavaScript origins.

### Production later (not needed for first local POC)

- Add production redirect URI in Google credentials.
- Move secret values to Wrangler secrets.
- Publish/verify consent screen as needed for broader user access.

## Detailed Implementation Plan

### Implementation Spec (Concrete, File-by-File)

This section is the direct execution spec for an LLM implementer.

### 1) Add env bindings and secrets

Target:

- `wrangler.jsonc`
- `.env.example`
- `src/worker.ts` types already come from generated `worker-configuration.d.ts`

Required env vars:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

Example `.env.example` block:

```env
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/google/callback
```

Add real values via Wrangler secrets for deployed envs.

### 2) Extend `OrganizationAgent` storage schema

Target:

- `src/organization-agent.ts`

Pattern to follow:

- Existing `this.sql` table init in constructor at `src/organization-agent.ts:239`
- Existing callable methods at `src/organization-agent.ts:585`

Add tables in constructor:

```ts
void this.sql`create table if not exists GoogleConnection (
  id integer primary key check (id = 1),
  provider text not null,
  googleUserEmail text,
  scopes text not null,
  accessToken text,
  accessTokenExpiresAt integer,
  refreshToken text,
  idToken text,
  createdAt integer not null,
  updatedAt integer not null
)`;
void this.sql`create table if not exists GoogleOAuthState (
  state text primary key,
  codeVerifier text not null,
  createdAt integer not null,
  expiresAt integer not null
)`;
void this.sql`create table if not exists GoogleSheetsConfig (
  id integer primary key check (id = 1),
  defaultSpreadsheetId text,
  defaultSheetName text,
  updatedAt integer not null
)`;
void this.sql`create table if not exists GoogleSpreadsheetCache (
  spreadsheetId text primary key,
  name text not null,
  modifiedTime text,
  webViewLink text,
  lastSeenAt integer not null
)`;
```

### 3) Add concrete callable methods in `OrganizationAgent`

Target:

- `src/organization-agent.ts`

Add callable method signatures:

```ts
@callable()
beginGoogleOAuth(input: {
  state: string;
  codeVerifier: string;
  expiresAt: number;
}) {
  const now = Date.now();
  void this.sql`insert or replace into GoogleOAuthState (
    state, codeVerifier, createdAt, expiresAt
  ) values (
    ${input.state}, ${input.codeVerifier}, ${now}, ${input.expiresAt}
  )`;
  return { ok: true };
}

@callable()
consumeGoogleOAuthState(state: string) {
  const now = Date.now();
  const row = this.sql<{
    state: string;
    codeVerifier: string;
    expiresAt: number;
  }>`select state, codeVerifier, expiresAt from GoogleOAuthState where state = ${state}`[0] ?? null;
  if (!row) return { ok: false as const, reason: "missing" as const };
  if (row.expiresAt < now) {
    void this.sql`delete from GoogleOAuthState where state = ${state}`;
    return { ok: false as const, reason: "expired" as const };
  }
  void this.sql`delete from GoogleOAuthState where state = ${state}`;
  return { ok: true as const, codeVerifier: row.codeVerifier };
}

@callable()
saveGoogleTokens(input: {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
  scope: string;
  idToken?: string;
}) {
  const now = Date.now();
  const existing = this.sql<{ refreshToken: string | null }>`
    select refreshToken from GoogleConnection where id = 1
  `[0] ?? null;
  const refreshToken = input.refreshToken ?? existing?.refreshToken ?? null;
  void this.sql`insert into GoogleConnection (
    id, provider, googleUserEmail, scopes, accessToken, accessTokenExpiresAt,
    refreshToken, idToken, createdAt, updatedAt
  ) values (
    1, ${"google"}, null, ${input.scope}, ${input.accessToken},
    ${input.accessTokenExpiresAt}, ${refreshToken}, ${input.idToken ?? null},
    ${now}, ${now}
  )
  on conflict(id) do update set
    scopes = excluded.scopes,
    accessToken = excluded.accessToken,
    accessTokenExpiresAt = excluded.accessTokenExpiresAt,
    refreshToken = excluded.refreshToken,
    idToken = excluded.idToken,
    updatedAt = excluded.updatedAt`;
  return { ok: true };
}

@callable()
getGoogleConnectionStatus() {
  const row = this.sql<{
    scopes: string;
    accessTokenExpiresAt: number | null;
    refreshToken: string | null;
  }>`select scopes, accessTokenExpiresAt, refreshToken from GoogleConnection where id = 1`[0] ?? null;
  return {
    connected: Boolean(row?.refreshToken),
    scopes: row?.scopes ?? "",
    accessTokenExpiresAt: row?.accessTokenExpiresAt ?? null,
  };
}

@callable()
disconnectGoogle() {
  void this.sql`delete from GoogleConnection where id = 1`;
  void this.sql`delete from GoogleOAuthState`;
  void this.sql`delete from GoogleSheetsConfig where id = 1`;
  void this.sql`delete from GoogleSpreadsheetCache`;
  return { ok: true };
}
```

Add non-callable helpers for Google API:

- `private async getValidGoogleAccessToken(): Promise<string>`
- `private async refreshGoogleAccessToken(refreshToken: string): Promise<void>`

Implementation detail for expiration:

- consider expired when `accessTokenExpiresAt <= Date.now() + 60_000`

### 4) Add OAuth start server function (TanStack Start pattern)

Target:

- new route file: `src/routes/app.$organizationId.google.tsx`

Pattern to follow:

- `createServerFn` style from `src/routes/app.$organizationId.upload.tsx:65`

Concrete start function:

```ts
const beginGoogleConnect = createServerFn({ method: "POST" })
  .handler(async ({ context: { session, env } }) => {
    invariant(session, "Missing session");
    const organizationId = session.session.activeOrganizationId;
    invariant(organizationId, "Missing active organization");
    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const state = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
    const codeVerifier = btoa(String.fromCharCode(...verifierBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

    await stub.beginGoogleOAuth({
      state,
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/documents",
    ].join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString() };
  });
```

Client usage on page:

```ts
const beginGoogleConnectServerFn = useServerFn(beginGoogleConnect);
const connectMutation = useMutation({
  mutationFn: () => beginGoogleConnectServerFn(),
  onSuccess: ({ url }) => {
    window.location.href = url;
  },
});
```

### 5) Add OAuth callback route

Target:

- new file `src/routes/api/google/callback.tsx`

Pattern to follow:

- server handler style in `src/routes/api/auth/$.tsx:16`

Concrete callback handler:

```ts
import { invariant } from "@epic-web/invariant";
import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const session = await context.authService.api.getSession({
          headers: request.headers,
        });
        invariant(session, "Missing session");
        const organizationId = session.session.activeOrganizationId;
        invariant(organizationId, "Missing active organization");

        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const providerError = url.searchParams.get("error");
        if (providerError) {
          throw redirect({ to: `/app/${organizationId}/google?google=denied` });
        }
        invariant(code, "Missing code");
        invariant(state, "Missing state");

        const id = context.env.ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = context.env.ORGANIZATION_AGENT.get(id);
        const stateResult = await stub.consumeGoogleOAuthState(state);
        invariant(stateResult.ok, "Invalid OAuth state");

        const body = new URLSearchParams();
        body.set("code", code);
        body.set("client_id", context.env.GOOGLE_OAUTH_CLIENT_ID);
        body.set("client_secret", context.env.GOOGLE_OAUTH_CLIENT_SECRET);
        body.set("redirect_uri", context.env.GOOGLE_OAUTH_REDIRECT_URI);
        body.set("grant_type", "authorization_code");
        body.set("code_verifier", stateResult.codeVerifier);
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        invariant(tokenRes.ok, `Token exchange failed: ${tokenRes.status}`);
        const tokenJson = await tokenRes.json() as {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
          scope: string;
          id_token?: string;
        };

        await stub.saveGoogleTokens({
          accessToken: tokenJson.access_token,
          accessTokenExpiresAt: Date.now() + tokenJson.expires_in * 1000,
          refreshToken: tokenJson.refresh_token,
          scope: tokenJson.scope,
          idToken: tokenJson.id_token,
        });

        throw redirect({ to: `/app/${organizationId}/google?google=connected` });
      },
    },
  },
});
```

### 6) Add Drive listing callable + cache

Target:

- `src/organization-agent.ts`

Concrete method:

```ts
@callable()
async listDriveSpreadsheets(): Promise<Array<{
  spreadsheetId: string;
  name: string;
  modifiedTime: string | null;
  webViewLink: string | null;
}>> {
  const accessToken = await this.getValidGoogleAccessToken();
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
  url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
  url.searchParams.set("pageSize", "100");
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const data = await res.json() as {
    files?: Array<{
      id: string;
      name: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };
  const now = Date.now();
  const files = (data.files ?? []).map((f) => ({
    spreadsheetId: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? null,
  }));
  for (const f of files) {
    void this.sql`insert into GoogleSpreadsheetCache (
      spreadsheetId, name, modifiedTime, webViewLink, lastSeenAt
    ) values (
      ${f.spreadsheetId}, ${f.name}, ${f.modifiedTime}, ${f.webViewLink}, ${now}
    ) on conflict(spreadsheetId) do update set
      name = excluded.name,
      modifiedTime = excluded.modifiedTime,
      webViewLink = excluded.webViewLink,
      lastSeenAt = excluded.lastSeenAt`;
  }
  return files;
}
```

### 7) Add spreadsheet selection + read/write callable methods

Target:

- `src/organization-agent.ts`

Concrete methods:

```ts
@callable()
setDefaultSpreadsheet(input: { spreadsheetId: string; sheetName?: string }) {
  const now = Date.now();
  void this.sql`insert into GoogleSheetsConfig (
    id, defaultSpreadsheetId, defaultSheetName, updatedAt
  ) values (
    1, ${input.spreadsheetId}, ${input.sheetName ?? "Sheet1"}, ${now}
  ) on conflict(id) do update set
    defaultSpreadsheetId = excluded.defaultSpreadsheetId,
    defaultSheetName = excluded.defaultSheetName,
    updatedAt = excluded.updatedAt`;
  return { ok: true };
}

@callable()
getDefaultSpreadsheet() {
  const row = this.sql<{
    defaultSpreadsheetId: string | null;
    defaultSheetName: string | null;
  }>`select defaultSpreadsheetId, defaultSheetName from GoogleSheetsConfig where id = 1`[0] ?? null;
  return row ?? { defaultSpreadsheetId: null, defaultSheetName: null };
}

@callable()
async readDefaultRange(range?: string) {
  const cfg = this.getDefaultSpreadsheet();
  if (!cfg.defaultSpreadsheetId) throw new Error("No default spreadsheet selected");
  const sheet = cfg.defaultSheetName ?? "Sheet1";
  const resolvedRange = range ?? `${sheet}!A1:C20`;
  const token = await this.getValidGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.defaultSpreadsheetId}/values/${encodeURIComponent(resolvedRange)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status}`);
  return res.json();
}

@callable()
async appendDefaultRow(values: string[]) {
  const cfg = this.getDefaultSpreadsheet();
  if (!cfg.defaultSpreadsheetId) throw new Error("No default spreadsheet selected");
  const sheet = cfg.defaultSheetName ?? "Sheet1";
  const token = await this.getValidGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.defaultSpreadsheetId}/values/${encodeURIComponent(`${sheet}!A:Z`)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ values: [values] }),
  });
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status}`);
  return res.json();
}
```

### 8) Add new org page `/app/$organizationId/google`

Target:

- new route file `src/routes/app.$organizationId.google.tsx`

Pattern to follow:

- `useAgent` usage from `src/routes/app.$organizationId.agent.tsx:25`
- mutation pattern from `src/routes/app.$organizationId.workflow.tsx:89`

Core client wiring:

```tsx
const { organizationId } = Route.useParams();
const agent = useAgent<OrganizationAgent, unknown>({
  agent: "organization-agent",
  name: organizationId,
});

const statusMutation = useMutation({
  mutationFn: () => agent.stub.getGoogleConnectionStatus(),
});
const listMutation = useMutation({
  mutationFn: () => agent.stub.listDriveSpreadsheets(),
});
const selectMutation = useMutation({
  mutationFn: (spreadsheetId: string) =>
    agent.stub.setDefaultSpreadsheet({ spreadsheetId, sheetName: "Sheet1" }),
});
const appendMutation = useMutation({
  mutationFn: () => agent.stub.appendDefaultRow([new Date().toISOString(), "poc", "ok"]),
});
const readMutation = useMutation({
  mutationFn: () => agent.stub.readDefaultRange(),
});
const disconnectMutation = useMutation({
  mutationFn: () => agent.stub.disconnectGoogle(),
});
```

### 9) Add route navigation

Targets:

- route list/sidebar location where org routes are surfaced, likely:
  - `src/routes/app.$organizationId.tsx`
  - any sidebar component used by app routes

Add a link to `/app/$organizationId/google`.

### 10) Concrete failure handling contract

Agent error codes to normalize:

- `"google_not_connected"`
- `"google_state_invalid"`
- `"google_refresh_failed"`
- `"google_sheet_not_selected"`

Server/callback redirect query flags:

- `?google=connected`
- `?google=denied`
- `?google=error`

UI mapping:

- `connected` => success banner
- `denied` => warning banner with reconnect CTA
- `error` => destructive banner + retry CTA

### 11) Verification commands and expected outputs

Type/lint:

```bash
pnpm typecheck
pnpm lint
```

Expected:

- both commands exit `0`

Manual POC verification:

1. Open `/app/<orgId>/google`
2. Click Connect
3. Complete consent
4. Return to page with `google=connected`
5. Click Refresh list
6. Select one spreadsheet
7. Click Append test row
8. Click Read range
9. Confirm new row visible in UI and actual sheet
10. Disconnect and verify list/read/write now fail with reconnect prompt

### 12) Strict rollout order

1. Env vars + config.
2. Agent SQL tables.
3. Agent callable methods for OAuth state + token save/status/disconnect.
4. OAuth start server fn on new Google org page.
5. OAuth callback route.
6. Token refresh helper.
7. Drive list callable + UI button.
8. Spreadsheet select callable + UI.
9. Sheets append/read callables + UI.
10. Final typecheck/lint/manual flow.

Definition of done:

- A non-owner org member can connect Google for the org, list spreadsheets, pick one, append a row, read rows, and disconnect; behavior is shared across users in the same organization agent.
