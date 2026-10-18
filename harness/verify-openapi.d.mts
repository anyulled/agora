export interface OpenApiVerificationReport {
  passed: boolean;
  pathCount: number;
  schemaCount: number;
  errors: string[];
}

export function normalizeRoutePattern(routePath: string): string;
export function extractWorkerRoutes(workerSource: string): string[];
export function verifyOpenApiSpec(
  spec: Record<string, unknown>,
  workerSource?: string,
): OpenApiVerificationReport;
export function verifyWorkspaceOpenApi(): OpenApiVerificationReport;
