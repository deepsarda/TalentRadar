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

## Free deployment

The repository deploys as one Docker service on Render. Express serves the built React app from the same origin, avoiding CORS and cross-site session-cookie setup. MongoDB Atlas M0 supplies durable storage.

1. Create and claim a free MongoDB Atlas M0 cluster.
2. Create GitHub OAuth credentials with the Render callback URL.
3. In Render, choose **New > Blueprint** and connect this repository.
4. Render reads `render.yaml` and asks for the MongoDB, GitHub, and Gemini secrets.
5. Deploy. The service health check is `/health`.

The free Render service sleeps when idle, and Atlas M0 has a 512 MB storage limit. This topology is intended for development and the demo, not production traffic.
