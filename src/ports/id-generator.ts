import { generateId } from "../tokens";

export interface IdGenerator {
  next(prefix?: string): string;
}

const withPrefix = (value: string, prefix?: string): string =>
  prefix ? `${prefix}_${value}` : value;

export class CryptoIdGenerator implements IdGenerator {
  next(prefix?: string): string {
    return withPrefix(generateId(), prefix);
  }
}

export class SequenceIdGenerator implements IdGenerator {
  #index = 0;

  constructor(private readonly values: readonly string[]) {}

  next(prefix?: string): string {
    const value = this.values[this.#index];
    if (value === undefined) throw new Error("ID sequence exhausted");
    this.#index += 1;
    return withPrefix(value, prefix);
  }
}
