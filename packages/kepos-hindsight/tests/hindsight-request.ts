type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export async function hindsightRequest(input: FetchInput, init?: FetchInit): Promise<{
  url: string;
  body: Record<string, unknown>;
}> {
  const request = input instanceof Request ? input : new Request(input, init);
  return {
    url: request.url,
    body: JSON.parse(await request.text()) as Record<string, unknown>
  };
}

export function hindsightJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }
  });
}
