import { LotStatus, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const stuck = await prisma.lot.findMany({
  where: {
    OR: [
      { lotId: "64677306" },
      { status: { in: [LotStatus.DOWNLOADING, LotStatus.ANALYZING] } },
    ],
  },
  select: { lotId: true, status: true, updatedAt: true, error: true },
});
console.log("before", stuck);

const result = await prisma.lot.updateMany({
  where: { status: { in: [LotStatus.DOWNLOADING, LotStatus.ANALYZING] } },
  data: {
    status: LotStatus.FAILED,
    error: "Interrupted / stale job — reset so retry is allowed",
  },
});
console.log("reset count", result.count);

await prisma.$disconnect();
