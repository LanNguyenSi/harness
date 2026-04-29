export const EX_OK = 0;
export const EX_FAIL = 1;
export const EX_USAGE = 64;
export const EX_NOINPUT = 66;
export const EX_UNAVAILABLE = 69;
export const EX_SOFTWARE = 70;

export class HarnessExitError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
    this.name = "HarnessExitError";
  }
}
