export interface SdlcVerificationResult {
  passed: boolean;
  openIssues: Array<{ number: number; title: string; url?: string }>;
  closedIssues: Array<{ number: number; title: string; state?: string }>;
  errors: string[];
}

export function extractIssueReferences(text: string): number[];
export function verifyPullRequestSDLC(
  pr: { number?: number; title?: string; body?: string; head?: unknown },
  options?: {
    repo?: string;
    token?: string | null;
    fetchFn?: (path: string, token?: string | null) => Promise<{ status: number; data: unknown }>;
  },
): Promise<SdlcVerificationResult>;
