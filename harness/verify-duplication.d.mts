export declare function evaluateDuplicationOutput(
  rawOutput: string,
  maxThreshold?: number,
  maxFileThreshold?: number,
): {
  valid: boolean;
  totalDuplicationPercent: number;
  violatingFiles: Array<{ file: string; duplicationPercent: number }>;
  clones: string[];
  message: string;
};
