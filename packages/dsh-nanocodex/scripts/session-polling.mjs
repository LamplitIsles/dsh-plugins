const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Wait for the durable assistant event that follows a provider response.
 * A durable reply can precede driver cleanup; compaction also requires idle.
 */
export async function waitForFinalizedAssistant({
  loadPage,
  isIdle,
  expectedText,
  timeoutMs = 10_000,
  intervalMs = 20,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const page = await loadPage();
    if (
      page.records?.some(
        (record) =>
          record.event?.type === "assistant/message" &&
          JSON.stringify(record.event).includes(expectedText),
      )
    ) {
      if (await isIdle()) return page;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out waiting for idle after finalized assistant message ${JSON.stringify(expectedText)}`,
  );
}
