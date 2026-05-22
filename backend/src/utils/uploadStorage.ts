import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import pdfParse from 'pdf-parse';

export const UPLOAD_DIR = join(process.cwd(), 'data', 'uploads');

export function saveUploadFile(r2Key: string, buffer: Buffer): void {
  const fullPath = join(UPLOAD_DIR, r2Key);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, buffer);
}

export function isAllowedUpload(_mimetype: string, originalName: string): boolean {
  const dot = originalName.toLowerCase().lastIndexOf('.');
  if (dot < 0) return false;
  const ext = originalName.toLowerCase().slice(dot);
  return ext === '.pdf' || ext === '.ppt' || ext === '.pptx';
}

export async function extractUploadText(
  buffer: Buffer,
  mimetype: string,
  originalName: string,
): Promise<{ parsedText?: string; parseStatus: 'pending' | 'success' | 'failed' }> {
  const isPdf =
    mimetype === 'application/pdf' || originalName.toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    return { parseStatus: 'pending' };
  }

  try {
    const result = await pdfParse(buffer);
    const text = result.text?.trim();
    if (!text) return { parseStatus: 'failed' };
    return { parsedText: text.slice(0, 50_000), parseStatus: 'success' };
  } catch {
    return { parseStatus: 'failed' };
  }
}
