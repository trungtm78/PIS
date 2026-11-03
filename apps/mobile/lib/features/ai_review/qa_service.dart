import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/wire.dart';
import 'ai_models.dart';

/// The longest question the server takes (`searchProposalPassages`, `question` maxLength).
const int maxQuestionLength = 4000;

/// How many passages a question asks for; the server allows 20 and a phone reads a few.
const int passagesAsked = 5;

/// The code shown when a question was refused for want of a citation in the person's scope. It is the code of the gateway's rule
/// (an answer with no citation is rejected, BR-LLM-11), so the phone and the web speak of the same refusal.
const String noCitationCode = 'REJECTED_NO_CITATION';

/// Shown when the server holds no embedding model the person may use, so that no question can be ranked.
const String noEmbeddingModelCode = 'EMBEDDING_MODEL_UNAVAILABLE';

/// What a question came to: passages with a place each, a refusal, no model to rank with, or a failure. There is no
/// generated text and nothing to apply.
sealed class QaResult {
  const QaResult();
}

/// The nearest passages of the files the person may read, each with its file and page.
final class QaPassages extends QaResult {
  const QaPassages(this.passages);

  final List<Passage> passages;
}

/// Retrieval returned nothing in the person's scope, so there is nothing to cite and nothing to say (AC-ST-MOB-030-1).
final class QaRefused extends QaResult {
  const QaRefused();
}

/// No approved embedding model the person can read: no question can be ranked, so none is asked (`EMBEDDING_MODEL_UNAVAILABLE`).
final class QaNoModel extends QaResult {
  const QaNoModel();
}

/// The question could not be asked or answered (offline, a refusal of the server, no model).
final class QaFailed extends QaResult {
  const QaFailed(this.error);

  final Object error;
}

/// How the approved embedding model that ranks the passages is found. The phone does not choose a model: it uses the one the tenant
/// approved for retrieval. The default asks the model register, which needs `llm.provider.read` while the retrieval itself needs only
/// `bid.evaluate`; no operation hands the model to a person who holds only the second, so for that person the register is closed and
/// the answer is "no model" (see docs/mob-ai-review.md). A tenant that fixes the model differently overrides this.
abstract interface class EmbeddingModelResolver {
  /// The id of the approved embedding model, or null when there is none the person can read.
  Future<String?> resolve(MachvonApiClient client);
}

final class RegisterEmbeddingModelResolver implements EmbeddingModelResolver {
  const RegisterEmbeddingModelResolver();

  @override
  Future<String?> resolve(MachvonApiClient client) async {
    final Object? raw;
    try {
      raw = await client.execute('listAiModels');
    } on ApiError catch (error) {
      // The register is closed to this person (retrieval needs less than reading it): there is no model they can be given, which is
      // not a refusal of the question, and nothing is asked without one.
      if (error.status == 403) return null;
      rethrow;
    }
    final Json? body = asRecord(raw);
    String? chosen;
    String? chosenAt;
    for (final Object? item in listOf(body?['items'])) {
      final Json? row = asRecord(item);
      final String? id = filled(row?['id']);
      if (row == null || id == null || row['status'] != 'APPROVED' || asRecord(row['capabilities'])?['embedding'] != true) continue;
      final String at = text(row['created_at']) ?? '';
      if (chosen == null || at.compareTo(chosenAt ?? '') > 0) {
        chosen = id;
        chosenAt = at;
      }
    }
    return chosen;
  }
}

final Provider<EmbeddingModelResolver> embeddingModelResolverProvider = Provider<EmbeddingModelResolver>((Ref ref) => const RegisterEmbeddingModelResolver());

/// A question the person cannot ask: empty, or longer than the server takes.
enum QuestionProblem { empty, tooLong }

QuestionProblem? checkQuestion(String question) {
  final String trimmed = question.trim();
  if (trimmed.isEmpty) return QuestionProblem.empty;
  if (trimmed.length > maxQuestionLength) return QuestionProblem.tooLong;
  return null;
}

/// Asks a question about the proposals of one package. Retrieval is the server's: the files it may be answered from are those of the
/// proposals the person has the full view of, decided before any text is compared, so the phone adds no filter of its own and shows
/// only what comes back. The question is sent as a query of this one request and is kept nowhere: not in a location, not in a copy, not
/// in a log.
class CitedQa {
  const CitedQa({required this.client, required this.resolver});

  final MachvonApiClient client;
  final EmbeddingModelResolver resolver;

  Future<QaResult> ask({required String packageId, required String question}) async {
    try {
      final String? model = await resolver.resolve(client);
      if (model == null) return const QaNoModel();
      final Object? raw = await client.execute(
        'searchProposalPassages',
        path: <String, Object?>{'id': packageId},
        query: <String, Object?>{'embedding_model_id': model, 'question': question.trim(), 'limit': passagesAsked},
      );
      final List<Passage>? passages = parsePassages(raw);
      if (passages == null) return const QaFailed(ContractMismatch('response', 'does not hold what the screen needs'));
      return passages.isEmpty ? const QaRefused() : QaPassages(passages);
    } on Object catch (error) {
      return QaFailed(error);
    }
  }
}
