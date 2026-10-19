# TalentRadar

TalentRadar turns GitHub repositories and CVs into evidence-backed skill profiles, then ranks hackathon teams against organizer requirements with a deterministic, explainable scoring engine.

## Workspace

- `apps/web` - React, Vite, Tailwind CSS, daisyUI, and TanStack Query
- `apps/api` - Express API and, later, the free-deployment worker loop
- `packages/shared` - Zod contracts, taxonomy, fixtures, and the pure ranking engine

The original [product specification](./TalentRadar%20%E2%80%94%20Product%20%26%20Build%20Spec.md) and [implementation plan](./IMPLEMENTATION_PLAN.md) are kept at the repository root.

## Local development

Requirements: Node.js 24 LTS or newer and pnpm 12.11.2.

```sh
pnpm install
pnpm dev
```

The web app runs at `http://localhost:5173` and proxies API requests to `http://localhost:3000`.

Run every quality gate:

```sh
pnpm check
```

Apply safe Biome formatting, lint, and import fixes:

```sh
pnpm fix
```

## Repository assessment

The judge reviews up to 20 files per repository. Sampling first selects the 14 source files with
the most nonblank lines, then uses the remaining slots to cover additional technologies and file
types. Manifests, stylesheets, SQL, CI workflows, containers and infrastructure configuration can
provide evidence even when they are small. Eligible files may be up to 256 KB; dependencies,
generated files and build output remain excluded.

All sampled contents share `REPO_TOKEN_BUDGET` (default 12,000 estimated tokens, at four characters
per token). Small files are sent whole. Larger files get excerpts from the beginning, middle and
end, with omission markers, original line counts and truncation metadata. README and tree data
are supplied separately. Inspect a local checkout without making a model call:

```sh
pnpm run profile --dry-run .
```

The prompt requires a file-by-file technology inventory, reconciliation of every detector hint,
an evidence check and a final coverage audit. It reports supported tools and domains separately,
using the configured taxonomy's ids and aliases. Six synthetic examples calibrate scores and
demonstrate secondary technology coverage. Declaring a dependency establishes presence, not
advanced proficiency. Prompt and sampler versions invalidate assessments cached under older rules.

Every repository assessment must score all 12 domains in a required `domains` object. A score of 0
means no evidence in the reviewed inputs; 1–5 requires valid file evidence. Missing domains or
unsupported positive scores reject the assessment. Participant profiles include every domain,
and repositories with no evidence do not dilute positive scores or increase confidence.

The worker records Gemini's finish reason, output length and output/thinking token counts before
parsing the assessment. Truncated or blocked responses are rejected even if they contain a
parseable JSON prefix. A retry requests compact explanations while retaining medium native thinking,
every repository and its evidence. Structured output still requires completion checks and
application validation; the shared thinking/output limit can still interrupt generation.

## Free deployment

The repository deploys as one Docker service on Render. Express serves the built React app from the same origin, avoiding CORS and cross-site session-cookie setup. MongoDB Atlas M0 supplies durable storage.

1. Create and claim a free MongoDB Atlas M0 cluster.
2. Create GitHub OAuth credentials with the Render callback URL.
3. In Render, choose **New > Blueprint** and connect this repository.
4. Render reads `render.yaml` and asks for the MongoDB, GitHub, and Gemini secrets.
5. Deploy. The service health check is `/health`.

The free Render service sleeps when idle, and Atlas M0 has a 512 MB storage limit. This topology is intended for development and the demo, not production traffic.
