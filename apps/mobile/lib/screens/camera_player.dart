import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';
import 'package:video_player/video_player.dart';

import '../providers.dart';

/// Live camera view (§11.1). RTSP isn't playable on a phone, so the app asks the hub
/// to resolve the camera's source into a browser/phone-playable **HLS** stream, then
/// plays it with `video_player`. The raw snapshot is shown while the stream warms up.
class CameraPlayerScreen extends ConsumerStatefulWidget {
  const CameraPlayerScreen({super.key, required this.camera});

  final Camera camera;

  @override
  ConsumerState<CameraPlayerScreen> createState() => _CameraPlayerScreenState();
}

class _CameraPlayerScreenState extends ConsumerState<CameraPlayerScreen> {
  VideoPlayerController? _controller;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final streams =
          await ref.read(clientProvider).cameraStream(widget.camera.id);
      // Prefer HLS (widely playable); video_player can't do WebRTC.
      CameraStream? hls;
      for (final s in streams) {
        if (s.kind == 'hls') {
          hls = s;
          break;
        }
      }
      if (hls == null) {
        setState(() {
          _error = 'No playable stream for this camera';
          _loading = false;
        });
        return;
      }
      final controller =
          VideoPlayerController.networkUrl(Uri.parse(hls.url));
      await controller.initialize();
      await controller.setLooping(true);
      await controller.play();
      if (!mounted) {
        await controller.dispose();
        return;
      }
      setState(() {
        _controller = controller;
        _loading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _loading = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.camera.name)),
      backgroundColor: Colors.black,
      body: Center(child: _body()),
    );
  }

  Widget _body() {
    final controller = _controller;
    if (controller != null && controller.value.isInitialized) {
      return AspectRatio(
        aspectRatio: controller.value.aspectRatio == 0
            ? 16 / 9
            : controller.value.aspectRatio,
        child: GestureDetector(
          onTap: () => setState(() {
            controller.value.isPlaying
                ? controller.pause()
                : controller.play();
          }),
          child: VideoPlayer(controller),
        ),
      );
    }
    // While loading (or on error) fall back to the latest snapshot if we have one.
    return Stack(
      alignment: Alignment.center,
      children: [
        if (widget.camera.snapshotUrl != null)
          Image.network(widget.camera.snapshotUrl!,
              fit: BoxFit.contain, errorBuilder: (_, __, ___) => const SizedBox()),
        if (_loading) const CircularProgressIndicator(),
        if (_error != null)
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
