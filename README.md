# Media Downloader

A minimal, production-minded media downloader built with Next.js, TypeScript, and Tailwind CSS. Users can paste an authorized public media URL, choose MP4 video or MP3 audio, and download the file through a secure backend route.

## Overview

This project intentionally keeps the interface small and focused:

- Application heading
- URL text area
- Format selector
- One download button
- Small status message

The backend validates URLs, blocks unsafe destinations, restricts downloads to explicitly supported public sources, enforces file-size limits and request timeouts, and returns the downloaded media as a file attachment.

## Important limitation

This implementation supports **authorized direct public media URLs** from a small allowlist of sample/demo hosts. It does **not** bypass platform restrictions, DRM, authentication, paywalls, or site terms. It is designed for safe, permitted downloads only.

Currently supported hosts:

- `samplelib.com`
- `www.samplelib.com`
- `file-examples.com`
- `www.file-examples.com`
- `sample-videos.com`
- `www.sample-videos.com`

If you need additional supported public sources, update the allowlist in `src/lib/download-validation.ts` only after verifying legal and technical permission.

## Tech stack

- Frontend: Next.js App Router, React, TypeScript, Tailwind CSS
- Backend: Next.js Route Handlers running on Node.js
- Testing: Node test runner for backend validation tests

## Prerequisites

- Node.js 20+
- npm 10+
- Windows PowerShell or Command Prompt

## Environment variables

Create a `.env.local` file in the project root if needed:

```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

No secret keys are required for the base implementation.

## Install dependencies

From the project root:

```powershell
npm install
```

## Run locally on Windows

### Development server

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

### Production build check

```powershell
npm run build
npm run start
```

## Available API endpoints

### GET `/api/health`

Response:

```json
{
  "status": "ok"
}
```

### POST `/api/download`

Request body:

```json
{
  "url": "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
  "format": "mp4"
}
```

Supported formats:

- `mp4`
- `mp3`

Behavior:

1. Validates the URL.
2. Restricts requests to supported public hosts.
3. Resolves DNS and blocks loopback/private-network targets.
4. Fetches the media with timeout and redirect checks.
5. Enforces a maximum file size.
6. Returns a downloadable file response.
7. Cleans temporary files after response preparation.

Possible error messages:

- `Please paste a media URL.`
- `Please enter a valid URL.`
- `This media source is not supported.`
- `The media could not be accessed.`
- `The requested MP4 video is not available.`
- `The requested MP3 audio is not available.`
- `Download failed. Please try again.`
- `The media file is too large.`

## Supported source limitations

This project intentionally does **not** support:

- Authenticated/private media URLs
- DRM-protected streams
- Paywalled content
- Arbitrary user-supplied hosts
- Internal network targets
- Local files
- Platform-specific extraction workarounds

For safe operation, support is limited to direct downloadable public media URLs from approved hosts.

## Security controls

Implemented protections include:

- Empty-input validation
- HTTP/HTTPS-only URL validation
- Host allowlist
- DNS resolution checks
- Loopback and private-network blocking
- Redirect validation
- Request timeout
- File-size limit
- Temporary-file cleanup
- No exposure of internal server paths or stack traces

## Testing

Run:

```powershell
npm test
```

Current automated tests cover backend validation behavior for:

- Empty URLs
- Invalid URLs
- Unsupported schemes
- Unsupported hosts
- Valid supported URLs

Manual verification checklist:

1. Start the app with `npm run dev`.
2. Visit `http://localhost:3000`.
3. Confirm the layout works at 320px, 375px, 768px, 1366px, and 1920px widths.
4. Confirm no horizontal scrolling on mobile widths.
5. Confirm the Download button shows a loading state.
6. Confirm empty URLs show `Please paste a media URL.`
7. Confirm malformed URLs show `Please enter a valid URL.`
8. Confirm unsupported hosts show `This media source is not supported.`
9. Confirm `/api/health` returns `{ "status": "ok" }`.
10. Test a permitted direct media URL and verify the browser downloads the expected `.mp4` or `.mp3` file.

Do not claim real downloads were verified unless you tested a permitted sample URL in your environment.

## Production deployment guidance

For production:

1. Deploy the Next.js app to a Node.js-capable environment.
2. Ensure outbound internet access is restricted according to your security policy.
3. Review and maintain the source allowlist.
4. Set infrastructure-level request limits and logging.
5. Run behind HTTPS.
6. Keep temporary storage writable and monitored.
7. Consider additional malware/content scanning if business requirements demand it.

## Troubleshooting

### Download fails immediately

- Check that the URL is a direct public media file.
- Check that the host is in the allowlist.
- Check that the resource is publicly accessible.

### Source unsupported

- The host is not allowlisted or a redirect target is not allowed.

### File too large

- The backend enforces a size limit for reliability and safety.

### Wrong format selected

- MP4 expects a direct video resource.
- MP3 expects a direct audio resource.

### Build issues

- Confirm you are using a supported Node.js version.
- Delete `.next` and reinstall dependencies if needed:

```powershell
Remove-Item -Recurse -Force .next
Remove-Item -Recurse -Force node_modules
npm install
```
