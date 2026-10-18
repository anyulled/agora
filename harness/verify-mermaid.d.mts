export interface MermaidBlock {
  index: number;
  startLine: number;
  endLine: number;
  code: string;
}

export interface MermaidValidationResult {
  valid: boolean;
  diagramType?: string;
  error?: string;
}

export interface MermaidWorkspaceReport {
  passed: boolean;
  filesChecked: number;
  diagramsValidated: number;
  errors: Array<{
    file: string;
    blockIndex: number;
    startLine: number;
    error: string;
  }>;
}

export function extractMermaidBlocks(markdown: string): MermaidBlock[];
export function validateMermaidDiagram(code: string): Promise<MermaidValidationResult>;
export function collectMarkdownFiles(dir?: string, results?: string[]): string[];
export function verifyWorkspaceMermaidDiagrams(
  targetFiles?: string[],
): Promise<MermaidWorkspaceReport>;
