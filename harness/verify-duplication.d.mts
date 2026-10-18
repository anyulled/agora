export declare function evaluateDuplicationOutput(
  rawOutput: string,
  maxThreshold?: number,
): {
  valid: boolean;
  totalDuplicationPercent: number;
  violatingFiles: Array<{ file: string; duplicationPercent: number }>;
  clones: string[];
  message: string;
};
