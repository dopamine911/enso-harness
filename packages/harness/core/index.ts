/**
 * The harness's own core — path resolution only.
 *
 * ⚠ Schemas are NOT declared here. Every TypeBox schema in this repo lives in `@zen/core`,
 * so that a shape is either declared there or does not exist. Re-exporting them from here
 * would defeat that: a consumer could import `GuardPolicy` from two places and neither
 * import would look wrong.
 *
 * Import schemas from `@zen/core` directly. Import path helpers from here.
 */
export * from "./paths.ts";
