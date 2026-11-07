/** Hands the bytes of a file to the browser as a download; nothing is stored. The address of the blob is released at once. */
export function saveBytes(bytes: Uint8Array, fileName: string, contentType: string): void {
  const blob = new Blob([bytes as BlobPart], { type: contentType });
  const address = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = address;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(address);
}
