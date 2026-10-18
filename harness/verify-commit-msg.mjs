import fs from 'node:fs';
import { execSync } from 'node:child_process';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const COMMIT_RE =
  /^(?<type>feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\((?<scope>[^\)]+)\))?(?<breaking>!)?:\s+(?<subject>.+)$/;

export function validateCommitMessage(rawMessage) {
  const errors = [];
  if (!rawMessage || typeof rawMessage !== 'string') {
    return { valid: false, errors: ['Commit message is empty or invalid'] };
  }

  const lines = rawMessage.trim().split(/\r?\n/);
  const header = lines[0] || '';

  if (!header.trim()) {
    return { valid: false, errors: ['Commit message header is empty'] };
  }

  // Allow Merge and Revert commits automatically or standard conventional commits
  if (
    header.startsWith('Merge ') ||
    header.startsWith('Revert "') ||
    header.startsWith('revert:')
  ) {
    return { valid: true, errors: [] };
  }

  if (header.length > 100) {
    errors.push(`Header length must be no more than 100 characters (got ${header.length})`);
  }

  const match = header.match(COMMIT_RE);
  if (!match) {
    errors.push(
      `Commit message header does not follow conventional commit format: <type>(<scope>)!? <subject>. Types allowed: ${TYPES.join(', ')}`,
    );
  } else {
    const subject = match.groups.subject;
    if (!subject || !subject.trim()) {
      errors.push('Commit message subject cannot be empty');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  let message = '';
  const args = process.argv.slice(2);

  if (args.includes('--last')) {
    try {
      message = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
    } catch (e) {
      console.error('Failed to read last git commit:', e.message);
      process.exit(1);
    }
  } else {
    const msgIdx = args.indexOf('--message');
    if (msgIdx !== -1 && args[msgIdx + 1]) {
      message = args[msgIdx + 1];
    } else if (args[0]) {
      const filePath = args[0];
      try {
        message = fs.readFileSync(filePath, 'utf8').trim();
      } catch {
        // Fallback to direct string if not a file
        message = args.join(' ');
      }
    } else {
      console.error('Usage: node verify-commit-msg.mjs [--last | --message "<msg>" | <file-path>]');
      process.exit(1);
    }
  }

  const result = validateCommitMessage(message);
  if (!result.valid) {
    console.error('Invalid commit message:');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  } else {
    console.log('Commit message is valid.');
    process.exit(0);
  }
}
