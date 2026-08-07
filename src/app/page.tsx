import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function Home() {
  let lots: Array<{
    lotId: string;
    vin: string | null;
    status: string;
    updatedAt: Date;
  }> = [];
  let dbError: string | null = null;

  try {
    lots = await prisma.lot.findMany({
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        lotId: true,
        vin: true,
        status: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Copart Bot</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Telegram-бот аналізує лоти Copart: VIN з фото + оцінка ремонту/ризиків.
        Health: <a className="underline" href="/api/health">/api/health</a>
      </p>

      {dbError ? (
        <p className="mt-8 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          DB: {dbError}
        </p>
      ) : (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Останні лоти</h2>
          {lots.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Поки немає записів.</p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-200 border border-zinc-200">
              {lots.map((lot) => (
                <li
                  key={lot.lotId}
                  className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="font-mono">{lot.lotId}</span>
                  <span className="font-mono text-zinc-700">
                    {lot.vin ?? "—"}
                  </span>
                  <span className="text-zinc-500">{lot.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
