function normalizeNonEmptyString(value) {
  const trimmedValue = value?.trim();
  return trimmedValue && trimmedValue.length > 0 ? trimmedValue : void 0;
}
function normalizeNullableString(value) {
  return normalizeNonEmptyString(value) ?? null;
}
export {
  normalizeNonEmptyString,
  normalizeNullableString
};
