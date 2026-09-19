import AVFoundation
import CallKit
import Foundation
import PushKit

/// SupremeOS Phase 13.4 - iOS VoIP wake + CallKit foundation.
///
/// Apple's sanctioned incoming-call architecture, and the ONLY thing this file implements:
///   1. `PKPushRegistry` registered for `.voIP` push type ONLY (never used as generic
///      background execution, continuous wake, or a second push channel - §"PUSHKIT": a VoIP
///      push exists to announce ONE incoming call, nothing else).
///   2. On `didReceiveIncomingPushWith`, Apple REQUIRES reporting a call to CallKit
///      (`CXProvider.reportNewIncomingCall`) SYNCHRONOUSLY within that callback, before doing
///      anything else - failing to do so risks the OS revoking the app's VoIP entitlement. This
///      happens regardless of whether a Flutter engine/Dart isolate is currently alive.
///   3. `CXProvider`/`CXProviderDelegate` owns OS-level call presentation (the native "answer
///      swipe" UI, the in-call system screen). Flutter/Dart never renders any of that - it only
///      OBSERVES the resulting state via `com.supremeos/runtime/events`.
///
/// HONEST STATUS: none of this can be exercised without a real Apple Developer account, a real
/// VoIP-enabled APNs certificate/key, a real Hub sending a real VoIP push, and a real device -
/// none of which exist in this repository or environment. This class is REAL, uncompiled Swift
/// (no macOS/Xcode on this machine - see Phase 13.0/13.1's own environment findings), not a
/// simulation of the behavior described above.
final class VoipCallManager: NSObject {
  private let pushRegistry = PKPushRegistry(queue: nil)
  private let provider: CXProvider
  private let callController = CXCallController()

  /// §"MULTI-HOME": a CallKit `UUID` is opaque to CallKit itself - it carries no Home identity.
  /// This map is the ONLY place that association lives, keyed by the call's own UUID, holding
  /// ONLY the canonical `hubId` (never a bearer token, never any secret - §"SECURITY").
  private var callHomeMap: [UUID: String] = [:]

  /// Set by `AppDelegate` once a Flutter engine/EventChannel sink exists. Events reported before
  /// that happens are queued (§"RUNTIME REACTIVATION") - CallKit presentation above is NEVER
  /// blocked on this; only the Dart-side state MIRROR is.
  var emitEvent: (([String: Any]) -> Void)?
  private var pendingEvents: [[String: Any]] = []

  override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false // §"PROHIBITED IN THIS PHASE": no video this phase.
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
    pushRegistry.delegate = self
    pushRegistry.desiredPushTypes = [.voIP]
  }

  /// Flushes anything queued before a Dart-side listener attached. Called by `AppDelegate` the
  /// moment its EventChannel `onListen` fires.
  func flushPendingEvents() {
    guard let emit = emitEvent else { return }
    let queued = pendingEvents
    pendingEvents.removeAll()
    for event in queued { emit(event) }
  }

  private func emit(_ event: [String: Any]) {
    if let emit = emitEvent {
      emit(event)
    } else {
      pendingEvents.append(event)
    }
  }
}

// MARK: - PKPushRegistryDelegate

extension VoipCallManager: PKPushRegistryDelegate {
  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let hex = credentials.token.map { String(format: "%02.2hhx", $0) }.joined()
    emit(["type": "voipTokenRefreshed", "token": hex])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    emit(["type": "voipTokenRefreshed", "token": ""])
  }

  /// §"PUSHKIT": the ONLY legitimate reason this fires is an incoming SupremeOS doorphone call.
  /// The payload (§"PushEnvelope") carries ONLY routing identity - `hubId` and a `callId` - NEVER
  /// a bearer token, private key, or Home secret (§"SECURITY"). Reports to CallKit BEFORE doing
  /// anything else, exactly as Apple requires.
  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }
    let data = payload.dictionaryPayload
    guard
      let hubId = data["hubId"] as? String, !hubId.isEmpty,
      let callIdString = data["callId"] as? String,
      let callId = UUID(uuidString: callIdString)
    else {
      // Malformed VoIP envelope (§"TESTING": "malformed push", "VoIP envelope validation") -
      // dropped, never reported to CallKit with fabricated identity, never crashes.
      completion()
      return
    }

    callHomeMap[callId] = hubId

    let update = CXCallUpdate()
    // No homeowner-facing display name is guessed from the payload - the payload's whole job is
    // routing identity, not presentation content (§"CallKit metadata" secrecy requirement
    // extends to "never invent content either").
    update.remoteHandle = CXHandle(type: .generic, value: "SupremeOS Doorphone")
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    provider.reportNewIncomingCall(with: callId, update: update) { [weak self] error in
      guard let self else { return }
      if let error {
        self.callHomeMap.removeValue(forKey: callId)
        self.emit(["type": "incomingCallFailed", "callId": callIdString, "reason": error.localizedDescription])
      } else {
        self.emit(["type": "incomingCall", "callId": callIdString, "hubId": hubId])
        // §"CALL STATE": `MobileRuntime`'s own legal-transition table only allows
        // incoming -> {ringing, ended, failed} - by the time CallKit's completion handler
        // fires successfully, the system IS presenting/ringing the call, so "ringing" is the
        // real, correct next state, not a skipped formality.
        self.emit([
          "type": "callStateChanged", "callId": callIdString, "hubId": hubId, "state": "ringing",
        ])
      }
      completion()
    }
  }
}

// MARK: - CXProviderDelegate

extension VoipCallManager: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    callHomeMap.removeAll()
  }

  /// §"ANSWERING A CALL": this method does EXACTLY ONE thing - report the OS-level answer to
  /// Dart as a state transition. It NEVER issues a Hub command, NEVER touches door-release, and
  /// NEVER calls any authenticated transport. The eventual unlock action requires an explicit,
  /// separate homeowner tap inside the Flutter-rendered call screen, going through the existing
  /// authenticated Home command path - unchanged, and NOT built in this phase.
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let hubId = callHomeMap[action.callUUID] else {
      action.fail()
      return
    }
    emit([
      "type": "callStateChanged", "callId": action.callUUID.uuidString,
      "hubId": hubId, "state": "connecting",
    ])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let hubId = callHomeMap[action.callUUID]
    callHomeMap.removeValue(forKey: action.callUUID)
    emit([
      "type": "callStateChanged", "callId": action.callUUID.uuidString,
      "hubId": hubId ?? "", "state": "ended",
    ])
    action.fulfill()
  }

  /// §"AUDIO": establishes the audio-session HOOK ONLY - no RTP/media is started here (§
  /// "PROHIBITED IN THIS PHASE"). A future phase (real SIP media) is what actually routes audio
  /// through this session.
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    // Intentionally empty this phase - see class doc's HONEST STATUS. Establishing the category
    // here without any real media consumer would be exactly the "fake it" pattern this
    // project's conventions forbid.
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}
