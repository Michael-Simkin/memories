import type { Response } from 'express';

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
  };
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
): Response<ApiErrorPayload> {
  return res.status(status).json({
    error: {
      code,
      message,
    },
  });
}
