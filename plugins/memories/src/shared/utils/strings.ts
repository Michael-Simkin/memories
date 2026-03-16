export function normalizeNonEmptyString(
  value: string | null | undefined,
): string | undefined {
  const trimmedValue = value?.trim();

  return trimmedValue && trimmedValue.length > 0 ? trimmedValue : undefined;
}

export function normalizeNullableString(
  value: string | null | undefined,
): string | null {
  return normalizeNonEmptyString(value) ?? null;
}
