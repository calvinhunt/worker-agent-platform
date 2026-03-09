import { NextResponse } from "next/server";

import { listTaskArtifacts } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  const artifacts = await listTaskArtifacts(taskId);
  return NextResponse.json(artifacts);
}
