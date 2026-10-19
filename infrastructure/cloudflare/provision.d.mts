export interface ProvisionOptions {
  accountId?: string;
  apiToken?: string;
  d1DatabaseName?: string;
  d1DatabaseId?: string;
  r2BucketName?: string;
  workersSubdomain?: string;
  wranglerPath?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionResult {
  accountId: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
  r2BucketName: string;
  workersSubdomain?: string | null;
}

export function provisionInfrastructure(options?: ProvisionOptions): Promise<ProvisionResult>;
