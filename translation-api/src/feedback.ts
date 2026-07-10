import { Request, Response } from "express";
import { query } from "./db";

export async function feedbackHandler(req: Request, res: Response): Promise<void> {
  if (!req.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { requestId, rating, comment } = req.body as {
    requestId?: string;
    rating?: number;
    comment?: string;
  };

  if (!requestId || rating === undefined) {
    res.status(400).json({ error: "requestId and rating are required" });
    return;
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: "rating must be an integer between 1 and 5" });
    return;
  }

  const usage = await query<{ id: string }>(
    `SELECT id FROM usage_records
     WHERE request_id = $1 AND user_id = $2
     LIMIT 1`,
    [requestId, req.apiKey.userId]
  );

  if (!usage.rows[0]) {
    res.status(404).json({ error: "Request not found for this API key" });
    return;
  }

  await query(
    `INSERT INTO translation_feedback (request_id, user_id, api_key_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id, user_id) DO UPDATE
       SET rating = EXCLUDED.rating,
           comment = EXCLUDED.comment,
           created_at = NOW()`,
    [
      requestId,
      req.apiKey.userId,
      req.apiKey.keyId,
      rating,
      comment?.trim() || null,
    ]
  );

  res.status(201).json({
    message: "Feedback recorded",
    requestId,
    rating,
  });
}
