/**
 * verify-sdlc-issue.mjs
 * Agora SDLC Enforcement Guardrail: Require PR associated to an open issue.
 *
 * Enforces that every pull request in the Agora repository is associated
 * with at least one active, open issue (e.g. 'Resolves #123' or 'Fixes #123').
 */

import fs from 'node:fs';
import https from 'node:https';

const DEFAULT_REPO = 'anyulled/agora';

/**
 * Extracts issue numbers referenced in text (PR body, PR title, commit messages).
 * Recognizes standard GitHub closing keywords, issue references, and issue URLs.
 *
 * @param {string} text
 * @returns {number[]} Array of unique issue numbers
 */
export function extractIssueReferences(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const issueNumbers = new Set();

  // Pattern 1: Closing keywords (e.g., Fixes #123, Closes #45, Resolves #67)
  const closingRegex =
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/|#)(\d+)/gi;
  for (const match of text.matchAll(closingRegex)) {
    if (match[1]) {
      issueNumbers.add(Number.parseInt(match[1], 10));
    }
  }

  // Pattern 2: Contextual keywords (e.g., Issue #123, Ref #45, For #67, Towards #89)
  const contextualRegex =
    /(?:issue|ref|refs|for|towards|related to)\s*:?\s*(?:https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/|#)(\d+)/gi;
  for (const match of text.matchAll(contextualRegex)) {
    if (match[1]) {
      issueNumbers.add(Number.parseInt(match[1], 10));
    }
  }

  // Pattern 3: Full issue URLs (e.g., https://github.com/anyulled/agora/issues/123)
  const urlRegex = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/gi;
  for (const match of text.matchAll(urlRegex)) {
    if (match[1]) {
      issueNumbers.add(Number.parseInt(match[1], 10));
    }
  }

  // Pattern 4: Standalone hashtag numbers (e.g., #123)
  const hashtagRegex = /(?:^|[\s(,])#(\d+)\b/g;
  for (const match of text.matchAll(hashtagRegex)) {
    if (match[1]) {
      issueNumbers.add(Number.parseInt(match[1], 10));
    }
  }

  return Array.from(issueNumbers).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Performs a GitHub API HTTP request.
 *
 * @param {string} endpoint
 * @param {string|null} token
 * @returns {Promise<{ status: number, data: any }>}
 */
export function defaultGithubFetch(endpoint, token = null) {
  return new Promise((resolve, reject) => {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const parsed = new URL(url);

    const headers = {
      'User-Agent': 'agora-sdlc-guardrail',
      Accept: 'application/vnd.github+json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : null;
            resolve({ status: res.statusCode || 200, data });
          } catch {
            resolve({ status: res.statusCode || 200, data: body });
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Validates that a pull request is associated with at least one OPEN issue.
 *
 * @param {object} pr - Pull request payload or object { number, title, body, head }
 * @param {object} options - { repo, token, fetchFn }
 * @returns {Promise<{ passed: boolean, openIssues: any[], closedIssues: any[], errors: string[] }>}
 */
export async function verifyPullRequestSDLC(pr, options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const token = options.token || process.env.GITHUB_TOKEN || null;
  const fetchFn = options.fetchFn || defaultGithubFetch;

  const combinedText = `${pr.title || ''}\n${pr.body || ''}`;
  const referencedNumbers = extractIssueReferences(combinedText);

  if (referencedNumbers.length === 0) {
    return {
      passed: false,
      openIssues: [],
      closedIssues: [],
      errors: [
        'No issue reference found in pull request title or description.\n' +
          'Please associate this PR with an open issue using closing syntax, e.g.:\n' +
          '  "Resolves #123" or "Fixes #123" or "Closes #123".',
      ],
    };
  }

  const openIssues = [];
  const closedIssues = [];
  const errors = [];

  for (const issueNum of referencedNumbers) {
    try {
      const res = await fetchFn(`/repos/${repo}/issues/${issueNum}`, token);
      if (res.status === 404) {
        errors.push(`Issue #${issueNum} does not exist in repository ${repo}.`);
        continue;
      }
      if (res.status !== 200) {
        errors.push(`Failed to inspect issue #${issueNum} (HTTP status ${res.status}).`);
        continue;
      }

      const issueData = res.data;
      // In GitHub API, PRs also return under /issues/:number, but have a pull_request property
      if (issueData.pull_request) {
        errors.push(
          `#${issueNum} is a Pull Request, not an Issue. SDLC requires associating with an open Issue.`,
        );
        continue;
      }

      if (issueData.state === 'open') {
        openIssues.push({
          number: issueData.number,
          title: issueData.title,
          url: issueData.html_url,
        });
      } else {
        closedIssues.push({
          number: issueData.number,
          title: issueData.title,
          state: issueData.state,
        });
      }
    } catch (err) {
      errors.push(`Error querying issue #${issueNum}: ${err.message || String(err)}`);
    }
  }

  if (openIssues.length > 0) {
    return {
      passed: true,
      openIssues,
      closedIssues,
      errors: [],
    };
  }

  const closedMsg =
    closedIssues.length > 0
      ? `Referenced issue(s) are already closed: ${closedIssues.map((i) => `#${i.number} (${i.state})`).join(', ')}.`
      : 'No referenced issues were open.';

  return {
    passed: false,
    openIssues: [],
    closedIssues,
    errors: [
      `${closedMsg}\nSDLC policy requires this pull request to be associated with an active, OPEN issue.`,
      ...errors,
    ],
  };
}

/**
 * CLI execution entrypoint
 */
export async function runCli() {
  const args = process.argv.slice(2);
  const isStrict = args.includes('--strict');
  const token = process.env.GITHUB_TOKEN || null;
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;

  let prNumber = null;
  let prBody = null;
  let prTitle = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pr' && args[i + 1]) {
      prNumber = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--body' && args[i + 1]) {
      prBody = args[i + 1];
      i++;
    } else if (args[i] === '--title' && args[i + 1]) {
      prTitle = args[i + 1];
      i++;
    }
  }

  // Check if running inside GitHub Actions pull_request event
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      if (eventData.pull_request) {
        prNumber = eventData.pull_request.number;
        prTitle = eventData.pull_request.title;
        prBody = eventData.pull_request.body;
      }
    } catch (e) {
      console.warn(`[WARN] Could not parse GITHUB_EVENT_PATH: ${e.message}`);
    }
  }

  // If a specific PR number was given via CLI, fetch its details
  if (prNumber && (!prTitle || prBody === null)) {
    console.log(`--> Fetching details for Pull Request #${prNumber}...`);
    try {
      const res = await defaultGithubFetch(`/repos/${repo}/pulls/${prNumber}`, token);
      if (res.status === 200 && res.data) {
        prTitle = res.data.title;
        prBody = res.data.body || '';
      }
    } catch (e) {
      console.error(`Failed to fetch PR #${prNumber}: ${e.message}`);
      process.exit(1);
    }
  }

  // If no PR context is detected:
  if (!prNumber && prBody === null) {
    if (isStrict) {
      console.error(
        '❌ [SDLC Enforcement] Error: Strict mode enabled and no pull request context found.',
      );
      process.exit(1);
    }
    console.log(
      '✅ [SDLC Enforcement] Local verification mode: No pull request context detected. Skipping check.',
    );
    process.exit(0);
  }

  console.log('======================================================');
  console.log(' Agora SDLC Guardrail: PR-to-Open-Issue Enforcement');
  console.log('======================================================');
  if (prNumber) {
    console.log(`Pull Request: #${prNumber}`);
  }
  if (prTitle) {
    console.log(`Title:        ${prTitle}`);
  }

  const result = await verifyPullRequestSDLC(
    { number: prNumber, title: prTitle, body: prBody },
    { repo, token },
  );

  if (result.passed) {
    console.log('\n✅ SDLC VERIFICATION PASSED:');
    for (const openIssue of result.openIssues) {
      console.log(`   • Linked to Open Issue #${openIssue.number}: "${openIssue.title}"`);
      if (openIssue.url) {
        console.log(`     ${openIssue.url}`);
      }
    }
    console.log('======================================================\n');
    process.exit(0);
  } else {
    console.error('\n❌ SDLC VERIFICATION FAILED:');
    for (const err of result.errors) {
      console.error(`   ${err}`);
    }
    console.log('======================================================\n');
    process.exit(1);
  }
}

// Execute when run directly as CLI
const isDirectCall =
  process.argv[1] &&
  (process.argv[1].endsWith('verify-sdlc-issue.mjs') ||
    process.argv[1].includes('verify-sdlc-issue'));

if (isDirectCall) {
  runCli().catch((err) => {
    console.error(`Unexpected SDLC verification error: ${err.stack || err}`);
    process.exit(1);
  });
}
