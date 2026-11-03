import 'dart:io';

import 'package:path/path.dart' as p;

/// The JSON keys under which the drafts of the field features name a file of a photograph: the prepared one (`path`) and the one
/// kept as it was taken (`original_path`).
const Set<String> kDraftFileKeys = <String>{'path', 'original_path'};

/// The files inside [folder] that [fields] of a draft name, wherever they are nested. A path that points anywhere else is never
/// returned: the walk can only find what the application itself put in its private folder.
List<File> draftFilesInside(Directory folder, Object? fields) {
  final String root = p.canonicalize(folder.path);
  final List<File> found = <File>[];
  void walk(Object? node) {
    if (node is Map<Object?, Object?>) {
      for (final MapEntry<Object?, Object?> entry in node.entries) {
        final Object? value = entry.value;
        if (value is String && kDraftFileKeys.contains(entry.key) && p.isWithin(root, p.canonicalize(value))) {
          found.add(File(value));
        } else {
          walk(value);
        }
      }
    } else if (node is List<Object?>) {
      node.forEach(walk);
    }
  }

  walk(fields);
  return found;
}

/// Deletes the files that [fields] of a draft name inside [folder]: the draft was accepted by the server, the photographs it
/// carries are on the server, and a plain copy of them (with the place and time of a person who agreed to it) has no further use on
/// the phone. Returns how many files were deleted.
int retireDraftFiles(Directory folder, Object? fields) {
  int deleted = 0;
  for (final File file in draftFilesInside(folder, fields)) {
    if (!file.existsSync()) continue;
    file.deleteSync();
    deleted += 1;
  }
  return deleted;
}
