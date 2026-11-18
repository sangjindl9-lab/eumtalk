import { bad } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function uuid(v: unknown, field: string): string {
  if (!isUuid(v)) throw bad('INVALID_INPUT', `${field} 값이 올바르지 않습니다.`);
  return v.toLowerCase();
}

export function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw bad('INVALID_INPUT', `${field}을(를) 입력해 주세요.`);
  const t = v.trim();
  const len = [...t].length;
  if (len < min || len > max) {
    throw bad('INVALID_INPUT', min === max ? `${field}은(는) ${min}자여야 합니다.` : `${field}은(는) ${min}~${max}자로 입력해 주세요.`);
  }
  return t;
}

export function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function intIn(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 수락 전 인사말에는 외부 링크·연락처 유도를 넣을 수 없다. */
const LINK = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|kr|org|io|me|co|xyz|app|link|ly|gg|tv)(\b|\/))/i;
export const containsLink = (text: string) => LINK.test(text);
