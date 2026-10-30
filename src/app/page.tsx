import { DownloaderForm } from "@/components/downloader-form";

export default function HomePage() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-4 py-10 sm:px-6">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200/80 bg-white/95 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Media Downloader</h1>

        <div className="mt-6 sm:mt-8">
          <DownloaderForm />
        </div>
      </section>
    </main>
  );
}
