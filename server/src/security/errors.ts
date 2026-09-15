export class AppError extends Error {
  constructor(public code: string, public statusCode = 400, message = code) { super(message); }
}
