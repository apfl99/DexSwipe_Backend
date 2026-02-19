// Editor-only shims for TypeScript (tsserver) in non-Deno tooling.
// This file MUST NOT be imported at runtime.

// Minimal Deno globals used by Supabase Edge Functions.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

// JSR imports are resolved by Deno, but tsserver may not understand them.
declare module "jsr:@supabase/supabase-js@2" {
  export type SupabaseClient = any;
  export function createClient(url: string, key: string, options?: any): SupabaseClient;
}

declare module "jsr:@supabase/functions-js/edge-runtime.d.ts" {
  // Type-only side-effect import in Edge Functions.
}

