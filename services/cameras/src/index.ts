/**
 * @supreme/cameras — camera streaming support (§11.1). Resolves a camera's RTSP source
 * into client-playable HLS/WebRTC URLs via the hub's stream engine (go2rtc/MediaMTX),
 * so clients never receive a raw rtsp:// URI they can't open.
 */
export {
  type StreamKind,
  type StreamEngine,
  type CameraStream,
  type ICameraStreamGateway,
  type StreamGatewayOptions,
  StreamGateway,
  NullStreamGateway,
  playableUrls,
} from "./stream-gateway.js";
