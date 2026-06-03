/// Supreme Dart SDK (§6).
///
/// The only sanctioned way for Flutter clients to talk to the hub. Speaks pure
/// Supreme contracts — there is no Home Assistant concept anywhere in this API,
/// which is what protects the HA → Supreme-native migration on the backend.
library supreme_sdk;

export 'src/models.dart';
export 'src/client.dart';
export 'src/stream.dart';
