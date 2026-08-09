export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

export function fail(message) {
  throw new CliError(message);
}
