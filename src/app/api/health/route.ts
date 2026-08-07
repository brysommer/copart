import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const lots = await prisma.lot.count();
    return NextResponse.json({
      ok: true,
      service: "copart",
      db: "up",
      lots,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        service: "copart",
        db: "down",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 }
    );
  }
}
