export interface CommitValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCommitMessage(rawMessage: string): CommitValidationResult;
