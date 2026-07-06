/// Homeowner-friendly errors (§ Errors) — mirrors the web helper. Turns whatever the network or
/// backend throws into a calm, plain-language line (what happened + what to do), never a stack
/// trace, HTTP code, or protocol detail. Installer/Developer surfaces may keep raw errors.
String friendlyError(Object? e, [String fallback = 'Something went wrong. Please try again.']) {
  final raw = e?.toString() ?? '';
  final msg = raw.toLowerCase();

  if (RegExp(r'socket|failed host lookup|connection|timeout|timed out|network|unreachable|clientexception').hasMatch(msg)) {
    return "Can't reach your home right now. Check it's powered on and connected, then try again.";
  }
  if (RegExp(r'\b401\b|unauthor|not authenticated|invalid token|session').hasMatch(msg)) {
    return 'Your session has expired. Please sign in again.';
  }
  if (RegExp(r'\b403\b|forbidden|not allowed|permission|denied').hasMatch(msg)) {
    return "You don't have permission to do that. Ask your home's owner for access.";
  }
  if (RegExp(r'\b404\b|not found').hasMatch(msg)) {
    return "That's no longer available — it may have been removed.";
  }
  if (RegExp(r'\b409\b|conflict|already exists|duplicate').hasMatch(msg)) {
    return 'That name is already in use. Try a different one.';
  }
  if (RegExp(r'\b5\d\d\b|internal|server error').hasMatch(msg)) {
    return 'Your home ran into a problem completing that. Please try again in a moment.';
  }
  // A short, clean sentence (no code/JSON/stack/URL) is safe to show as-is.
  if (raw.isNotEmpty && raw.length < 80 && !RegExp(r'[{}<>]|https?:|exception|/v1/').hasMatch(msg)) {
    return raw;
  }
  return fallback;
}
