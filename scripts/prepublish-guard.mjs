// Runs first in `prepublishOnly`. Releasing is a deliberate act: it only proceeds with CRAWLMARK_PUBLISH_OK=1.
if (process.env.CRAWLMARK_PUBLISH_OK !== "1") {
  console.error("Refusing to release: set CRAWLMARK_PUBLISH_OK=1 to confirm (see 'Publishing' in README.md).");
  process.exit(1);
}
