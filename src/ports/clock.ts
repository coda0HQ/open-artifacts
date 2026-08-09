export interface Clock {
  now(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements Clock {
  readonly #value: string;

  constructor(value: string) {
    if (Number.isNaN(Date.parse(value))) {
      throw new Error(`invalid fixed clock value: ${value}`);
    }
    this.#value = value;
  }

  now(): string {
    return this.#value;
  }
}
