/**
 * lucide-react ships complete type declarations at
 * dist/lucide-react.d.ts but its package.json has no "types" field, so
 * TypeScript cannot find them on its own.
 *
 * Re-exporting the real declarations here fixes that once. The previous
 * version of this file listed every icon by hand, which meant any new
 * icon failed to compile until someone remembered to add it.
 */
declare module "lucide-react" {
  export * from "lucide-react/dist/lucide-react";
}
