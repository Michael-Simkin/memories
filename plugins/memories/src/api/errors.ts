import type { Response } from 'express';

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
  };
}

export function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
): Response<ApiErrorPayload> {
  return response.status(status).json({
    error: {
      code,
      message,
    },
  });
}
