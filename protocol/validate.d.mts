export interface ProtocolValidation {
  ok: boolean;
  errors: string[];
}

export function validateProtocolValue(
  value: unknown,
  schema: Record<string, unknown>,
): ProtocolValidation;

export function assertProtocolValue<T>(
  value: T,
  schema: Record<string, unknown>,
): T;
