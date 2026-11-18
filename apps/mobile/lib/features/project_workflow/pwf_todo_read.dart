import 'package:machvon_api_client/machvon_api_client.dart';

import 'pwf_models.dart';

/// The size of a page of the person's open tasks, the one "Việc của tôi" (MOB-80) opens with.
const int pwfTodoPageSize = 50;

/// How many pages the count reads at most: 250 tasks. A person with more gets the count of those with a "+", never a number that looks whole.
const int pwfTodoMaxPages = 5;

/// Reads one page of the person's open tasks: the first with a null cursor, a following one with the cursor the page before gave.
typedef PwfTaskPageRead = Future<Object?> Function(String? cursor);

/// The page reader on the API (`getMyTasks`), the same question for the block of the home and for the head of "Việc của tôi".
PwfTaskPageRead pwfTaskPages(MachvonApiClient client) =>
    (String? cursor) => client.getMyTasks(query: <String, Object?>{'limit': pwfTodoPageSize, 'cursor': ?cursor});

/// The three figures "to do by band" over ALL the open tasks of the person (see [pwfTodoByBand]), by the person's own colours and by the official
/// ones, and whether there are tasks the count did not reach ([more]).
final class PwfTodoCount {
  const PwfTodoCount({required this.personal, required this.official, required this.more});

  final PwfTodoBands personal;
  final PwfTodoBands official;

  /// The count stopped before the end of the list (the bound of [pwfTodoMaxPages] was reached, or a following page could not be read): each figure
  /// is then "at least", and is written with a "+".
  final bool more;

  PwfTodoBands of({required bool personal}) => personal ? this.personal : official;

  bool get isZero => personal.red + personal.yellow + personal.green == 0;
}

/// A figure of the count as it is written: `60`, or `250+` when the count did not reach the end of the list.
String pwfTodoFigure(int value, {required bool more}) => more ? '$value+' : '$value';

/// The one count "to do by band" (L7b): the tasks of [first] and of every page after it, read with [readPage] until the cursor ends, at most
/// [pwfTodoMaxPages] pages in all. The block of the home and the head of "Việc của tôi" both use it, so the two say the same numbers however many
/// pages the person has. It never throws: a following page that fails or is not what the contract says ends the count there, marked [PwfTodoCount.more].
Future<PwfTodoCount> readPwfTodo(PwfMyTasks first, PwfTaskPageRead readPage) async {
  final List<PwfMyTask> tasks = <PwfMyTask>[...first.items];
  String? cursor = first.nextCursor;
  int pages = 1;
  while (cursor != null && pages < pwfTodoMaxPages) {
    PwfMyTasks? page;
    try {
      page = parsePwfMyTasks(await readPage(cursor));
    } on Object {
      page = null;
    }
    if (page == null) break;
    tasks.addAll(page.items);
    cursor = page.nextCursor;
    pages += 1;
  }
  return PwfTodoCount(personal: pwfTodoByBand(tasks), official: pwfTodoByBand(tasks, personal: false), more: cursor != null);
}
