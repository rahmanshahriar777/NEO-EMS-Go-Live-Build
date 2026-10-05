/**
 * Ambient types for the `file-type` package (declared in apps/api/package.json
 * as ^22.1.1; installed by the package-merge step — NOT yet in node_modules).
 *
 * file-type v22 is ESM-only: import it with `await import('file-type')`, never
 * require(). This declaration keeps tsc green until the install lands; the
 * declared shape matches the real package's `fileTypeFromBuffer` API.
 */
declare module 'file-type' {
  export interface FileTypeResult {
    readonly ext: string;
    readonly mime: string;
  }
  export function fileTypeFromBuffer(
    buffer: Uint8Array | ArrayBuffer,
  ): Promise<FileTypeResult | undefined>;
}
