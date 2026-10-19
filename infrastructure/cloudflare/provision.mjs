import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @typedef {Object} ProvisionOptions
 * @property {string} [accountId]
 * @property {string} [apiToken]
 * @property {string} [d1DatabaseName]
 * @property {string} [r2BucketName]
 * @property {string} [wranglerPath]
 * @property {typeof fetch} [fetchFn]
 */

/**
 * Idempotently provisions Cloudflare D1 database and R2 bucket,
 * then updates wrangler.toml with the resolved D1 database UUID.
 */
export async function provisionInfrastructure(options = {}) {
  const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN;
  const d1DatabaseName = options.d1DatabaseName || 'agora-d1';
  const r2BucketName = options.r2BucketName || 'agora-assets';
  const wranglerPath = options.wranglerPath || path.resolve(__dirname, 'wrangler.toml');
  const fetchFn = options.fetchFn || fetch;

  if (!accountId || !apiToken) {
    throw new Error(
      'Missing required credentials: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set.',
    );
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  console.log('----------------------------------------------------');
  console.log(' Agora Cloudflare Infrastructure Provisioner (IaC)');
  console.log('----------------------------------------------------');
  console.log(`Account ID: ${accountId.slice(0, 6)}...${accountId.slice(-4)}`);
  console.log(`Target D1:  ${d1DatabaseName}`);
  console.log(`Target R2:  ${r2BucketName}`);
  console.log('----------------------------------------------------');

  // 1. Provision / Resolve D1 Database
  let d1DatabaseId = options.d1DatabaseId || process.env.CLOUDFLARE_D1_DATABASE_ID || null;

  if (d1DatabaseId) {
    console.log(`--> Using provided D1 database ID: ${d1DatabaseId}`);
  } else {
    console.log(`--> Checking D1 database: '${d1DatabaseName}'...`);
    const d1ListRes = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
      { method: 'GET', headers },
    );

    if (!d1ListRes.ok) {
      const errorText = await d1ListRes.text();
      throw new Error(
        `Failed to query Cloudflare D1 databases (status ${d1ListRes.status}): ${errorText}`,
      );
    }

    const d1ListData = await d1ListRes.json();
    const existingD1 = (d1ListData.result || []).find((item) => item.name === d1DatabaseName);

    if (existingD1?.uuid) {
      d1DatabaseId = existingD1.uuid;
      console.log(`    [OK] D1 database '${d1DatabaseName}' exists. UUID: ${d1DatabaseId}`);
    } else {
      console.log(`    [+] D1 database '${d1DatabaseName}' not found. Creating...`);
      const d1CreateRes = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: d1DatabaseName }),
        },
      );

      if (!d1CreateRes.ok) {
        const errorText = await d1CreateRes.text();
        throw new Error(
          `Failed to create Cloudflare D1 database (status ${d1CreateRes.status}): ${errorText}`,
        );
      }

      const d1CreateData = await d1CreateRes.json();
      d1DatabaseId = d1CreateData.result?.uuid;
      if (!d1DatabaseId) {
        throw new Error(
          `Cloudflare D1 creation succeeded but no UUID was returned: ${JSON.stringify(d1CreateData)}`,
        );
      }
      console.log(
        `    [CREATED] D1 database '${d1DatabaseName}' created with UUID: ${d1DatabaseId}`,
      );
    }
  }

  // 2. Provision / Resolve R2 Bucket
  console.log(`--> Checking R2 bucket: '${r2BucketName}'...`);
  const r2GetRes = await fetchFn(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(r2BucketName)}`,
    { method: 'GET', headers },
  );

  if (r2GetRes.ok) {
    console.log(`    [OK] R2 bucket '${r2BucketName}' already exists.`);
  } else if (r2GetRes.status === 404) {
    console.log(`    [+] R2 bucket '${r2BucketName}' not found. Creating...`);
    const r2CreateRes = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: r2BucketName }),
      },
    );

    if (!r2CreateRes.ok && r2CreateRes.status !== 409) {
      const errorText = await r2CreateRes.text();
      throw new Error(
        `Failed to create Cloudflare R2 bucket (status ${r2CreateRes.status}): ${errorText}`,
      );
    }
    console.log(`    [CREATED] R2 bucket '${r2BucketName}' successfully created.`);
  } else {
    const errorText = await r2GetRes.text();
    if (r2GetRes.status === 403 && errorText.includes('Please enable R2')) {
      throw new Error(
        "Cloudflare R2 is not yet enabled for this account. Please open your Cloudflare Dashboard, navigate to 'R2 Object Storage' in the sidebar, and click 'Get Started' (or 'Enable R2') to activate the R2 service.",
      );
    }
    throw new Error(
      `Failed to verify Cloudflare R2 bucket (status ${r2GetRes.status}): ${errorText}`,
    );
  }

  // 3. Verify / Configure workers.dev Subdomain
  console.log('--> Checking workers.dev subdomain...');
  let workersSubdomain = null;
  try {
    const subdomainRes = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { method: 'GET', headers },
    );
    if (subdomainRes.ok) {
      const subData = await subdomainRes.json();
      workersSubdomain = subData.result?.subdomain || null;
    }
  } catch {
    // Ignore network error in dry-run/mock environments
  }

  const requestedSubdomain = options.workersSubdomain || process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (!workersSubdomain && requestedSubdomain) {
    console.log(`    [+] Registering requested workers.dev subdomain: '${requestedSubdomain}'...`);
    try {
      const putSubdomainRes = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ subdomain: requestedSubdomain }),
        },
      );
      if (putSubdomainRes.ok) {
        workersSubdomain = requestedSubdomain;
        console.log(
          `    [CREATED] Registered workers.dev subdomain: ${workersSubdomain}.workers.dev`,
        );
      } else {
        const errText = await putSubdomainRes.text();
        console.warn(`    [WARN] Could not register workers.dev subdomain: ${errText}`);
      }
    } catch {
      // Ignore
    }
  }

  if (workersSubdomain) {
    console.log(`    [OK] workers.dev subdomain: ${workersSubdomain}.workers.dev`);
    console.log(
      `    [URL] Worker URL will be: https://agora-worker.${workersSubdomain}.workers.dev`,
    );
  } else {
    console.log(
      '    [ACTION REQUIRED] No workers.dev subdomain is registered on this Cloudflare account.',
    );
    console.log(
      `    --> Register your free subdomain in Cloudflare Dashboard: https://dash.cloudflare.com/${accountId}/workers/onboarding`,
    );
    console.log(
      '    --> Or add CLOUDFLARE_WORKERS_SUBDOMAIN to GitHub Secrets to register it via CI.',
    );
  }

  // 4. Update wrangler.toml with resolved database_id
  console.log(`--> Synchronizing wrangler configuration at ${wranglerPath}...`);
  if (!fs.existsSync(wranglerPath)) {
    throw new Error(`Wrangler configuration file not found at: ${wranglerPath}`);
  }

  const rawWrangler = fs.readFileSync(wranglerPath, 'utf8');
  const d1Regex = /database_id\s*=\s*['"][^'"]*['"]/;

  if (!d1Regex.test(rawWrangler)) {
    throw new Error(`Could not find 'database_id' field under d1_databases in: ${wranglerPath}`);
  }

  const updatedWrangler = rawWrangler.replace(d1Regex, `database_id = '${d1DatabaseId}'`);
  fs.writeFileSync(wranglerPath, updatedWrangler, 'utf8');
  console.log(
    `    [UPDATED] Set database_id = '${d1DatabaseId}' in ${path.basename(wranglerPath)}`,
  );

  // 4. Export to GITHUB_ENV if running in GitHub Actions CI
  if (process.env.GITHUB_ENV && fs.existsSync(process.env.GITHUB_ENV)) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `AGORA_D1_DATABASE_ID=${d1DatabaseId}\nAGORA_R2_BUCKET=${r2BucketName}\n`,
      'utf8',
    );
    console.log('    [CI] Exported AGORA_D1_DATABASE_ID to GITHUB_ENV.');
  }

  console.log('----------------------------------------------------');
  console.log(' Agora Cloudflare Infrastructure Provisioning Complete');
  console.log('----------------------------------------------------');

  return {
    accountId,
    d1DatabaseName,
    d1DatabaseId,
    r2BucketName,
    workersSubdomain,
  };
}

// CLI runner
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  provisionInfrastructure().catch((error) => {
    console.error(`❌ IaC Provisioning Failed: ${error.message}`);
    process.exit(1);
  });
}
