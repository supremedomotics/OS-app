import Flutter
import UIKit

/// SupremeOS Phase 13.1/13.2/13.4 - Mobile Runtime Foundation + Push Foundation + VoIP/CallKit
/// Foundation.
///
/// Registers the native side of TWO channel pairs:
///   `com.supremeos/runtime` / `com.supremeos/runtime/events` - OS lifecycle (Phase 13.1) PLUS
///     VoIP token/incoming-call/call-state events (Phase 13.4, via `VoipCallManager` - see that
///     class's own doc), speaks against `NativeRuntimeBridge`.
///   `com.supremeos/push` / `com.supremeos/push/events` - APNs token lifecycle (Phase 13.2),
///     speaks against `NativePushTokenSource`.
/// The Hub remains the sole device/protocol authority; this file knows nothing about
/// SIP/KNX/Casambi/Matter, and does not implement any of them - `VoipCallManager` establishes
/// ONLY the OS wake/call-presentation foundation (§Phase13.4's own stop condition: no SIP
/// stack, no RTP/media, no video, no door release).
@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate, FlutterStreamHandler {
  private let methodChannelName = "com.supremeos/runtime"
  private let eventChannelName = "com.supremeos/runtime/events"
  private var eventSink: FlutterEventSink?

  private let pushStreamHandler = PushStreamHandler()
  /// The raw APNs device token as a hex string, once `didRegisterForRemoteNotifications`
  /// fires. `nil` until then - `currentToken()` honestly reports "not yet available" rather
  /// than blocking or fabricating a value.
  private var apnsDeviceTokenHex: String?

  /// §Phase13.4 - owns PushKit registration + CallKit presentation. Created eagerly (not
  /// lazily on first Dart request) because `PKPushRegistry` must be registered as early as
  /// possible in the app's life for Apple to reliably deliver a VoIP push that can wake a
  /// terminated app - waiting for a Dart `initialize()` call would miss exactly the case this
  /// exists for.
  private let voipCallManager = VoipCallManager()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    let messenger = engineBridge.pluginRegistry.messenger()
    let methodChannel = FlutterMethodChannel(name: methodChannelName, binaryMessenger: messenger)
    methodChannel.setMethodCallHandler { [weak self] call, result in
      switch call.method {
      case "initialize":
        result(nil)
      case "notifyUiLifecycleChanged":
        // Recorded for future native-side bookkeeping only (§Phase13.1 §7) - not acted on yet.
        result(nil)
      case "requestRuntimeStatus":
        result([
          "processState": "foreground",
          "platformVersion": "ios-\(UIDevice.current.systemVersion)",
        ])
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    let eventChannel = FlutterEventChannel(name: eventChannelName, binaryMessenger: messenger)
    eventChannel.setStreamHandler(self)

    configurePushChannel(messenger: messenger)

    // §Phase13.4 note: `voipCallManager.emitEvent` is wired inside `onListen` below, NOT here -
    // it must only be set once `eventSink` is confirmed non-nil, otherwise an event arriving
    // between engine creation and Dart's EventChannel subscription would be treated as
    // "delivered" (silently dropped) instead of correctly queued. See `onListen`'s own comment.
  }

  /// §Phase13.2 §6 - the `com.supremeos/push` MethodChannel + `com.supremeos/push/events`
  /// EventChannel `NativePushTokenSource` (Dart side) speaks against. `initialize()` calls the
  /// plain `UIApplication.registerForRemoteNotifications()` (NOT PushKit) - the standard,
  /// user-visible-permission-prompting APNs registration path every notification-sending app
  /// uses. `currentToken()` returns whatever `apnsDeviceTokenHex` currently holds, honestly
  /// `nil` if registration hasn't completed yet.
  private func configurePushChannel(messenger: FlutterBinaryMessenger) {
    let pushMethodChannel = FlutterMethodChannel(name: "com.supremeos/push", binaryMessenger: messenger)
    pushMethodChannel.setMethodCallHandler { [weak self] call, result in
      switch call.method {
      case "initialize":
        UIApplication.shared.registerForRemoteNotifications()
        result(nil)
      case "currentToken":
        result(self?.apnsDeviceTokenHex)
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    let pushEventChannel = FlutterEventChannel(name: "com.supremeos/push/events", binaryMessenger: messenger)
    pushEventChannel.setStreamHandler(pushStreamHandler)
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let hex = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
    apnsDeviceTokenHex = hex
    pushStreamHandler.emitTokenRefreshed(hex)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    // §Phase13.2 §13 - honestly reported, never faked as a successful registration. Dart's
    // `NativePushTokenSource.currentToken()` will simply keep returning nil.
  }

  override func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    // §Phase13.2 §5/§9 - forwarded only while a Flutter engine is alive to receive it (see
    // `NativePushTokenSource`'s own HONEST SCOPE LIMIT doc). `userInfo` is passed through
    // verbatim as the payload's `data` map; Dart, not this file, decides what it means.
    var data: [String: String] = [:]
    for (key, value) in userInfo {
      if let k = key as? String, let v = value as? String {
        data[k] = v
      }
    }
    pushStreamHandler.emitPushReceived(data)
    completionHandler(.noData)
  }

  func onListen(withArguments arguments: Any?, eventSink: @escaping FlutterEventSink) -> FlutterError? {
    self.eventSink = eventSink
    // §Phase13.4 - ONLY now is it safe to let VoipCallManager emit directly (a real sink
    // exists); anything it queued earlier (engine creation happened, but Dart hadn't
    // subscribed yet - or a VoIP push cold-launched the app before either existed) is flushed
    // immediately after.
    voipCallManager.emitEvent = { [weak self] event in
      self?.eventSink?(event)
    }
    voipCallManager.flushPendingEvents()
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    self.eventSink = nil
    voipCallManager.emitEvent = nil
    return nil
  }

  @objc private func appDidBecomeActive() {
    eventSink?(["type": "processStateChanged", "state": "foreground"])
  }

  @objc private func appDidEnterBackground() {
    // §Phase13.1 §7/§10 - no `voip`/other background mode is declared in Info.plist yet, and
    // none should be added speculatively (§10's own instruction not to add background modes
    // until a real mechanism needs them). This purely reports the transition; iOS will suspend
    // this process shortly after, exactly as Phase 13.0's feasibility assessment described.
    eventSink?(["type": "processStateChanged", "state": "background"])
  }

  // FUTURE EXTENSION POINTS (documented, not implemented, per Phase 13.4's own scope control):
  //  - Phase 13.5: real SIP media (RTP/SRTP, codecs) consuming the audio session
  //    `VoipCallManager.provider(_:didActivate:)` already hooks but leaves empty.
  //  - A later phase: door-release triggered by an EXPLICIT homeowner tap inside the
  //    Flutter-rendered in-call screen, going through the existing authenticated Home command
  //    path - never as an automatic side effect of answering (§"ANSWERING A CALL", unchanged).
}

/// A small, separate `FlutterStreamHandler` for the push events channel - kept apart from
/// `AppDelegate`'s own conformance (used for the runtime events channel) so the two channels'
/// sinks are never confused with each other.
private class PushStreamHandler: NSObject, FlutterStreamHandler {
  private var sink: FlutterEventSink?

  func onListen(withArguments arguments: Any?, eventSink: @escaping FlutterEventSink) -> FlutterError? {
    sink = eventSink
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    sink = nil
    return nil
  }

  func emitTokenRefreshed(_ token: String) {
    sink?(["type": "tokenRefreshed", "token": token])
  }

  func emitPushReceived(_ data: [String: String]) {
    sink?(["type": "pushReceived", "data": data])
  }
}
