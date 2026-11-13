import 'dart:io';

/// Deletes a temporary directory of a test. Windows refuses to delete a file that a scanner or a task that is still finishing holds open
/// (errno 32); the hold is short, so the delete is tried again a few times before the error is let through. A directory that is already
/// gone is not an error.
Future<void> removeTempDirectory(Directory directory) async {
  for (int attempt = 0;; attempt += 1) {
    try {
      if (directory.existsSync()) directory.deleteSync(recursive: true);
      return;
    } on FileSystemException {
      if (attempt >= 20) rethrow;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }
}

/// Deletes one file, with the same patience.
Future<void> removeTempFile(File file) async {
  for (int attempt = 0;; attempt += 1) {
    try {
      if (file.existsSync()) file.deleteSync();
      return;
    } on FileSystemException {
      if (attempt >= 20) rethrow;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }
}
