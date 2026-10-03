export class ReduceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReduceError";
    this.code = code;
  }
}

export type ReduceResult =
  | { ok: true; state: import("./state").GameState }
  | { ok: false; error: ReduceError };

export function reject(code: string, message: string): ReduceResult {
  return { ok: false, error: new ReduceError(code, message) };
}
