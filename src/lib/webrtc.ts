/**
 * ICE servers for DIY WebRTC voice.
 *
 * Public STUN only by default — peers on the same Wi-Fi/network connect
 * reliably. Strict cellular/corporate NATs may fail without a TURN relay.
 * Optional TURN via NEXT_PUBLIC_TURN_* env vars (no paid service bundled).
 */
export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
  ];

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }

  return servers;
}
