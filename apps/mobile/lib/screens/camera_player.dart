import 'dart:async';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:supreme_sdk/supreme_sdk.dart';
import 'package:video_player/video_player.dart';

import '../providers.dart';

/// Live camera view (§11.1). RTSP isn't playable on a phone, so the hub resolves the
/// camera's source into low-latency **WebRTC** (preferred — sub-second, ideal for door
/// cameras) and **HLS**. This screen tries WebRTC via WHEP first and falls back to HLS
/// automatically; the snapshot is shown while a stream connects.
class CameraPlayerScreen extends ConsumerStatefulWidget {
  const CameraPlayerScreen({super.key, required this.camera});

  final Camera camera;

  @override
  ConsumerState<CameraPlayerScreen> createState() => _CameraPlayerScreenState();
}

enum _Mode { connecting, webrtc, hls, error }

class _CameraPlayerScreenState extends ConsumerState<CameraPlayerScreen> {
  final RTCVideoRenderer _renderer = RTCVideoRenderer();
  RTCPeerConnection? _pc;
  VideoPlayerController? _hls;
  _Mode _mode = _Mode.connecting;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      await _renderer.initialize();
      final streams =
          await ref.read(clientProvider).cameraStream(widget.camera.id);
      String? webrtc, hls;
      for (final s in streams) {
        if (s.kind == 'webrtc') webrtc = s.url;
        if (s.kind == 'hls') hls = s.url;
      }
      if (webrtc != null && await _startWebRtc(webrtc)) return;
      if (hls != null) {
        await _startHls(hls);
        return;
      }
      _fail('No playable stream for this camera');
    } catch (e) {
      _fail('$e');
    }
  }

  /// WHEP handshake: recvonly offer → POST SDP → apply answer. Returns false on failure
  /// so the caller falls back to HLS.
  Future<bool> _startWebRtc(String url) async {
    try {
      final pc = await createPeerConnection({
        'iceServers': [
          {'urls': 'stun:stun.l.google.com:19302'},
        ],
      });
      _pc = pc;
      pc.onTrack = (RTCTrackEvent e) {
        if (e.streams.isNotEmpty) {
          _renderer.srcObject = e.streams.first;
          if (mounted) setState(() => _mode = _Mode.webrtc);
        }
      };
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await _waitIceGathering(pc);
      final local = await pc.getLocalDescription();
      final res = await http.post(
        Uri.parse(url),
        headers: {'content-type': 'application/sdp'},
        body: local?.sdp ?? '',
      );
      if (res.statusCode >= 400) throw Exception('WHEP ${res.statusCode}');
      await pc.setRemoteDescription(RTCSessionDescription(res.body, 'answer'));
      return true;
    } catch (_) {
      await _pc?.close();
      _pc = null;
      return false;
    }
  }

  /// Non-trickle WHEP: wait for ICE gathering (bounded) so the offer carries candidates.
  Future<void> _waitIceGathering(RTCPeerConnection pc) async {
    final done = Completer<void>();
    pc.onIceGatheringState = (state) {
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete &&
          !done.isCompleted) {
        done.complete();
      }
    };
    await Future.any<void>([
      done.future,
      Future<void>.delayed(const Duration(seconds: 2)),
    ]);
  }

  Future<void> _startHls(String url) async {
    final c = VideoPlayerController.networkUrl(Uri.parse(url));
    await c.initialize();
    await c.setLooping(true);
    await c.play();
    if (!mounted) {
      await c.dispose();
      return;
    }
    setState(() {
      _hls = c;
      _mode = _Mode.hls;
    });
  }

  void _fail(String msg) {
    if (mounted) {
      setState(() {
        _error = msg;
        _mode = _Mode.error;
      });
    }
  }

  @override
  void dispose() {
    _pc?.close();
    _renderer.dispose();
    _hls?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.camera.name),
        actions: [
          if (_mode == _Mode.webrtc || _mode == _Mode.hls)
            Padding(
              padding: const EdgeInsets.only(right: AureonSpacing.md),
              child: Center(
                child: Text(
                  _mode == _Mode.webrtc ? 'WebRTC · live' : 'HLS',
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                ),
              ),
            ),
        ],
      ),
      backgroundColor: Colors.black,
      body: Center(child: _body()),
    );
  }

  Widget _body() {
    if (_mode == _Mode.webrtc) {
      return RTCVideoView(_renderer,
          objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain);
    }
    final hls = _hls;
    if (_mode == _Mode.hls && hls != null && hls.value.isInitialized) {
      return AspectRatio(
        aspectRatio:
            hls.value.aspectRatio == 0 ? 16 / 9 : hls.value.aspectRatio,
        child: GestureDetector(
          onTap: () => setState(() =>
              hls.value.isPlaying ? hls.pause() : hls.play()),
          child: VideoPlayer(hls),
        ),
      );
    }
    // Connecting / error → show the snapshot under a spinner or message.
    return Stack(
      alignment: Alignment.center,
      children: [
        if (widget.camera.snapshotUrl != null)
          Image.network(widget.camera.snapshotUrl!,
              fit: BoxFit.contain,
              errorBuilder: (_, __, ___) => const SizedBox()),
        if (_mode == _Mode.connecting) const CircularProgressIndicator(),
        if (_mode == _Mode.error)
          Padding(
            padding: const EdgeInsets.all(AureonSpacing.lg),
            child: Text('Could not start live view\n$_error',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70)),
          ),
      ],
    );
  }
}
