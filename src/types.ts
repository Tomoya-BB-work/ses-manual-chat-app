/** The AI binding is an AI Search INSTANCE, not a Workers AI model binding. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Narrow, documented contract used by this app; no generic model run() fallback. */
export interface ManualSearchBinding {
  chatCompletions(options: {
    messages: ChatMessage[];
    stream: true;
    ai_search_options: {
      retrieval: { max_num_results: number; metadata_only: false; return_on_failure: false };
      query_rewrite: { enabled: boolean };
      cache: { enabled: false };
    };
  }): Promise<ReadableStream<Uint8Array>>;
}

export interface Env {
  /** wrangler.jsonc: ai_search, AI -> gec-ses-manual (default namespace). */
  AI: ManualSearchBinding;
  ASSETS: { fetch(request: Request): Promise<Response> };
}
