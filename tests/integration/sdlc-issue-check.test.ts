import { describe, expect, it } from 'vitest';
import { extractIssueReferences, verifyPullRequestSDLC } from '../../harness/verify-sdlc-issue.mjs';

describe('SDLC PR-to-Open-Issue Verification', () => {
  describe('extractIssueReferences', () => {
    it('extracts issue numbers from standard closing keywords', () => {
      expect(extractIssueReferences('Fixes #42')).toEqual([42]);
      expect(extractIssueReferences('Closes #100')).toEqual([100]);
      expect(extractIssueReferences('Resolves #7')).toEqual([7]);
      expect(extractIssueReferences('closed #8, fixed #9, resolved #10')).toEqual([8, 9, 10]);
    });

    it('extracts issue numbers from contextual keywords and full URLs', () => {
      expect(extractIssueReferences('Related to #15 and issue #16')).toEqual([15, 16]);
      expect(
        extractIssueReferences(
          'Implements feature for https://github.com/anyulled/agora/issues/24',
        ),
      ).toEqual([24]);
    });

    it('extracts standalone hashtag numbers', () => {
      expect(extractIssueReferences('Work on #31 for sprint')).toEqual([31]);
    });

    it('deduplicates references and ignores invalid strings', () => {
      expect(extractIssueReferences('Resolves #42 and Fixes #42 and #42')).toEqual([42]);
      expect(extractIssueReferences('')).toEqual([]);
      expect(extractIssueReferences('no issues mentioned here')).toEqual([]);
    });
  });

  describe('verifyPullRequestSDLC', () => {
    it('fails when no issue reference is present in the PR', async () => {
      const pr = {
        number: 1,
        title: 'feat: add some feature',
        body: 'This PR adds a nice feature without referencing an issue.',
      };

      const result = await verifyPullRequestSDLC(pr, {
        fetchFn: async () => ({ status: 200, data: {} }),
      });

      expect(result.passed).toBe(false);
      expect(result.errors[0]).toContain('No issue reference found in pull request');
    });

    it('passes when associated with an open issue', async () => {
      const pr = {
        number: 12,
        title: 'feat(auth): add oauth',
        body: 'Resolves #41 and provides secure tokens.',
      };

      const mockFetch = async (url: string) => {
        if (url.includes('/issues/41')) {
          return {
            status: 200,
            data: {
              number: 41,
              title: 'SPEC-024: Asset access control',
              state: 'open',
              html_url: 'https://github.com/anyulled/agora/issues/41',
            },
          };
        }
        return { status: 404, data: {} };
      };

      const result = await verifyPullRequestSDLC(pr, { fetchFn: mockFetch });
      expect(result.passed).toBe(true);
      expect(result.openIssues).toHaveLength(1);
      expect(result.openIssues[0]?.number).toBe(41);
    });

    it('fails when referenced issue is already closed', async () => {
      const pr = {
        number: 14,
        title: 'feat: rework completed feature',
        body: 'Resolves #17',
      };

      const mockFetch = async () => ({
        status: 200,
        data: {
          number: 17,
          title: 'SPEC-009: Emoji reactions',
          state: 'closed',
          html_url: 'https://github.com/anyulled/agora/issues/17',
        },
      });

      const result = await verifyPullRequestSDLC(pr, { fetchFn: mockFetch });
      expect(result.passed).toBe(false);
      expect(result.closedIssues).toHaveLength(1);
      expect(result.errors[0]).toContain('Referenced issue(s) are already closed: #17 (closed)');
    });

    it('rejects when referenced item is a PR instead of an Issue', async () => {
      const pr = {
        number: 15,
        title: 'fix: follow-up to PR 43',
        body: 'Fixes #43',
      };

      const mockFetch = async () => ({
        status: 200,
        data: {
          number: 43,
          title: 'build(deps-dev): bump vitest',
          state: 'open',
          pull_request: { url: 'https://api.github.com/repos/anyulled/agora/pulls/43' },
        },
      });

      const result = await verifyPullRequestSDLC(pr, { fetchFn: mockFetch });
      expect(result.passed).toBe(false);
      expect(result.errors.some((e: string) => e.includes('is a Pull Request, not an Issue'))).toBe(
        true,
      );
    });

    it('fails when referenced issue does not exist (404)', async () => {
      const pr = {
        number: 16,
        title: 'feat: mystery feature',
        body: 'Resolves #9999',
      };

      const mockFetch = async () => ({ status: 404, data: { message: 'Not Found' } });

      const result = await verifyPullRequestSDLC(pr, { fetchFn: mockFetch });
      expect(result.passed).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Issue #9999 does not exist'))).toBe(
        true,
      );
    });
  });
});
