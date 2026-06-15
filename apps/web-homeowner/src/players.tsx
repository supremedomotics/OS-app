import { useEffect, useRef } from "react";
import Hls from "hls.js";

/** HLS player — native on Safari, hls.js elsewhere. */
export function HlsPlayer({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return;
    }
    if (!Hls.isSupported()) {
      video.src = url;
      return;
    }
    const hls = new Hls({ lowLatencyMode: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    return () => hls.destroy();
  }, [url]);
  return <video ref={ref} className="player" controls autoPlay muted playsInline />;
}

/** Low-latency WebRTC player via WHEP; calls onError to fall back to HLS. */
export function WebRtcPlayer({ url, onError }: { url: string; onError: () => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    let cancelled = false;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => {
      if (e.streams[0]) video.srcObject = e.streams[0];
    };
    (async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", check);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
          setTimeout(resolve, 2000);
        });
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: pc.localDescription?.sdp ?? "",
        });
        if (!res.ok) throw new Error(`WHEP ${res.status}`);
        const answer = await res.text();
        if (!cancelled) await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
      pc.close();
    };
  }, [url, onError]);
  return <video ref={ref} className="player" autoPlay muted playsInline controls />;
}
