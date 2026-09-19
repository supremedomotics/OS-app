import 'sip_domain.dart';

/// One SIP-engine-level call — the shape `SipEngine` reports, before `SipService` maps it onto
/// the homeowner-facing `CallSession`/`CallState` (`home_event.dart`). [remoteUri] is the raw SIP
/// identity that rang; `SipService` is responsible for resolving it to a configured door station.
class SipCall {
  final String callId;
  final String hubId;
  final SipCallDirection direction;
  final SipCallState state;
  final String remoteUri;
  final SipCodec? negotiatedCodec;
  final SipAudioState audio;
  final SipFailure? failure;

  const SipCall({
    required this.callId,
    required this.hubId,
    required this.direction,
    required this.state,
    required this.remoteUri,
    this.negotiatedCodec,
    this.audio = const SipAudioState(),
    this.failure,
  });

  SipCall copyWith({
    SipCallState? state,
    SipCodec? negotiatedCodec,
    SipAudioState? audio,
    SipFailure? failure,
  }) =>
      SipCall(
        callId: callId,
        hubId: hubId,
        direction: direction,
        state: state ?? this.state,
        remoteUri: remoteUri,
        negotiatedCodec: negotiatedCodec ?? this.negotiatedCodec,
        audio: audio ?? this.audio,
        failure: failure ?? this.failure,
      );
}
