/**
 * Official platform provider registry.
 *
 * Platform pages are not direct media URLs. Providers expose metadata and
 * download capabilities independently. A provider may only enable downloads
 * when a documented, authorized API explicitly grants access to media bytes.
 *
 * Keep platform-specific API clients behind this registry so source handlers
 * and API routes do not accumulate provider-specific conditionals.
 */
import {
  fetchYouTubeMetadata,
  youTubeCapability,
  type YouTubeMetadata,
} from "@/lib/platform";
import { MESSAGES } from "@/lib/sources";

export type PlatformName = "youtube";

export type PlatformMetadata = YouTubeMetadata;

export type PlatformProviderContext = {
  videoId: string;
  signal: AbortSignal;
};

export type PlatformProvider = {
  name: PlatformName;
  label: string;
  metadataCapability: () => { supported: boolean; reason: string | null };
  downloadCapability: () => { supported: boolean; reason: string | null };
  fetchMetadata: (context: PlatformProviderContext) => Promise<PlatformMetadata>;
};

const youtubeProvider: PlatformProvider = {
  name: "youtube",
  label: "YouTube video",
  metadataCapability: () => {
    const capability = youTubeCapability();
    return { supported: capability.supported, reason: capability.reason };
  },
  // YouTube's documented Data API and oEmbed endpoints return metadata, not
  // downloadable media streams. Keep this disabled until an authorized
  // provider contract explicitly permits media-byte access.
  downloadCapability: () => ({
    supported: false,
    reason: MESSAGES.platformDownloadNotSupported,
  }),
  fetchMetadata: ({ videoId, signal }) => fetchYouTubeMetadata(videoId, signal),
};

const PROVIDERS: Record<PlatformName, PlatformProvider> = {
  youtube: youtubeProvider,
};

export function getPlatformProvider(name: PlatformName): PlatformProvider {
  return PROVIDERS[name];
}

export type PlatformProviderSummary = {
  name: PlatformName;
  label: string;
  capabilities: {
    metadata: { supported: boolean; reason: string | null };
    download: { supported: boolean; reason: string | null };
  };
};

export function listPlatformProviders(): PlatformProviderSummary[] {
  return Object.values(PROVIDERS).map((provider) => ({
    name: provider.name,
    label: provider.label,
    capabilities: {
      metadata: provider.metadataCapability(),
      download: provider.downloadCapability(),
    },
  }));
}
