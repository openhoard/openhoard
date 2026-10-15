// Types for vitest.preset.js: a package whose typecheck includes its vitest config (apps/web)
// needs them.
export declare const SLOW_LANE: boolean;
export declare function preset(options?: { floor?: number }): {
  test: {
    include: string[];
    exclude: string[];
    passWithNoTests: boolean;
    coverage: {
      provider: "v8";
      include: string[];
      exclude: string[];
      thresholds: Record<string, number>;
    };
  };
};
