# Grounded RAG and camera client contract

Status: implemented source contract with byte-level upload privacy; physical camera acceptance remains open.

This contract defines parity as the same user-visible safety outcome, not identical platform APIs.
Both clients must keep Grounded RAG optional, preserve manual task editing when AI is unavailable,
and require an explicit preview before AI-derived text or OCR-derived tasks change user data.

## Supported behavior

| Capability | Web | Mobile |
| --- | --- | --- |
| Grounded question | `POST /v2/knowledge/answer` in the task-assistance surface | The same endpoint and language contract in the task-assistance modal |
| Answer | Render only a validated grounded answer with its inert citations | Render only a validated grounded answer with its inert citations |
| No answer | Show an explicit insufficient-evidence state without a quadrant or invented source | Same user-visible outcome |
| Cancellation | Abort the in-flight HTTP request and keep the task unchanged | Abort the in-flight HTTP request and keep the task unchanged |
| Apply | Editable description preview followed by explicit confirmation | Editable description preview followed by explicit confirmation |
| Gallery | File picker remains available independently of camera capture | Media-library picker remains available independently of camera capture |
| Camera | A dedicated rear-camera file input where the browser/platform supports `capture` | Expo camera permission followed by an explicit camera picker |
| OCR persistence | Review and edit extracted tasks before importing selected items | Review the selected image, then review and edit extracted tasks before importing selected items |

## Privacy, permission and failure boundaries

- Camera access is user initiated. Mobile asks for camera permission only after the camera action;
  web delegates permission and capture behavior to the browser and operating system.
- Mobile requests images without EXIF metadata, re-encodes the reviewed asset into a temporary JPEG,
  removes EXIF/XMP, IPTC and comment segments from the bytes, uploads only that sanitized file and
  deletes it after success or failure. It does not create or upload the temporary file while offline.
- The web removes EXIF/XMP, IPTC and comment segments from JPEG uploads and EXIF/text chunks from PNG
  uploads before the request. Unsupported image encodings fail closed instead of sending original
  bytes, including image bytes mislabeled as text; validated plain-text task imports remain
  unchanged. The service contract grants no durable-media
  retention.
- Denied mobile permission is a typed, retryable state. Cancelling either picker is not an error and
  does not start OCR.
- A selected mobile image is shown before upload and can be discarded. OCR output on both clients is
  separately reviewed before any task mutation.
- Network, AI capability, OCR and apply failures leave the existing task data unchanged and preserve
  the nearest useful preview for retry where possible.
- Citation titles and excerpts are rendered as text. Clients never execute source markup or expose
  internal source URIs as navigation targets.

## Acceptance evidence

Automated source acceptance requires byte-fixture sanitizer tests, client unit tests, type
checks/builds and accessibility checks for the reachable browser/modal flows. Mocked pickers prove
permission and state handling only; the Android release build proves native module integration but
not real camera behavior.

Physical acceptance is deliberately separate:

1. Android and iOS must each demonstrate a real permission prompt, denial/retry, rear-camera capture,
   preview/discard, upload, OCR review and import on supported hardware.
2. A supported mobile browser must demonstrate that the web camera action opens capture rather than
   only a generic file picker, plus cancellation and subsequent gallery selection.
3. Offline capture must leave the image local and recover after reconnection without an automatic
   upload.
4. Accessibility must be checked with the platform screen reader and large text, independently from
   viewport emulation.

Until those checks are recorded, TASK-028 may claim implemented and automated client parity, but not
physical camera completion.
