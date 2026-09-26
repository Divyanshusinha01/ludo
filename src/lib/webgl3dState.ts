type Listener = () => void;

let disabled = false;
const listeners = new Set<Listener>();

/** True after any in-app WebGL canvas failed or lost its context. */
export function isWebGL3DDisabled(): boolean {
  return disabled;
}

/** Fall back to CSS dice + SVG tokens for the rest of the session. */
export function disableWebGL3D(): void {
  if (disabled) return;
  disabled = true;
  for (const listener of listeners) listener();
}

export function subscribeWebGL3D(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Attach once per R3F renderer; disables 3D if the context is missing or lost. */
export function bindWebGLFailure(gl: { domElement: HTMLCanvasElement; getContext: () => unknown }) {
  const canvas = gl.domElement;
  const onLost = (event: Event) => {
    event.preventDefault();
    disableWebGL3D();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  try {
    if (!gl.getContext()) disableWebGL3D();
  } catch {
    disableWebGL3D();
  }
}
