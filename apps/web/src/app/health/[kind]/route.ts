import { assertSchema } from "@getexception/db";
import { getRuntime } from "../../../server/runtime";
import { json } from "../../../server/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ kind: string }> },
) {
  const { kind } = await context.params;

  if (kind === "live") {
    return json({ ok: true });
  }

  if (kind !== "ready") {
    return json({ ok: false }, 404);
  }

  try {
    await assertSchema(getRuntime().db);

    return json({ ok: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
