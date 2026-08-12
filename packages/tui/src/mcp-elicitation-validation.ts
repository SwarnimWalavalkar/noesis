import type { TuiMcpFormField } from "./mcp-interaction.ts";

type TextField = Extract<TuiMcpFormField, { readonly type: "text" | "secret" }>;
type NumberField = Extract<TuiMcpFormField, { readonly type: "number" }>;
type MultiselectField = Extract<TuiMcpFormField, { readonly type: "multiselect" }>;

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validFormat(format: NonNullable<TextField["format"]>, value: string): boolean {
  if (format === "date") return validDate(value);
  if (format === "date-time") {
    const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/iu.exec(
      value,
    );
    if (!match || !validDate(value.slice(0, 10))) return false;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3]);
    const offsetHour = match[4] === undefined ? 0 : Number(match[4]);
    const offsetMinute = match[5] === undefined ? 0 : Number(match[5]);
    return hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59;
  }
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (!/^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/iu.test(value)) return false;
  if (/["<>\\^`{|}]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function validateMcpTextField(field: TextField, value: string): string | undefined {
  const length = [...value].length;
  if (field.minLength !== undefined && length < field.minLength)
    return `${field.label} must contain at least ${String(field.minLength)} characters.`;
  if (field.maxLength !== undefined && length > field.maxLength)
    return `${field.label} must contain at most ${String(field.maxLength)} characters.`;
  if (field.format && !validFormat(field.format, value))
    return `${field.label} must be a valid ${field.format}.`;
  return undefined;
}

export function validateMcpNumberField(field: NumberField, value: number): string | undefined {
  if (field.integer && !Number.isInteger(value)) return `${field.label} must be an integer.`;
  if (field.minimum !== undefined && value < field.minimum)
    return `${field.label} must be at least ${String(field.minimum)}.`;
  if (field.maximum !== undefined && value > field.maximum)
    return `${field.label} must be at most ${String(field.maximum)}.`;
  return undefined;
}

export function validateMcpMultiselectField(
  field: MultiselectField,
  selectedCount: number,
): string | undefined {
  const minimum = Math.max(field.required ? 1 : 0, field.minItems ?? 0);
  if (selectedCount < minimum)
    return `${field.label} requires at least ${String(minimum)} ${minimum === 1 ? "choice" : "choices"}.`;
  if (field.maxItems !== undefined && selectedCount > field.maxItems)
    return `${field.label} allows at most ${String(field.maxItems)} ${field.maxItems === 1 ? "choice" : "choices"}.`;
  return undefined;
}
