import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionInfrastructure } from '../../infrastructure/cloudflare/provision.mjs';

describe('Cloudflare Infrastructure Provisioner (IaC)', () => {
  let tmpDir: string;
  let testWranglerPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-provision-'));
    testWranglerPath = path.join(tmpDir, 'wrangler.toml');
    const initialWrangler = `name = 'agora-worker'
main = '../../apps/worker/src/index.ts'
compatibility_date = '2024-11-01'

[[d1_databases]]
binding = 'DB'
database_name = 'agora-d1'
database_id = 'placeholder-id'
migrations_dir = 'migrations'

[[r2_buckets]]
binding = 'ASSETS_BUCKET'
bucket_name = 'agora-assets'
`;
    fs.writeFileSync(testWranglerPath, initialWrangler, 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('fails with clear error if credentials are missing', async () => {
    await expect(
      provisionInfrastructure({
        accountId: '',
        apiToken: '',
        wranglerPath: testWranglerPath,
      }),
    ).rejects.toThrow('Missing required credentials');
  });

  it('creates D1 database and R2 bucket when they do not exist, updating wrangler.toml', async () => {
    const apiCalls: { url: string; method: string; body?: unknown }[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      apiCalls.push({ url, method, body });

      // 1. List D1: returns empty
      if (url.endsWith('/d1/database') && method === 'GET') {
        return new Response(JSON.stringify({ result: [], success: true }), { status: 200 });
      }

      // 2. Create D1: returns new UUID
      if (url.endsWith('/d1/database') && method === 'POST') {
        return new Response(
          JSON.stringify({
            result: { uuid: 'd1-uuid-created-1234', name: 'agora-d1' },
            success: true,
          }),
          { status: 200 },
        );
      }

      // 3. Check R2: 404 not found
      if (url.includes('/r2/buckets/agora-assets') && method === 'GET') {
        return new Response(JSON.stringify({ errors: [{ code: 10006 }] }), { status: 404 });
      }

      // 4. Create R2: 200 success
      if (url.endsWith('/r2/buckets') && method === 'POST') {
        return new Response(JSON.stringify({ result: { name: 'agora-assets' }, success: true }), {
          status: 200,
        });
      }

      return new Response('Not Found', { status: 404 });
    };

    const result = await provisionInfrastructure({
      accountId: 'test-account-123',
      apiToken: 'test-token-456',
      d1DatabaseName: 'agora-d1',
      r2BucketName: 'agora-assets',
      wranglerPath: testWranglerPath,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(result.d1DatabaseId).toBe('d1-uuid-created-1234');
    expect(result.r2BucketName).toBe('agora-assets');

    // Verify wrangler.toml was updated
    const updatedContent = fs.readFileSync(testWranglerPath, 'utf8');
    expect(updatedContent).toContain("database_id = 'd1-uuid-created-1234'");
    expect(updatedContent).not.toContain("database_id = 'placeholder-id'");
  });

  it('reuses existing D1 database and R2 bucket without creating duplicates', async () => {
    const apiCalls: { url: string; method: string }[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      apiCalls.push({ url, method });

      // 1. List D1: returns existing database
      if (url.endsWith('/d1/database') && method === 'GET') {
        return new Response(
          JSON.stringify({
            result: [{ uuid: 'd1-uuid-existing-9999', name: 'agora-d1' }],
            success: true,
          }),
          { status: 200 },
        );
      }

      // 2. Check R2: 200 exists
      if (url.includes('/r2/buckets/agora-assets') && method === 'GET') {
        return new Response(JSON.stringify({ result: { name: 'agora-assets' }, success: true }), {
          status: 200,
        });
      }

      return new Response('Unexpected call', { status: 500 });
    };

    const result = await provisionInfrastructure({
      accountId: 'test-account-123',
      apiToken: 'test-token-456',
      d1DatabaseName: 'agora-d1',
      r2BucketName: 'agora-assets',
      wranglerPath: testWranglerPath,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(result.d1DatabaseId).toBe('d1-uuid-existing-9999');

    // Confirm no POST requests were issued
    const postCalls = apiCalls.filter((c) => c.method === 'POST');
    expect(postCalls).toHaveLength(0);

    const updatedContent = fs.readFileSync(testWranglerPath, 'utf8');
    expect(updatedContent).toContain("database_id = 'd1-uuid-existing-9999'");
  });

  it('uses explicit d1DatabaseId directly when provided', async () => {
    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/r2/buckets/agora-assets')) {
        return new Response(JSON.stringify({ result: { name: 'agora-assets' }, success: true }), {
          status: 200,
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const result = await provisionInfrastructure({
      accountId: 'test-account-123',
      apiToken: 'test-token-456',
      d1DatabaseId: 'explicit-uuid-5555',
      r2BucketName: 'agora-assets',
      wranglerPath: testWranglerPath,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(result.d1DatabaseId).toBe('explicit-uuid-5555');
    const updatedContent = fs.readFileSync(testWranglerPath, 'utf8');
    expect(updatedContent).toContain("database_id = 'explicit-uuid-5555'");
  });

  it('registers workers.dev subdomain if not present and requestedSubdomain is provided', async () => {
    const apiCalls: { url: string; method: string; body?: unknown }[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      apiCalls.push({ url, method, body });

      if (url.includes('/r2/buckets/agora-assets')) {
        return new Response(JSON.stringify({ result: { name: 'agora-assets' }, success: true }), {
          status: 200,
        });
      }

      if (url.endsWith('/workers/subdomain') && method === 'GET') {
        return new Response(JSON.stringify({ result: null, success: true }), { status: 200 });
      }

      if (url.endsWith('/workers/subdomain') && method === 'PUT') {
        return new Response(
          JSON.stringify({
            result: { subdomain: (body as { subdomain?: string })?.subdomain },
            success: true,
          }),
          { status: 200 },
        );
      }

      return new Response('Not Found', { status: 404 });
    };

    const result = await provisionInfrastructure({
      accountId: 'test-account-123',
      apiToken: 'test-token-456',
      d1DatabaseId: 'd1-subdomain-test-id',
      r2BucketName: 'agora-assets',
      workersSubdomain: 'my-agora-subdomain',
      wranglerPath: testWranglerPath,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(result.workersSubdomain).toBe('my-agora-subdomain');
    const putSubdomain = apiCalls.find(
      (c) => c.url.endsWith('/workers/subdomain') && c.method === 'PUT',
    );
    expect(putSubdomain).toBeDefined();
    expect((putSubdomain?.body as { subdomain?: string })?.subdomain).toBe('my-agora-subdomain');
  });
});
