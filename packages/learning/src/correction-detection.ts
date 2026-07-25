export interface CorrectionDetection {
  readonly corrected: boolean;
  readonly reason: "explicit_prefix" | "none";
}

/** Conservative foreground signal; semantic reflection may interpret broader evidence later. */
export function detectExplicitCorrection(input: string): CorrectionDetection {
  const corrected = /^(?:no(?:[,\s]|$)|actually(?:[,\s]|$)|correction(?:[,\s:]|$))/iu.test(input.trim());
  return Object.freeze({
    corrected,
    reason: corrected ? "explicit_prefix" : "none",
  });
}
