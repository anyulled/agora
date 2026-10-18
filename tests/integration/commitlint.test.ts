import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateCommitMessage } from '../../harness/verify-commit-msg.mjs';
import { evaluateDuplicationOutput } from '../../harness/verify-duplication.mjs';

describe('Commit Message Validation', () => {
  it('allows valid conventional commit messages', () => {
    const validMessages = [
      'feat(auth): add OAuth login support',
      'fix(api): resolve null pointer in user session',
      'docs: update README with setup instructions',
      'style: format code with prettier',
      'refactor(core): streamline message dispatching',
      'perf(db): optimize user lookup query',
      'test(auth): add unit tests for login',
      'build: update dependencies',
      'ci: add GitHub Actions workflow',
      'chore: update project config',
      'revert: undo previous change',
      'feat!: breaking change without scope',
      'feat(api)!: breaking change with scope',
    ];

    for (const msg of validMessages) {
      const result = validateCommitMessage(msg);
      expect(result.valid, `Expected "${msg}" to be valid`).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it('allows Merge and Revert commits', () => {
    expect(validateCommitMessage('Merge branch "main" into feature').valid).toBe(true);
    expect(validateCommitMessage('Revert "feat: old feature"').valid).toBe(true);
  });

  it('rejects invalid conventional commit messages', () => {
    const invalidMessages = [
      'invalid type',
      'feat: ',
      'unknown(scope): missing valid type',
      'A header that exceeds one hundred characters and goes on and on and on and on and on and on and on and on and on and on',
    ];

    for (const msg of invalidMessages) {
      const result = validateCommitMessage(msg);
      expect(result.valid, `Expected "${msg}" to be invalid`).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('verifies git hooks exist and are non-empty', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const commitMsgHook = path.join(root, '.githooks/commit-msg');
    const preCommitHook = path.join(root, '.githooks/pre-commit');

    expect(fs.existsSync(commitMsgHook)).toBe(true);
    expect(fs.existsSync(preCommitHook)).toBe(true);

    const commitMsgContent = fs.readFileSync(commitMsgHook, 'utf8');
    const preCommitContent = fs.readFileSync(preCommitHook, 'utf8');

    expect(commitMsgContent.length).toBeGreaterThan(0);
    expect(preCommitContent.length).toBeGreaterThan(0);
  });

  it('verifies robust ESLint 9 flat configuration and Clean Architecture boundary rules exist', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const eslintConfigPath = path.join(root, 'eslint.config.mjs');

    expect(fs.existsSync(eslintConfigPath)).toBe(true);
    const eslintContent = fs.readFileSync(eslintConfigPath, 'utf8');

    expect(eslintContent).toContain('tseslint.configs.strict');
    expect(eslintContent).toContain('tseslint.configs.stylistic');
    expect(eslintContent).toContain('no-restricted-imports');
    expect(eslintContent).toContain('packages/domain/**/*.ts');
    expect(eslintContent).toContain('packages/application/**/*.ts');
  });

  it('enforces jscpd duplication threshold <= 10% and provides a clear DRY refactoring message when exceeded', () => {
    const passingSample = [
      'Clones:',
      'worker/src/index.ts 580-585 ~ 668-673',
      '---',
      '13 clones · 1.7% duplication',
      '---',
      'Summary by tokens (17 files, 11 folders):',
      'files (tokens/lines/size/cx/dup%):',
      'worker/src/index.ts 8206/1277/43.8K/287/8.7%',
    ].join('\n');

    const passResult = evaluateDuplicationOutput(passingSample, 10);
    expect(passResult.valid).toBe(true);
    expect(passResult.totalDuplicationPercent).toBe(1.7);
    expect(passResult.violatingFiles).toHaveLength(0);

    const failingSample = [
      'Clones:',
      'worker/src/index.ts 542-560 ~ 660-678',
      '---',
      '18 clones · 11.4% duplication',
      '---',
      'Summary by tokens (17 files, 11 folders):',
      'files (tokens/lines/size/cx/dup%):',
      'worker/src/index.ts 8364/1297/44.5K/292/12.5%',
    ].join('\n');

    const failResult = evaluateDuplicationOutput(failingSample, 10);
    expect(failResult.valid).toBe(false);
    expect(failResult.totalDuplicationPercent).toBe(11.4);
    expect(failResult.violatingFiles).toEqual([
      { file: 'worker/src/index.ts', duplicationPercent: 12.5 },
    ]);
    expect(failResult.message).toContain('Code Duplication Threshold Exceeded (> 10%)');
    expect(failResult.message).toContain(
      'Please refactor duplicated code blocks using DRY extraction strategies',
    );
    expect(failResult.message).toContain('sops/jscpd-dry-refactoring.md');
  });
});
