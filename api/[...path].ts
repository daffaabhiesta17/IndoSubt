import type { VercelRequest, VercelResponse } from '@vercel/node';
import { app } from '../src/app.js';

export default function handler(request: VercelRequest, response: VercelResponse): void {
  app(request, response);
}
