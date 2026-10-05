/**
 * Web API types — placeholder pending first generation.
 *
 * CONTRACT APPROACH (go-live hardening §5.6): the API ships @nestjs/swagger
 * decorators, so these types are generated from the live OpenAPI document
 * rather than hand-maintained:
 *
 *   # 1. Run the API locally (non-production so /api/docs-json is served):
 *   pnpm --filter @ems/api dev
 *   # 2. In another shell, regenerate:
 *   pnpm --filter @ems/web gen:api-types
 *   #    (API_DOCS_JSON_URL overrides the default
 *   #     http://localhost:4000/api/docs-json)
 *
 * The generation script is `gen:api-types` in apps/web/package.json
 * (openapi-typescript). Generation is NOT feasible in the offline build
 * sandbox — the API needs a live database and server — so this file commits
 * an intentionally empty `paths` type as the baseline. The recommended CI
 * contract step: regenerate against the staging API on every PR and fail the
 * build when `git diff --exit-code src/lib/api-types.ts` is non-empty. That
 * catches web/API drift before it reaches the browser.
 *
 * ASSUMPTION: until the first generation lands, web code keeps its existing
 * hand-written DTO interfaces (in queries.ts and the pages).
 */
export interface paths {
  // Populated by `pnpm --filter @ems/web gen:api-types` against a running API.
  [path: string]: never;
}

export interface components {
  schemas: Record<string, never>;
}
