# pi-harness as a DeepSeek Harness (dsh) plugin

pi-harness is a pi extension package. DeepSeek Harness is a different host, so the
same `core/` is mounted as a **Cordis plugin** instead of a pi extension:

| host | adapter | surface |
|---|---|---|
| pi | `extensions/*.ts` (`pi.on`, `pi.registerTool`) | Board tool, spawn, physarum, storm, anti-drift, … |
| dsh | `dsh-plugin/src/index.ts` (`apply(ctx)`, `ctx.tools.register`) | Board tool (`board`, all 8 actions) |

Both adapters call the same `core/` modules. `core/dsh.ts` is the single entry a
host runtime bundles, and `core/runtime/root.ts` lets that host pin the project
root per operation — that is what keeps a multi-project dsh process from writing
every session's Board into one directory.

## What the dsh plugin exposes today

Only the Board tool. Board storage, knowledge tiers, provenance rules, and the
close/archive integrity checks are shared code, so they behave exactly as they do
under pi. Nothing else is exposed yet:

- no `spawn` / `physarum` / `storm` (they need pi's session and stream plumbing),
- no `goal` / `anti-drift` / `reasoning-epoch` hooks (pi lifecycle events),
- no automatic context injection (pi's `context-feed` extension).

## Answering "is the Windows desktop plugin the same as Web?" — no

The desktop-app plugin and the Web profile share the **plugin contract** (Cordis
module: `name` / `inject` / optional `Config` / `apply`), so code written for one
usually loads in the other. They do not share a profile: each profile is its own
directory under `$DSH_HOME/profiles/<name>` with its own `package.json` bundles,
`cordis.patch.yml`, and `node_modules`. Nothing installed for `desktop` is visible
to `web`, so a web profile needs its own install (below).

Also note that this repository never contained a dsh plugin before this
directory. The Windows-desktop plugin the user remembers is not in the GitHub
history (`git grep cordis` over every revision is empty), so this adapter is new
code rather than a port.

## Install into a dsh profile

The profile install is a `file:` dependency plus one patch row, so the plugin is
versioned with this repo:

```bash
# 1. build the bundle (Node refuses to strip TS inside node_modules)
cd dsh-plugin && npm install -D esbuild && npm run build    # -> dist/index.js

# 2. install into the Web profile
cd ~/.dsh/profiles/web
pnpm add "file:$HOME/git/pi-harness/dsh-plugin"

# 3. mount it (cordis.patch.yml, after the bundle layers)
#    - insert:
#        - id: pi-harness-board
#          name: "pi-harness-dsh"

# 4. restart
dsh web
```

`pnpm` hardlinks `dist/` into the profile's store, so after editing the plugin run
`npm run build` again and restart `dsh web`.

Verify a boot mounted it: the Web startup log prints nothing on success, but a
broken entry prints `warning: N entry did not activate` with the import error.

## Route a model through the subscription proxy

`llm-pi-ai` is mounted dormant in `dsh-base`; a `providers` entry activates it.
This machine's subscription is the local `cliproxy` on `127.0.0.1:9090`
(OpenAI-compatible, the same endpoint pi's own `llama.cpp` provider uses):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qoder:
        api: openai-completions
        baseURL: http://127.0.0.1:9090/v1
        headers:
          authorization: "Bearer cliproxy-local"   # proxy ignores the value
        compat:
          supportsDeveloperRole: false
          supportsStore: false
          supportsReasoningEffort: true
          maxTokensField: max_tokens
          thinkingFormat: deepseek
        models:
          - id: Ultimate
            contextWindow: 1000000
            maxTokens: 65536
            input: [text, image]
            reasoningEfforts: { low: low, medium: medium, high: high, xhigh: xhigh, max: max }

- id: agent-default-model
  config: { provider: qoder, model: Ultimate, reasoningEffort: high }
```

Two failure modes found by booting, both loud:

- `NO_ADAPTER: no adapter registered for provider "qoder"` — an overlay that only
  sets `agent-default-model` does not carry the provider profile; both rows must
  reach the same composition.
- `UNSUPPORTED_REASONING_EFFORT: provider "qoder" model "Ultimate" does not
  support reasoning effort "high"` — a hand-declared model with no
  `reasoningEfforts` reasons about nothing; list the levels the proxy advertises.

Deliberate deviation: `apiKeyEnv` is omitted. A credential reference that
resolves to nothing fails with `MISSING_CREDENTIAL`; this proxy accepts any
bearer, so a static `headers.authorization` keeps the config free of a fake
secret while still satisfying pi-ai's OpenAI-compatible key requirement.

## Verified locally

- `apply()` registers `board` in dsh's real `ToolRuntime`; `open` / `post` /
  `read` / `list` round-trip and land in `<session.cwd>/.pi-board/`.
- The `qoder` route answers through dsh's own agent loop
  (`dsh --profile headless "Reply with exactly: PONG"` → `PONG`).
- A Web boot with the row mounted emits no `did not activate` warning.
