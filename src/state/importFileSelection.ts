export interface SelectedImportFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

let pendingImportFile: SelectedImportFile | null = null;

export function setPendingImportFile(file: SelectedImportFile) {
  pendingImportFile = file;
}

export function consumePendingImportFile() {
  const current = pendingImportFile;
  pendingImportFile = null;
  return current;
}
