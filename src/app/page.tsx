import { DownloaderForm } from "@/components/downloader-form";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <section className="w-full max-w-xl rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur sm:p-8">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Media Downloader</h1>
          <p className="text-sm leading-6 text-slate-600 sm:text-base">
            Paste a media link, choose your format, and download.
          </p>
        </div>

        <div className="mt-8">
          <DownloaderForm />
        </div>
      </section>
    </main>
  );
}
