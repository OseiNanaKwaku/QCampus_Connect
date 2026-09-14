import { ConvexError } from 'convex/values';

const CONVEX_ERROR_SYMBOL = Symbol.for('ConvexError');

function isConvexThrownError(error: unknown): boolean {
  if (error instanceof ConvexError) {
    return true;
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[CONVEX_ERROR_SYMBOL] === true
  );
}

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
}

/** Reads a structured Convex application error code when the backend throws ConvexError. */
export function getConvexErrorCode(error: unknown): string {
  if (!isConvexThrownError(error)) {
    return '';
  }

  const convexError = error as ConvexError<string | { code?: string }>;

  if (typeof convexError.data === 'string') {
    return convexError.data;
  }

  if (convexError.data && typeof convexError.data === 'object' && 'code' in convexError.data) {
    const code = convexError.data.code;
    return typeof code === 'string' ? code : '';
  }

  return '';
}

export function toErrorText(error: unknown): string {
  if (isConvexThrownError(error)) {
    const convexError = error as ConvexError<string | { message?: string }>;
    if (typeof convexError.data === 'string') {
      return convexError.data.toLowerCase();
    }
    if (
      convexError.data &&
      typeof convexError.data === 'object' &&
      'message' in convexError.data &&
      typeof (convexError.data as { message?: unknown }).message === 'string'
    ) {
      return ((convexError.data as { message: string }).message).toLowerCase();
    }
  }

  const raw = extractRawMessage(error);
  if (!raw) {
    return '';
  }

  let text = raw;

  // 1. Strip Convex action/mutation caller prefixes like "[CONVEX A(qchat:registerUserWithRecaptcha)] "
  text = text.replace(/^\[CONVEX\s+[A-Z]\([^)]+\)\]\s*/i, '');

  // 1b. Strip Convex request-ID prefixes like "[Request ID: abc123] Server Error"
  text = text.replace(/^\[request\s+id:[^\]]+\]\s*(server\s+error[:\s]*)*/i, '').trim();

  // 2. Strip repeated "Uncaught Error:" prefixes
  while (/^uncaught\s+error:\s*/i.test(text)) {
    text = text.replace(/^uncaught\s+error:\s*/i, '').trim();
  }

  // 3. Strip stack traces: " at handler (...)" or "\n at ..."
  const atIndex = text.search(/\s+at\s+([a-zA-Z0-9_$<>]+|\()/);
  if (atIndex !== -1) {
    text = text.slice(0, atIndex).trim();
  }

  const newlineIndex = text.indexOf('\n');
  if (newlineIndex !== -1) {
    text = text.slice(0, newlineIndex).trim();
  }

  const cleaned = text.trim().toLowerCase();
  if (cleaned.startsWith('called by client') || cleaned === 'called by client') {
    return '';
  }

  return cleaned;
}

export function isNetworkError(error: unknown): boolean {
  const errorText = toErrorText(error);
  return (
    errorText.includes('failed to fetch') ||
    errorText.includes('networkerror') ||
    errorText.includes('network error') ||
    errorText.includes('load failed')
  );
}
