export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown[];
  target?: string;
  /** codice numerico AADSTS per gli errori OAuth */
  aadsts?: number;
  headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, extra: Partial<Pick<HttpError, 'details' | 'target' | 'aadsts' | 'headers'>> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);

export function oauthError(status: number, error: string, aadsts: number, description: string): HttpError {
  return new HttpError(status, error, `AADSTS${aadsts}: ${description}`, { aadsts });
}
