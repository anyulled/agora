export interface ProvisionOptions {
  accountId?: string;
  apiToken?: string;
  d1DatabaseName?: string;
  d1DatabaseId?: string;
  r2BucketName?: string;
  wranglerPath?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionResult {
  accountId: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
  r2BucketName: string;
}

export function provisionInfrastructure(options?: ProvisionOptions): Promise<ProvisionResult>;
